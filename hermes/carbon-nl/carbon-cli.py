#!/usr/bin/env python3
"""
carbon-cli — natural-language task control for Carbon, for the Hermes `carbon-nl` skill.

Thin wrapper over the Carbon agent API (/api/agent/*). The server does all the fuzzy
matching and batching, so you pass plain names (a list, a tag, a task title) — never ids.
Each command prints a short, conversational line that is meant to be relayed to the user
verbatim (e.g. "Marked off: milk / Couldn't find: bread").

Credentials (first found wins):
  1. env vars  CARBON_URL / CARBON_TOKEN
  2. a `.credentials` file next to this script (KEY=VALUE lines), or $CARBON_CREDENTIALS

Examples:
  carbon-cli add milk eggs --list "shopping list"
  carbon-cli add bread --list shopping --tag coles
  carbon-cli done bread milk --list shopping
  carbon-cli nearby --tag coles
  carbon-cli lists
  carbon-cli items --list shopping
  carbon-cli items --list recipes --notes --detail
  carbon-cli note add "Spare key" --body "Under the pot by the back door."
  carbon-cli note add "Sourdough" --recipe --list recipes --body-file sourdough.md
  carbon-cli note append "Sourdough" "Rest for 45 min"
  carbon-cli note show "Sourdough"
  carbon-cli note search "rental car"
  carbon-cli resolve list "shoping"
  carbon-cli tag-geo coles --lat -37.81 --lng 145.01 --radius 200 --label "Coles Camberwell"
  carbon-cli add "Take son to swimming" --due 2026-07-07T17:00 --remind 2026-07-07T16:00 --repeat weekly:tue
  carbon-cli users
  carbon-cli share "Take son to swimming" --to rachel
  carbon-cli assign "Book flights" --to rachel
  carbon-cli timer start "Write report"
  carbon-cli timer stop
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def _load_credentials():
    url = os.environ.get("CARBON_URL")
    token = os.environ.get("CARBON_TOKEN")
    path = os.environ.get("CARBON_CREDENTIALS") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), ".credentials"
    )
    if (not url or not token) and os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                v = v.strip().strip('"').strip("'")
                if k.strip() == "CARBON_URL" and not url:
                    url = v
                elif k.strip() == "CARBON_TOKEN" and not token:
                    token = v
    return (url or "").rstrip("/"), token or ""


CARBON_URL, CARBON_TOKEN = _load_credentials()


def _api(method, path, data=None):
    if not CARBON_URL:
        return {"error": "no CARBON_URL configured (set env or .credentials)"}
    url = f"{CARBON_URL}{path}"
    body = json.dumps(data).encode() if data is not None else None
    headers = {"Content-Type": "application/json"}
    if CARBON_TOKEN:
        headers["Authorization"] = f"Bearer {CARBON_TOKEN}"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except Exception:
            pass
        return {"error": f"HTTP {e.code}: {detail}"}
    except Exception as exc:
        return {"error": f"could not reach Carbon at {CARBON_URL}: {exc}"}


def _qs(**params):
    parts = [
        f"{k}={urllib.parse.quote(str(v))}"
        for k, v in params.items()
        if v is not None and v != ""
    ]
    return "?" + "&".join(parts) if parts else ""


def _fail(resp):
    """If the API returned an error envelope, print it and exit non-zero."""
    if isinstance(resp, dict) and resp.get("error"):
        print(f"Error: {resp['error']}")
        sys.exit(1)
    return resp


def _emit(resp, as_json):
    if as_json:
        print(json.dumps(resp, indent=2))
        return True
    return False


_WEEKDAYS = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}


def _parse_repeat(spec):
    """'daily' | 'weekly' | 'weekly:mon,tue' | 'monthly:15' | 'yearly' → a recurrence rule dict."""
    if not spec:
        return None
    typ, _, arg = spec.partition(":")
    typ = typ.strip().lower()
    if typ not in ("daily", "weekly", "monthly", "yearly"):
        print(f"Error: --repeat must be daily|weekly|monthly|yearly (got '{spec}')")
        sys.exit(1)
    rule = {"type": typ, "interval": 1}
    if typ == "weekly" and arg:
        days = [_WEEKDAYS[d.strip().lower()[:3]] for d in arg.split(",") if d.strip().lower()[:3] in _WEEKDAYS]
        if days:
            rule["daysOfWeek"] = days
    elif typ == "monthly" and arg.strip().isdigit():
        rule["dayOfMonth"] = int(arg)
    return rule


# ── commands ──────────────────────────────────────────────────────────────


def cmd_whoami(a):
    resp = _fail(_api("GET", "/api/me"))
    if _emit(resp, a.json):
        return
    name = resp.get("username") or resp.get("id")
    if resp.get("open"):
        print(f"Acting as: {name} (open mode — no accounts; everything is visible).")
    elif resp.get("is_bot"):
        print(
            f"Acting as: {name} (BOT). ⚠ Tasks you add are owned by this bot, so they WON'T "
            f"show up for a human user on the web. Use a token that acts as your own user "
            f"(Carbon → Settings → API tokens, scopes tasks:read, tasks:write, inbox:write)."
        )
    else:
        print(f"Acting as: {name} (user). Tasks you add are owned by {name} and visible to them.")


def cmd_lists(a):
    resp = _fail(_api("GET", "/api/agent/lists"))
    if _emit(resp, a.json):
        return
    lists = resp.get("lists", [])
    # A notebook holds notes, not tasks — marking it here is what stops a caller reading it
    # with the task default and concluding it is empty.
    names = [x["name"] + (" 📓" if x.get("notes") else "") for x in lists]
    print("Lists: " + (", ".join(names) if names else "(none)"))
    if any(x.get("notes") for x in lists):
        print("(📓 = notebook: holds notes. Read with `items --list \"<name>\"`.)")


def cmd_tags(a):
    resp = _fail(_api("GET", "/api/agent/tags"))
    if _emit(resp, a.json):
        return
    tags = resp.get("tags", [])
    if not tags:
        print("Tags: (none)")
        return
    print("Tags: " + ", ".join(t["name"] + (" 📍" if t.get("hasGeo") else "") for t in tags))


def cmd_items(a):
    status = "all" if a.all else a.status
    # No --notes/--everything means no `type` at all, so the server picks: notes inside a
    # notebook, tasks anywhere else.
    itype = "note" if a.notes else ("all" if a.everything else None)
    resp = _fail(_api("GET", "/api/agent/items" + _qs(
        list=a.list, tag=a.tag, q=a.q, status=status, type=itype,
        detail="1" if a.detail else None,
    )))
    if _emit(resp, a.json):
        return
    items = resp.get("items", [])
    where = f' in "{a.list}"' if a.list else (f" tagged {a.tag}" if a.tag else "")
    if not items:
        print(f"Nothing{where}.")
        return
    kind = "Notes" if all(it.get("type") == "note" for it in items) and a.detail else "Items"
    print(f"{kind}{where}:")
    for it in items:
        tags = (" [" + ", ".join(it.get("tags", [])) + "]") if it.get("tags") else ""
        mark = "✓ " if it.get("done") else "- "
        kindmark = " (recipe)" if it.get("note_mode") == "recipe" else ""
        print(f"  {mark}{it['title']}{kindmark}{tags}")
        body = it.get("note")
        if a.detail and body:
            for line in body.splitlines():
                print(f"      {line}")
            if it.get("note_truncated"):
                print("      … (cut short — read this one with `note show \"<title>\"`)")


def cmd_add(a):
    # Scheduling (due/defer/remind/repeat) needs the per-task tasks[] form; otherwise titles[].
    sched = {
        "due_date": a.due,
        "defer_date": a.defer,
        "reminder_at": a.remind,
        "recurrence": _parse_repeat(a.repeat),
    }
    sched = {k: v for k, v in sched.items() if v is not None}
    body = {
        "list": a.list,
        "tags": a.tag or None,
        "create_list_if_missing": not a.no_create,
        "create_tags_if_missing": not a.no_create,
    }
    if sched:
        body["tasks"] = [{"title": t, **sched} for t in a.titles]
    else:
        body["titles"] = a.titles
    resp = _fail(_api("POST", "/api/agent/tasks/batch", {k: v for k, v in body.items() if v is not None}))
    if _emit(resp, a.json):
        return
    titles = ", ".join(t["title"] for t in resp.get("created", []))
    lst = resp.get("list") or {}
    where = ""
    if lst:
        where = f' to {"new list " if lst.get("created") else ""}"{lst["name"]}"'
    tag_out = resp.get("tags", [])
    tagstr = (" (tagged " + ", ".join(t["name"] for t in tag_out) + ")") if tag_out else ""
    print(f"Added{where}{tagstr}: {titles}")


def cmd_done(a):
    body = {"queries": a.titles, "list": a.list, "tag": a.tag, "done": not a.undo}
    resp = _fail(_api("POST", "/api/agent/tasks/complete", {k: v for k, v in body.items() if v is not None}))
    if _emit(resp, a.json):
        return
    matched = [m["title"] for m in resp.get("matched", [])]
    unmatched = [u["query"] for u in resp.get("unmatched", [])]
    verb = "Re-opened" if a.undo else "Marked off"
    if matched:
        print(f"{verb}: " + ", ".join(matched))
    if unmatched:
        print("Couldn't find: " + ", ".join(unmatched))
    if not matched and not unmatched:
        print("Nothing to do.")


def cmd_tag(a):
    body = {"list": a.list, "tag": a.tag, "queries": a.query or None,
            "add": a.add or None, "remove": a.remove or None}
    resp = _fail(_api("POST", "/api/agent/tasks/tag", {k: v for k, v in body.items() if v is not None}))
    if _emit(resp, a.json):
        return
    n = len(resp.get("updated", []))
    added = resp.get("tags_added", [])
    removed = resp.get("tags_removed", [])
    if n == 0:
        print("No matching tasks.")
        return
    if added:
        print(f"Tagged {n} task{'' if n == 1 else 's'} with " + ", ".join(added))
    if removed:
        print(f"Removed " + ", ".join(removed) + f" from {n} task{'' if n == 1 else 's'}")


def _note_body(a):
    """--body, or --body-file (use '-' for stdin) for anything multi-line, e.g. a recipe."""
    if a.body_file:
        if a.body_file == "-":
            return sys.stdin.read()
        with open(a.body_file) as fh:
            return fh.read()
    return a.body


def cmd_note_add(a):
    body = _note_body(a)
    task = {"title": a.title}
    # note_mode implies a note server-side; type:"note" is only needed without it — and is
    # deliberately omitted inside a notebook, where the list already makes new items notes.
    if a.recipe:
        task["note_mode"] = "recipe"
    else:
        task["type"] = "note"
    if body:
        task["note"] = body
    payload = {"tasks": [task], "list": a.list, "create_list_if_missing": not a.no_create}
    resp = _fail(_api("POST", "/api/agent/tasks/batch", {k: v for k, v in payload.items() if v is not None}))
    if _emit(resp, a.json):
        return
    created = resp.get("created", [])
    if not created:
        print("Nothing was created.")
        return
    lst = resp.get("list") or {}
    where = f' in "{lst["name"]}"' if lst else ""
    noun = "Recipe" if created[0].get("note_mode") == "recipe" else "Note"
    print(f"{noun} saved{where}: {created[0]['title']}")


def cmd_note_append(a):
    """Append a line, keeping the existing body — never read-then-replace, which loses
    whatever you didn't read back."""
    resp = _fail(_api("POST", "/api/agent/tasks/update", {
        "updates": [{"query": a.title, "list": a.list, "patch": {"note_append": a.text}}],
    }))
    if _emit(resp, a.json):
        return
    matched = resp.get("matched", [])
    if matched:
        print(f"Added to \"{matched[0]['title']}\": {a.text}")
    else:
        print(f"Couldn't find a note called '{a.title}'.")


