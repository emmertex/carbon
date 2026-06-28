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

import json
import http.server
import os
import sys
import datetime
import urllib.request
import urllib.error

PORT = int(os.environ.get("CARBON_PORT", 9192))
CARBON_URL = os.environ.get("CARBON_URL", "https://carbon.etx.sx").rstrip("/")
CARBON_TOKEN = os.environ.get("CARBON_TOKEN", "")
CARBON_SECRET = os.environ.get("CARBON_SECRET", "")
QUEUE_FILE = os.path.expanduser(
    os.environ.get("CARBON_QUEUE", "~/.hermes/carbon-queue.jsonl")
)


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
        length = int(self.headers.get("Content-Length", 0))
        body_raw = self.rfile.read(length)

        # Secret verification
        if CARBON_SECRET:
            got = self.headers.get("x-carbon-secret", "")
            if got != CARBON_SECRET:
                self._respond(401, b'{"error":"unauthorized"}')
                return

        try:
            payload = json.loads(body_raw) if body_raw else {}
        except json.JSONDecodeError:
            payload = {"raw": body_raw.decode("utf-8", errors="replace")}

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
    os.makedirs(os.path.dirname(QUEUE_FILE), exist_ok=True)
    srv = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Carbon webhook listener on 0.0.0.0:{PORT}", flush=True)
    print(f"  CARBON_URL   = {CARBON_URL}", flush=True)
    print(f"  queue        = {QUEUE_FILE}", flush=True)
    print(f"  secret check = {'on' if CARBON_SECRET else 'off'}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        srv.server_close()
