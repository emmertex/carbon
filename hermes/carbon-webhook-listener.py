#!/usr/bin/env python3
"""
Carbon Agent webhook listener.

Receives task triggers from Carbon (mention / assigned / test) on a local
HTTP port and writes them to a queue file. A Hermes cron job or agent
session picks up queued items, does the work via the Carbon REST API,
and posts comments / completes tasks.

Environment variables:
    CARBON_URL      base URL, e.g. https://carbon.etx.sx
    CARBON_TOKEN    agent API token (Bearer auth for REST calls)
    CARBON_SECRET   shared secret for webhook verification (optional)
    CARBON_PORT     listen port (default 9192)
    CARBON_QUEUE    queue file path (default ~/.hermes/carbon-queue.jsonl)
"""

import hmac
import json
import http.server
import os
import sys
import datetime
import urllib.request
import urllib.error
import urllib.parse

PORT = int(os.environ.get("CARBON_PORT", 9192))
# Bind to loopback by default; set CARBON_HOST=0.0.0.0 to expose on the LAN
# (only do so with CARBON_SECRET set — enforced at startup below).
HOST = os.environ.get("CARBON_HOST", "127.0.0.1")
CARBON_URL = os.environ.get("CARBON_URL", "https://carbon.etx.sx").rstrip("/")
CARBON_TOKEN = os.environ.get("CARBON_TOKEN", "")
CARBON_SECRET = os.environ.get("CARBON_SECRET", "")
# Reject request bodies larger than this (anti-DoS); webhook payloads are small.
MAX_BODY_BYTES = int(os.environ.get("CARBON_MAX_BODY", 256 * 1024))
QUEUE_FILE = os.path.expanduser(
    os.environ.get("CARBON_QUEUE", "~/.hermes/carbon-queue.jsonl")
)
# A bind address is loopback-only when it's localhost or unspecified-but-host-local.
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


# ── Carbon REST helpers ──────────────────────────────────────────────


