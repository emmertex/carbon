   Skill: carbon-nl/SKILL.md   ← NEW: natural-language lists, used DIRECTLY from Hermes
    - "add milk and eggs to my shopping list", "mark off bread and milk", "what do I need at Coles?"
    - No webhook needed — the agent runs carbon-nl/carbon-cli.py, which calls /api/agent/*.
    - The server fuzzy-matches names; the CLI prints a ready-to-relay line per command.
    - Token (acting as the user) in carbon-nl/.credentials (see .credentials.example).
    - Copy to ~/.hermes/skills/productivity/carbon-nl/.

   Skill: ~/.hermes/skills/productivity/carbon-agent/SKILL.md
    - Full API reference, webhook flow, bot permissions, error handling, pitfalls
    - For the webhook/@mention trigger flow (acts as a bot on a task), not direct NL use.
    - Token stored in .credentials file

   Skill: carbon-home-assistant/SKILL.md
    - Wiring Home Assistant to Carbon: HA event → task, zone/GPS location reminders,
      multi-person (person.* → Carbon user) mapping. Operator/setup side.
    - Mirrors docs/home-assistant.md.
    
    Webhook listener: carbon-webhook-listener.py
    - Listens on port 9192 (doesn't conflict with your existing 9191 Uptime Kuma listener)
    - Verifies x-carbon-secret header (optional)
    - Responds 200 immediately, queues payloads to ~/.hermes/carbon-queue.jsonl
    - Includes full REST API helper functions (comment(), complete(), read_task(), list_tasks(), create_task(), update_task())
    - Plus natural-language agent API (/api/agent/*) helpers: agent_lists(), agent_tags(),
      agent_items(), agent_resolve(), agent_add(), agent_complete(), agent_update(),
      agent_set_tag_geo(), agent_nearby(), agent_users(), agent_share(), agent_assign(),
      agent_start_timer(), agent_stop_timer() — the server fuzzy-matches names, so pass plain
      names (never ids). agent_add() also takes scheduling fields (due_date/reminder_at/
      recurrence) via tasks=[{...}]. See docs/carbon-agent-api.md §6.
      (Bulk tag add/remove — POST /api/agent/tasks/tag — is available via carbon-nl's
      `carbon-cli.py tag` but doesn't yet have a helper here; add one if you need it from
      the webhook flow.)

    Natural-language quick example (the server resolves/creates the list + tags):

        from importlib import import_module
        m = import_module("carbon-webhook-listener")   # or just paste the helpers
        m.agent_add(list="shopping list", titles=["milk", "eggs"])
        m.agent_add(list="shopping list", tags=["coles"], titles=["bread"])
        r = m.agent_complete(queries=["bread", "butter"], list="shopping list")
        # r == {"matched":[{"title":"bread",...}], "unmatched":[{"query":"butter","reason":"no_match"}]}
        m.agent_nearby(tag="coles")                      # "what do I need at Coles?"

    The model's system prompt for these flows is SYSTEM_PROMPT in
    apps/server/src/agent-command.ts (also summarised in docs/hermes.md). Geocoding for
    "nearest Coles" is controlled by CARBON_GEOCODE_* env vars (OpenStreetMap default).
    
    Queue processor: carbon-process-queue.py
    - Pops items from the queue, formats them for the agent
    - --list to view pending items, --clear to reset
    
    To complete the setup in Carbon UI:
    
    1. Go to Settings → AI agents in Carbon
    2. Create agent of kind Agentic webhook (Hermes / OpenClaw)
    3. Username: hermes
    4. Webhook URL: http://<IP Address>:9192/webhook
    5. Shared secret: (optional — set CARBON_SECRET in the listener env to match)
    6. Save — Carbon will issue a token (though you already have one configured)
    
    To start the listener:
    
    CARBON_TOKEN=*** \
    python3 carbon-webhook-listener.py
    
    
    systemd unit file
    
    sudo cp carbon-agent.service /etc/systemd/system/
    sudo systemctl enable --now carbon-agent