def cmd_note_show(a):
    resp = _fail(_api("GET", "/api/agent/items" + _qs(
        q=a.title, list=a.list, type="note", detail="1", full="1", limit=1, status="all",
    )))
    if _emit(resp, a.json):
        return
    items = resp.get("items", [])
    if not items:
        print(f"Couldn't find a note called '{a.title}'.")
        return
    it = items[0]
    kind = " (recipe)" if it.get("note_mode") == "recipe" else ""
    print(f"{it['title']}{kind}:")
    print(it.get("note") or "(empty)")


def cmd_note_search(a):
    resp = _fail(_api("GET", "/api/agent/notes/search" + _qs(q=a.q, list=a.list, tag=a.tag, type=a.type)))
    if _emit(resp, a.json):
        return
    matches = resp.get("matches", [])
    if not matches:
        print(f"No notes mention '{a.q}'.")
        return
    print(f"Notes mentioning '{a.q}':")
    for m in matches:
        kind = " (recipe)" if m.get("note_mode") == "recipe" else ""
        print(f"  - {m['title']}{kind}: {m['snippet']}")


def cmd_nearby(a):
    resp = _fail(_api("GET", "/api/agent/nearby" + _qs(tag=a.tag, zone=a.zone, lat=a.lat, lng=a.lng)))
    if _emit(resp, a.json):
        return
    items = [it["title"] for it in resp.get("items", [])]
    where = a.tag or a.zone or "there"
    if items:
        print(f"At {where} you need: " + ", ".join(items))
    else:
        print(f"Nothing marked for {where}.")