def _api(method, path, data=None):
    url = f"{CARBON_URL}{path}"
    body = json.dumps(data).encode() if data is not None else None
    headers = {
        "Authorization": f"Bearer {CARBON_TOKEN}",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": True, "status": e.code, "body": e.read().decode(errors="replace")}
    except Exception as exc:
        return {"error": True, "message": str(exc)}


def comment(task_id, body):
    return _api("POST", f"/api/tasks/{task_id}/comments", {"body": body})


def complete(task_id, done=True):
    return _api("POST", f"/api/tasks/{task_id}/complete?done={str(done).lower()}")


def read_task(task_id):
    return _api("GET", f"/api/tasks/{task_id}")


def list_tasks(perspective=None, status=None, project=None):
    params = []
    if perspective:
        params.append(f"perspective={perspective}")
    if status:
        params.append(f"status={status}")
    if project:
        params.append(f"project={project}")
    qs = "?" + "&".join(params) if params else ""
    return _api("GET", f"/api/tasks{qs}")


def create_task(title, **kw):
    data = {"title": title, "flagged": kw.get("flagged", False),
            "priority": kw.get("priority", 2)}
    for key in ("note", "project_id", "due_date"):
        if key in kw and kw[key] is not None:
            data[key] = kw[key]
    return _api("POST", "/api/tasks", data)


def update_task(task_id, **kw):
    return _api("PATCH", f"/api/tasks/{task_id}", kw)


def me():
    return _api("GET", "/api/me")


# ── Natural-language agent API (/api/agent/*) ─────────────────────────────
# Granular, context-small primitives a small LLM composes for NL task management.
# The server does the fuzzy matching, so pass plain names (never ids).


def _qs(**params):
    parts = [f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items() if v is not None]
    return "?" + "&".join(parts) if parts else ""


def agent_lists(detail=False):
    return _api("GET", f"/api/agent/lists{_qs(detail=1 if detail else None)}")


def agent_tags(detail=False):
    return _api("GET", f"/api/agent/tags{_qs(detail=1 if detail else None)}")


def agent_items(list=None, tag=None, q=None, status=None, detail=False):
    return _api(
        "GET",
        f"/api/agent/items{_qs(list=list, tag=tag, q=q, status=status, detail=1 if detail else None)}",
    )


def agent_item(item_id):
    return _api("GET", f"/api/agent/items/{item_id}")


def agent_resolve(kind, q, list=None, limit=None):
    """kind: 'list' | 'tag' | 'task'. Returns {candidates, best:{id,confident}}."""
    return _api("POST", "/api/agent/resolve", {"kind": kind, "q": q, "list": list, "limit": limit})


def agent_add(list=None, titles=None, tags=None, tasks=None,
              create_list_if_missing=True, create_tags_if_missing=True):
    """Batch-create tasks. Pass titles=[...] or tasks=[{title,...}]."""
    body = {
        "list": list,
        "titles": titles,
        "tasks": tasks,
        "tags": tags,
        "create_list_if_missing": create_list_if_missing,
        "create_tags_if_missing": create_tags_if_missing,
    }
    return _api("POST", "/api/agent/tasks/batch", {k: v for k, v in body.items() if v is not None})


def agent_complete(queries=None, ids=None, done=True, list=None, tag=None):
    """Complete/uncomplete tasks. Returns {matched:[...], unmatched:[{query,reason}]}."""
    body = {"queries": queries, "ids": ids, "done": done, "list": list, "tag": tag}
    return _api("POST", "/api/agent/tasks/complete", {k: v for k, v in body.items() if v is not None})


def agent_update(updates):
    """updates=[{id|query, list?, tag?, patch:{...}}]. Returns matched/unmatched."""
    return _api("POST", "/api/agent/tasks/update", {"updates": updates})


def agent_set_tag_geo(tag, geo=None, near_name=None, near=None, create_if_missing=False):
    """Set a tag's geofence. geo={lat,lng,radius,label} OR near_name+near={lat,lng}."""
    body = {"tag": tag, "geo": geo, "near_name": near_name, "near": near,
            "create_if_missing": create_if_missing}
    return _api("POST", "/api/agent/tags/geo", {k: v for k, v in body.items() if v is not None})


def agent_nearby(tag=None, zone=None, lat=None, lng=None, near_name=None):
    return _api("GET", f"/api/agent/nearby{_qs(tag=tag, zone=zone, lat=lat, lng=lng, near_name=near_name)}")


# ── Webhook HTTP server ──────────────────────────────────────────────


def enqueue(payload):
    os.makedirs(os.path.dirname(QUEUE_FILE), exist_ok=True)
    task = payload.get("task") or {}
    record = {
        "queued_at": datetime.datetime.now().isoformat(),
        "event": payload.get("event"),
        "agent": payload.get("agent"),
        "instructions": payload.get("instructions", ""),
        "task_id": task.get("id"),
        "title": task.get("title"),
        "task": task,
        "comments": payload.get("comments", []),
    }
    with open(QUEUE_FILE, "a") as fh:
        json.dump(record, fh)
        fh.write("\n")


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        if length < 0 or length > MAX_BODY_BYTES:
            self._respond(413, b'{"error":"payload too large"}')
            return
        body_raw = self.rfile.read(length)

        # Secret verification (constant-time to avoid leaking the secret by timing).
        if CARBON_SECRET:
            got = self.headers.get("x-carbon-secret", "")
            if not hmac.compare_digest(got, CARBON_SECRET):
                self._respond(401, b'{"error":"unauthorized"}')
                return

        try:
            payload = json.loads(body_raw) if body_raw else {}
        except json.JSONDecodeError:
            self._respond(400, b'{"error":"invalid json"}')
            return
        # Only accept JSON objects — a bare array/string/number isn't a valid event
        # and would poison the queue for the downstream agent.
        if not isinstance(payload, dict):
            self._respond(400, b'{"error":"expected a json object"}')
            return

        event = payload.get("event", "")
        task = payload.get("task") or {}
        ts = datetime.datetime.now().isoformat()
        print(f"[{ts}] carbon {event} task={task.get('id','?')} "
              f"'{task.get('title','?')}'", flush=True)

        enqueue(payload)
        self._respond(200, b'{"status":"ok"}')

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    if not CARBON_TOKEN:
        print("WARNING: CARBON_TOKEN not set — REST calls will fail.", file=sys.stderr)
    # Refuse to expose an unauthenticated listener beyond loopback: anyone on the
    # network could otherwise enqueue records the agent then acts on.
    if HOST not in _LOOPBACK_HOSTS and not CARBON_SECRET:
        print(
            f"ERROR: refusing to bind {HOST} without CARBON_SECRET set "
            "(set a shared secret, or bind to 127.0.0.1).",
            file=sys.stderr,
        )
        sys.exit(1)
    os.makedirs(os.path.dirname(QUEUE_FILE), exist_ok=True)
    srv = http.server.HTTPServer((HOST, PORT), Handler)
    print(f"Carbon webhook listener on {HOST}:{PORT}", flush=True)
    print(f"  CARBON_URL   = {CARBON_URL}", flush=True)
    print(f"  queue        = {QUEUE_FILE}", flush=True)
    print(f"  secret check = {'on' if CARBON_SECRET else 'off'}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        srv.server_close()
