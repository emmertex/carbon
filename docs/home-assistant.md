# Carbon ↔ Home Assistant integration

Carbon is designed so the **sensing lives in Home Assistant** and Carbon stores the triggers
and consumes webhooks. Three integration patterns, smallest to richest.

## 0. One-time setup

1. In Carbon, **Settings → API tokens** (admin), create a token:
   - For capture-only automations: scope **`inbox:write`**.
   - For geofence / reminders: scope **`tasks:write`**.
2. In Home Assistant, store it as a secret and define a `rest_command`:

```yaml
# configuration.yaml
rest_command:
  carbon_task:
    url: "https://carbon.example.com/api/tasks"
    method: POST
    headers:
      Authorization: !secret carbon_token
      Content-Type: application/json
    payload: '{"title": "{{ title }}", "due_date": "{{ due }}"}'

  carbon_geo:
    url: "https://carbon.example.com/api/geo/event"
    method: POST
    headers:
      Authorization: !secret carbon_token
      Content-Type: application/json
    payload: '{"person": "{{ person }}", "zone": "{{ zone }}", "event": "{{ event }}"}'
```

```yaml
# secrets.yaml
carbon_token: "Bearer carbon_xxxxxxxxxxxx"
```

## 1. Capture: HA event → a Carbon inbox task

The classic "low battery / device offline → make me a task" pattern. Needs only
`inbox:write`.

```yaml
# automation: low battery becomes a Carbon task
- alias: "Carbon: low battery task"
  trigger:
    - platform: numeric_state
      entity_id: sensor.front_door_battery
      below: 15
  action:
    - service: rest_command.carbon_task
      data:
        title: "Replace Front Door sensor battery"
        due: "{{ (now() + timedelta(days=2)).isoformat() }}"
```

Any task field is accepted in the JSON body (`note`, `priority`, `flagged`, `defer_date`,
`reminder_at`, `geo`, …) — extend the `rest_command` payload as needed.

## 2. Background geofencing: HA zone → Carbon location reminders

Browsers can't geofence in the background, so Carbon offloads it to HA's reliable
`person`/`zone` tracking.

1. In Carbon, **Settings → HA person** (signed in), link your Carbon user to your HA
   `person` entity id (e.g. `person.andrew`).
2. On a task, set a **location** in its Scheduling section — a place **name** that matches an
   HA zone (e.g. `Home`, `Office`), and/or `lat/lng + radius` ("Use my location" fills
   coordinates).
3. Fire `carbon_geo` on zone enter/leave:

```yaml
- alias: "Carbon: arrived home"
  trigger:
    - platform: zone
      entity_id: person.andrew
      zone: zone.home
      event: enter
  action:
    - service: rest_command.carbon_geo
      data:
        person: person.andrew
        zone: Home
        event: enter
```

Carbon matches the user's **active** tasks whose location label equals the zone (case- and
whitespace-insensitive) **or** whose coordinates contain the reported point, and pushes a
notification to the owner + assignees. The richer `POST /api/gps` endpoint takes a raw
`{lat,lng}` fix instead of a named zone if you'd rather match purely on coordinates.

## 3. Two-way: Carbon as a task queue for HA / an agent

For closing the loop (HA or an agent reads tasks, acts, comments back), use the full REST
API with a `tasks:read,tasks:write` token — see [`api.md`](api.md). If you want an
*agentic* bot (LLM that reasons over the task and acts), that's the **Hermes** path:
[`hermes.md`](hermes.md).

## Reminders without HA

If you don't run HA, Carbon's own server push handles due/defer reminders: **Settings →
Reminders → Enable push reminders** (needs a configured HTTPS server; the server scans every
minute and pushes to owner + assignees). Foreground-only geofencing (this device, while the
app is open) is also a toggle there. See the README's *Reminders & location* section.

## Caveats

- Push delivery and geofencing need a **real device + HTTPS** to verify end-to-end.
- The `geo`/`gps` endpoints require `tasks:write`. Keep that token off any
  internet-exposed automation you don't control.
- Current hardening gaps relevant to HA exposure are tracked in
  [`code-review-2026-06.md`](code-review-2026-06.md) (no rate-limit on geo events; token =
  full write as its user).