def cmd_resolve(a):
    resp = _fail(_api("POST", "/api/agent/resolve", {"kind": a.kind, "q": a.q}))
    if _emit(resp, a.json):
        return
    best = resp.get("best")
    cands = resp.get("candidates", [])
    if not cands:
        print(f"No {a.kind} matches '{a.q}'.")
        return
    top = cands[0]
    conf = "confident" if best and best.get("confident") else "unsure — ask the user"
    # kind:"task" matches notes too, so say which one won — only a task can be checked off.
    what = f" [{top['type']}]" if top.get("type") and a.kind in ("task", "note") else ""
    print(f"Best {a.kind} for '{a.q}': {top['name']}{what} ({conf})")
    if len(cands) > 1:
        print("Other: " + ", ".join(c["name"] for c in cands[1:]))


def cmd_tag_geo(a):
    if a.lat is not None and a.lng is not None and not a.near_name:
        geo = {"lat": a.lat, "lng": a.lng, "radius": a.radius, "label": a.label}
        body = {"tag": a.tag, "geo": {k: v for k, v in geo.items() if v is not None},
                "create_if_missing": a.create}
    elif a.near_name and a.lat is not None and a.lng is not None:
        body = {"tag": a.tag, "near_name": a.near_name, "near": {"lat": a.lat, "lng": a.lng},
                "create_if_missing": a.create}
    elif a.clear:
        body = {"tag": a.tag, "geo": None}
    else:
        print("Error: provide --lat/--lng, or --near-name with --lat/--lng, or --clear")
        sys.exit(1)
    resp = _fail(_api("POST", "/api/agent/tags/geo", body))
    if _emit(resp, a.json):
        return
    g = resp.get("geo")
    if g is None:
        print(f"Cleared location for tag {resp.get('tag', {}).get('name', a.tag)}.")
    else:
        label = f' ({g["label"]})' if g.get("label") else ""
        print(f"Set {resp['tag']['name']} location: {g['lat']:.4f}, {g['lng']:.4f} (r={g['radius']}m){label}")


