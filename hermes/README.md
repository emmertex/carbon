   Skill: ~/.hermes/skills/productivity/carbon-agent/SKILL.md
    - Full API reference, webhook flow, bot permissions, error handling, pitfalls
    - Token stored in .credentials file
    
    Webhook listener: carbon-webhook-listener.py
    - Listens on port 9192 (doesn't conflict with your existing 9191 Uptime Kuma listener)
    - Verifies x-carbon-secret header (optional)
    - Responds 200 immediately, queues payloads to ~/.hermes/carbon-queue.jsonl
    - Includes full REST API helper functions (comment(), complete(), read_task(), list_tasks(), create_task(), update_task())
    
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
    
    sudo cp /etc/systemd/system/carbon-agent.service ...
    sudo systemctl enable --now carbon-agent
