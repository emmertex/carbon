#!/usr/bin/env python3
"""
Carbon queue processor — reads queued webhook triggers and formats them
for the Hermes agent. Run by the agent session or a cron job.

Usage:
    python3 /home/ku7/carbon-process-queue.py          # print next item, mark processed
    python3 /home/ku7/carbon-process-queue.py --list    # list all unprocessed items
    python3 /home/ku7/carbon-process-queue.py --clear   # clear the queue
"""

import json
import os
import sys
import datetime

QUEUE_FILE = os.path.expanduser("~/.hermes/carbon-queue.jsonl")
PROCESSED_FILE = os.path.expanduser("~/.hermes/carbon-processed.jsonl")


def read_queue():
    if not os.path.exists(QUEUE_FILE):
        return []
    items = []
    with open(QUEUE_FILE) as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    items.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return items


def mark_processed(item):
    os.makedirs(os.path.dirname(PROCESSED_FILE), exist_ok=True)
    with open(PROCESSED_FILE, "a") as fh:
        json.dump({"processed_at": datetime.datetime.now().isoformat(), **item}, fh)
        fh.write("\n")


def clear_queue(items):
    """Rewrite queue file without processed items."""
    # For simplicity, just truncate — in production you'd want to keep unprocessed
    pass


def format_item(item):
    event = item.get("event", "?")
    task = item.get("task") or {}
    title = task.get("title", "(no title)")
    task_id = task.get("id", "?")
    status = task.get("status", "?")
    note = task.get("note", "")
    comments = item.get("comments", [])
    instructions = item.get("instructions", "")

    lines = [
        f"## Carbon Task — {event}",
        f"**Title:** {title}",
        f"**ID:** {task_id}",
        f"**Status:** {status}",
    ]
    if note:
        lines.append(f"**Note:** {note}")
    if instructions:
        lines.append(f"**Instructions:** {instructions}")
    if comments:
        lines.append("\n### Comment thread:")
        for c in comments:
            author = c.get("author", "?")
            body = c.get("body", "")
            lines.append(f"- **{author}:** {body}")

    if event == "mention":
        lines.append("\n→ Reply with a comment on the task.")
    elif event == "assigned":
        lines.append("\n→ Complete the task and mark as done when finished.")
    elif event == "test":
        lines.append("\n→ Test event. No action needed.")

    return "\n".join(lines)


def main():
    args = sys.argv[1:]

    if "--clear" in args:
        os.makedirs(os.path.dirname(QUEUE_FILE), exist_ok=True)
        open(QUEUE_FILE, "w").close()
        print("Queue cleared.")
        return

    items = read_queue()

    if not items:
        print("QUEUE_EMPTY")
        return

    if "--list" in args:
        for i, item in enumerate(items):
            task = item.get("task") or {}
            event = item.get("event", "?")
            title = task.get("title", "(no title)")
            task_id = task.get("id", "?")
            ts = item.get("queued_at", "")
            print(f"  [{i}] {event:10s} {task_id}  {title}  ({ts})")
        print(f"\n{len(items)} item(s) in queue.")
        return

    # Default: pop first item
    item = items[0]
    print(format_item(item))
    mark_processed(item)

    # Rewrite queue without the processed item
    os.makedirs(os.path.dirname(QUEUE_FILE), exist_ok=True)
    with open(QUEUE_FILE, "w") as fh:
        for remaining in items[1:]:
            json.dump(remaining, fh)
            fh.write("\n")


if __name__ == "__main__":
    main()