def cmd_users(a):
    resp = _fail(_api("GET", "/api/agent/users"))
    if _emit(resp, a.json):
        return
    names = [u["name"] for u in resp.get("users", [])]
    print("People: " + (", ".join(names) if names else "(none)"))


def _share_assign(a, path, verbs):
    body = {"query": a.task, "users": a.to, "remove": a.remove or None}
    if path.endswith("share") and a.read:
        body["permission"] = "read"
    resp = _fail(_api("POST", path, {k: v for k, v in body.items() if v is not None}))
    if _emit(resp, a.json):
        return resp
    updated = [u["title"] for u in resp.get("updated", [])]
    who = ", ".join(u["name"] for u in resp.get("users", []))
    unknown = resp.get("unknown_users", [])
    unmatched = [u["query"] for u in resp.get("unmatched", [])]
    did, undid = verbs
    prep = "from" if a.remove else ("with" if path.endswith("share") else "to")
    if updated and who:
        print(f"{undid if a.remove else did} {', '.join(updated)} {prep} {who}")
    if unknown:
        print("No such user: " + ", ".join(unknown))
    if unmatched:
        print("Skipped: " + ", ".join(unmatched))
    if not updated and not unknown and not unmatched:
        print("Nothing to do.")
    return resp


def cmd_share(a):
    _share_assign(a, "/api/agent/tasks/share", ("Shared", "Unshared"))


