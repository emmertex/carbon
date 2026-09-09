#!/bin/bash
# Carbon API examples
#
# Demonstrates: authentication, task creation/listing, API key creation/listing, errors
#
# Prerequisites:
#   - A running Carbon server at CARBON_URL (default: http://localhost:8080)
#   - A user account with username and password
#
# Usage:
#   CARBON_URL=http://localhost:8080 \
#   CARBON_USER=alice CARBON_PASS=secret \
#   ./test.sh

set -e

CARBON_URL="${CARBON_URL:-http://localhost:8080}"
CARBON_USER="${CARBON_USER:-alice}"
CARBON_PASS="${CARBON_PASS:-secret}"

echo "=== Carbon API Examples ==="
echo "Server: $CARBON_URL"
echo ""

# --- 1. Authenticate (start MFA flow) ---
echo "1. Signing in..."
BASIC=$(printf '%s:%s' "$CARBON_USER" "$CARBON_PASS" | base64)
SIGNIN_RESPONSE=$(curl -s -w '\n%{http_code}' \
  -X POST "$CARBON_URL/api/login" \
  -H "Authorization: Basic $BASIC" \
  -H "Content-Type: application/json" \
  -d '{"device_id":"test-device","device_name":"API Example"}')
HTTP_CODE=$(echo "$SIGNIN_RESPONSE" | tail -n 1)
BODY=$(echo "$SIGNIN_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"token"'; then
  # Got session token directly (device trusted)
  SESSION_TOKEN=$(echo "$BODY" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
  echo "   Got session token (device trusted)"
elif [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"status"'; then
  echo "   MFA required (would need to complete 2FA flow in real usage)"
  SESSION_TOKEN=""
else
  echo "   Sign-in failed: $HTTP_CODE"
  echo "$BODY"
fi

# Key management requires a human session; a challenge token is not sufficient.
if [ -z "${SESSION_TOKEN:-}" ]; then
  echo "Complete MFA in the app before running authenticated examples."
  exit 1
fi
TOKEN="$SESSION_TOKEN"
AUTH_HEADER="Authorization: Bearer $TOKEN"

# --- 2. List tasks (with pagination) ---
echo ""
echo "2. Listing tasks (with pagination)..."
echo "   GET /api/tasks?limit=50&cursor=0"
curl -s -w '\n%{http_code}\n' \
  -G "$CARBON_URL/api/tasks" \
  -H "$AUTH_HEADER" \
  --data-urlencode "perspective=inbox" \
  --data-urlencode "limit=50" \
  --data-urlencode "cursor=0"

# --- 3. Create a task ---
echo ""
echo "3. Creating a task..."
echo "   POST /api/tasks"
curl -s -w '\n%{http_code}\n' \
  -X POST "$CARBON_URL/api/tasks" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"title":"Buy milk","due_date":"2026-09-10T00:00:00Z"}'

# --- 4. Create a personal read-only key (requires human session) ---
echo ""
echo "4. Creating a read-only API key..."
echo "   POST /api/keys"
curl -s -w '\n%{http_code}\n' \
  -X POST "$CARBON_URL/api/keys" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"name":"read-only-key","scopes":["tasks:read"],"projectIds":null,"expiresAt":null}'

# --- 5. List API keys ---
echo ""
echo "5. Listing API keys..."
echo "   GET /api/keys"
curl -s -w '\n%{http_code}\n' \
  "$CARBON_URL/api/keys" \
  -H "$AUTH_HEADER"

# --- 6. Error handling (404) ---
echo ""
echo "6. Error handling (non-existent task)..."
echo "   GET /api/tasks/nonexistent-id"
curl -s -w '\n%{http_code}\n' \
  "$CARBON_URL/api/tasks/nonexistent-id" \
  -H "$AUTH_HEADER"

# --- 7. Error handling (401 unauthorized) ---
echo ""
echo "7. Error handling (no authentication)..."
echo "   GET /api/tasks (no auth)"
curl -s -w '\n%{http_code}\n' \
  "$CARBON_URL/api/tasks"

echo ""
echo "=== Examples Complete ==="
