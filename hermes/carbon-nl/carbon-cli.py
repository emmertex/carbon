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
  carbon-cli resolve list "shoping"
  carbon-cli tag-geo coles --lat -37.81 --lng 145.01 --radius 200 --label "Coles Camberwell"
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
    names = [x["name"] for x in resp.get("lists", [])]
    print("Lists: " + (", ".join(names) if names else "(none)"))


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
    resp = _fail(_api("GET", "/api/agent/items" + _qs(list=a.list, tag=a.tag, q=a.q, status=status)))
    if _emit(resp, a.json):
        return
    items = resp.get("items", [])
    where = f' in "{a.list}"' if a.list else (f" tagged {a.tag}" if a.tag else "")
    if not items:
        print(f"Nothing{where}.")
        return
    print(f"Tasks{where}:")
    for it in items:
        tags = (" [" + ", ".join(it.get("tags", [])) + "]") if it.get("tags") else ""
        mark = "✓ " if it.get("done") else "- "
        print(f"  {mark}{it['title']}{tags}")


def cmd_add(a):
    body = {
        "titles": a.titles,
        "list": a.list,
        "tags": a.tag or None,
        "create_list_if_missing": not a.no_create,
        "create_tags_if_missing": not a.no_create,
    }
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
    print(f"Best {a.kind} for '{a.q}': {top['name']} ({conf})")
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

    sp = sub.add_parser("items", help="show tasks in a list / with a tag")
    sp.add_argument("--list")
    sp.add_argument("--tag")
    sp.add_argument("--q")
    sp.add_argument("--status", default="active", choices=["active", "done", "all"])
    sp.add_argument("--all", action="store_true", help="include completed (same as --status all)")
    sp.set_defaults(func=cmd_items)

    sp = sub.add_parser("add", help="add one or more tasks to a list")
    sp.add_argument("titles", nargs="+")
    sp.add_argument("--list")
    sp.add_argument("--tag", action="append", help="tag to attach (repeatable)")
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

    sp = sub.add_parser("nearby", help="tasks at a place (by tag/zone/coords)")
    sp.add_argument("--tag")
    sp.add_argument("--zone")
    sp.add_argument("--lat", type=float)
    sp.add_argument("--lng", type=float)
    sp.set_defaults(func=cmd_nearby)

    sp = sub.add_parser("resolve", help="check how a name resolves (list|tag|task)")
    sp.add_argument("kind", choices=["list", "tag", "task"])
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

    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