def cmd_assign(a):
    _share_assign(a, "/api/agent/tasks/assign", ("Assigned", "Unassigned"))


def cmd_timer(a):
    if a.action == "start":
        resp = _fail(_api("POST", "/api/agent/timer/start", {"query": a.task}))
        if _emit(resp, a.json):
            return
        started = resp.get("started") or {}
        stopped = resp.get("stopped")
        msg = f"Started timer on {started.get('title', a.task)}"
        if stopped and stopped.get("title"):
            msg += f" (stopped {stopped['title']})"
        print(msg + ".")
    else:  # stop
        resp = _fail(_api("POST", "/api/agent/timer/stop", {}))
        if _emit(resp, a.json):
            return
        stopped = resp.get("stopped")
        print(f"Stopped timer on {stopped['title']}." if stopped and stopped.get("title")
              else "No timer running.")


def build_parser():
    p = argparse.ArgumentParser(prog="carbon-cli", description="Natural-language Carbon task control.")
    p.add_argument("--json", action="store_true", help="print raw JSON instead of a friendly line")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("whoami", help="show which user/bot the token acts as (diagnose visibility)")
    sp.set_defaults(func=cmd_whoami)

    sp = sub.add_parser("lists", help="show task lists (projects)")
    sp.set_defaults(func=cmd_lists)

    sp = sub.add_parser("tags", help="show tags (📍 = has a location)")
    sp.set_defaults(func=cmd_tags)

    sp = sub.add_parser("items", help="show tasks (or notes) in a list / with a tag")
    sp.add_argument("--list")
    sp.add_argument("--tag")
    sp.add_argument("--q")
    sp.add_argument("--status", default="active", choices=["active", "done", "all"])
    sp.add_argument("--all", action="store_true", help="include completed (same as --status all)")
    sp.add_argument("--notes", action="store_true", help="notes only (a notebook lists notes anyway)")
    sp.add_argument("--everything", action="store_true", help="tasks and notes together")
    sp.add_argument("--detail", action="store_true", help="include note bodies, dates and flags")
    sp.set_defaults(func=cmd_items)

    sp = sub.add_parser("add", help="add one or more tasks to a list")
    sp.add_argument("titles", nargs="+")
    sp.add_argument("--list")
    sp.add_argument("--tag", action="append", help="tag to attach (repeatable)")
    sp.add_argument("--due", help="due date/time, ISO e.g. 2026-07-07T17:00")
    sp.add_argument("--defer", help="defer (hide until) date/time, ISO")
    sp.add_argument("--remind", help="reminder date/time, ISO (a push fires then)")
    sp.add_argument("--repeat", help="repeat: daily|weekly|monthly|yearly, e.g. weekly:tue or monthly:15")
    sp.add_argument("--no-create", action="store_true", help="don't auto-create a missing list/tag")
    sp.set_defaults(func=cmd_add)

    sp = sub.add_parser("done", aliases=["complete", "check-off"], help="mark tasks off by name")
    sp.add_argument("titles", nargs="+")
    sp.add_argument("--list")
    sp.add_argument("--tag")
    sp.add_argument("--undo", action="store_true", help="re-open instead of completing")
    sp.set_defaults(func=cmd_done)

    sp = sub.add_parser("tag", help="bulk add/remove tags on a list's tasks (or specific ones)")
    sp.add_argument("--list", help="tag every task in this list")
    sp.add_argument("--tag", help="tag every task already carrying this tag")
    sp.add_argument("--query", action="append", help="specific task name (repeatable)")
    sp.add_argument("--add", action="append", help="tag to add (repeatable)")
    sp.add_argument("--remove", action="append", help="tag to remove (repeatable)")
    sp.set_defaults(func=cmd_tag)

    sp = sub.add_parser("note", help="write, append to, read or search notes and recipes")
    nsub = sp.add_subparsers(dest="note_cmd", required=True)

    np_ = nsub.add_parser("add", help="write a new note (or recipe)")
    np_.add_argument("title")
    np_.add_argument("--body", help="the note body")
    np_.add_argument("--body-file", dest="body_file", help="read the body from a file ('-' = stdin)")
    np_.add_argument("--recipe", action="store_true", help="save it as a recipe (recipe editor)")
    np_.add_argument("--list", help="notebook/list to file it under")
    np_.add_argument("--no-create", action="store_true", help="don't auto-create a missing list")
    np_.set_defaults(func=cmd_note_add)

    np_ = nsub.add_parser("append", help="add a line to an existing note, keeping the rest")
    np_.add_argument("title", help="note name (fuzzy)")
    np_.add_argument("text")
    np_.add_argument("--list")
    np_.set_defaults(func=cmd_note_append)

    np_ = nsub.add_parser("show", help="print one note in full")
    np_.add_argument("title", help="note name (fuzzy)")
    np_.add_argument("--list")
    np_.set_defaults(func=cmd_note_show)

    np_ = nsub.add_parser("search", help="search inside note bodies, not just titles")
    np_.add_argument("q")
    np_.add_argument("--list")
    np_.add_argument("--tag")
    np_.add_argument("--type", choices=["note", "task", "all"], default="note")
    np_.set_defaults(func=cmd_note_search)

    sp = sub.add_parser("nearby", help="tasks at a place (by tag/zone/coords)")
    sp.add_argument("--tag")
    sp.add_argument("--zone")
    sp.add_argument("--lat", type=float)
    sp.add_argument("--lng", type=float)
    sp.set_defaults(func=cmd_nearby)

    sp = sub.add_parser("resolve", help="check how a name resolves (list|tag|task|note)")
    sp.add_argument("kind", choices=["list", "tag", "task", "note"])
    sp.add_argument("q")
    sp.set_defaults(func=cmd_resolve)

    sp = sub.add_parser("tag-geo", help="set/clear a tag's location")
    sp.add_argument("tag")
    sp.add_argument("--lat", type=float)
    sp.add_argument("--lng", type=float)
    sp.add_argument("--radius", type=int)
    sp.add_argument("--label")
    sp.add_argument("--near-name", dest="near_name", help="geocode the nearest place of this name to --lat/--lng")
    sp.add_argument("--clear", action="store_true")
    sp.add_argument("--create", action="store_true", help="create the tag if missing")
    sp.set_defaults(func=cmd_tag_geo)

    sp = sub.add_parser("users", help="people a task can be shared with / assigned to")
    sp.set_defaults(func=cmd_users)

    sp = sub.add_parser("share", help="share a task with people (by name)")
    sp.add_argument("task", help="task name (fuzzy)")
    sp.add_argument("--to", action="append", required=True, help="person to share with (repeatable)")
    sp.add_argument("--read", action="store_true", help="grant read-only (default is write)")
    sp.add_argument("--remove", action="store_true", help="unshare instead")
    sp.set_defaults(func=cmd_share)

    sp = sub.add_parser("assign", help="assign a task to people (by name)")
    sp.add_argument("task", help="task name (fuzzy)")
    sp.add_argument("--to", action="append", required=True, help="person to assign (repeatable)")
    sp.add_argument("--remove", action="store_true", help="unassign instead")
    sp.set_defaults(func=cmd_assign)

    sp = sub.add_parser("timer", help="start/stop time tracking on a task")
    sp.add_argument("action", choices=["start", "stop"])
    sp.add_argument("task", nargs="?", help="task name (for start)")
    sp.set_defaults(func=cmd_timer)

    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
