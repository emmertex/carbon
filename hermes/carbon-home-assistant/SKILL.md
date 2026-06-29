---
name: carbon-home-assistant
description: Use when wiring Home Assistant to Carbon (self-hosted task manager) — turning HA events into tasks, setting up zone/GPS location reminders, or mapping household members' HA persons to Carbon users. Covers the rest_command setup, geofence and GPS automations, multi-person mapping, and the relevant Carbon REST endpoints.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [carbon, home-assistant, geofence, gps, location, reminders, rest-api, productivity]
    related_skills: [carbon-agent, home-assistant-troubleshooting, concise-response]
---

# Carbon ↔ Home Assistant

Carbon is a self-hosted task manager. Home Assistant feeds it triggers over a small REST API
so HA events become tasks and **location reminders** fire when a person reaches a place
(HA does the background geofencing a phone browser can't). One HA admin token can drive the
whole household.

This skill is the **operator/setup** side. For the agentic webhook (a bot that comments on
tasks), see the `carbon-agent` skill.

## Configuration

| Variable | Description |
|----------|-------------|
| `CARBON_URL` | Workspace base URL, e.g. `https://carbon.example.com` |
| `CARBON_TOKEN` | API token (Bearer). `inbox:write` for capture; `tasks:write` for location/reminders |

The token lives in HA `secrets.yaml` as `carbon_token: "Bearer carbon_…"` (include the
literal `Bearer ` prefix).

## When to use

- The user wants an HA event (low battery, leak, device offline) to create a Carbon task
- The user wants location reminders (arrive home/office → get the task)
- The user wants to add another household member, or asks "why did X's location hit my tasks"
- The user is debugging zone vs GPS reminder latency

## HA rest_command (configuration.yaml)

Define once; restart HA afterwards (a YAML reload does **not** load new `rest_command`s).

```yaml
rest_command:
  carbon_task:
    url: "https://carbon.example.com/api/tasks"
    method: POST
    headers: { Authorization: !secret carbon_token, Content-Type: application/json }
    payload: >-
      {"title": {{ title | to_json }}{% if due is defined %}, "due_date": {{ due | to_json }}{% endif %}}
  carbon_geo:
    url: "https://carbon.example.com/api/geo/event"
    method: POST
    headers: { Authorization: !secret carbon_token, Content-Type: application/json }
    payload: >-
      {"person": {{ person | to_json }}, "zone": {{ zone | to_json }}, "event": {{ event | to_json }}}
  carbon_gps:
    url: "https://carbon.example.com/api/gps"
    method: POST
    headers: { Authorization: !secret carbon_token, Content-Type: application/json }
    payload: >-
      {"person": {{ person | to_json }}, "lat": {{ lat }}, "lng": {{ lng }}{% if accuracy is defined and accuracy not in [None, "None", "unknown", "unavailable", ""] %}, "accuracy": {{ accuracy }}{% endif %}}
```

## Pattern 1 — HA event → task (`inbox:write`)

```yaml
- alias: "Carbon: low battery task"
  trigger: { platform: numeric_state, entity_id: sensor.front_door_battery, below: 15 }
  action:
    - service: rest_command.carbon_task
      data: { title: "Replace Front Door battery", due: "{{ (now()+timedelta(days=2)).isoformat() }}" }
```

Any task field works in the payload: `note`, `priority`, `flagged`, `defer_date`.

## Pattern 2 — Zone reminders (`tasks:write`)

Carbon matches a task's location **label** to the zone name (case/whitespace-insensitive).
One automation per person covers all zones via the person's state:

```yaml
- alias: "Carbon: zone enter/leave"
  triggers: [{ trigger: state, entity_id: person.you }]
  conditions: [{ condition: template, value_template: "{{ trigger.from_state.state != trigger.to_state.state }}" }]
  actions:
    - choose:
        - conditions: "{{ trigger.to_state.state not in ['not_home','unknown','unavailable',''] }}"
          sequence: [{ service: rest_command.carbon_geo, data: { person: person.you, zone: "{{ trigger.to_state.state }}", event: enter } }]
        - conditions: "{{ trigger.from_state.state not in ['not_home','unknown','unavailable',''] }}"
          sequence: [{ service: rest_command.carbon_geo, data: { person: person.you, zone: "{{ trigger.from_state.state }}", event: leave } }]
```

## Pattern 3 — GPS reminders (faster, coordinate-matched)

Zone transitions can lag a minute+. Stream raw coordinates instead; Carbon stores the latest
fix and a server scheduler checks proximity **every minute**, notifying once per task when
inside its radius (deduped). Tasks need **coordinates + radius**, not a label.

```yaml
- alias: "Carbon: push GPS (household)"
  triggers:
    - { trigger: state, entity_id: [person.you, person.partner] }
    - { trigger: time_pattern, minutes: "/2" }
  action:
    - repeat:
        for_each: [person.you, person.partner]
        sequence:
          - if: "{{ state_attr(repeat.item,'latitude') is not none }}"
            then:
              - service: rest_command.carbon_gps
                data:
                  person: "{{ repeat.item }}"
                  lat: "{{ state_attr(repeat.item,'latitude') }}"
                  lng: "{{ state_attr(repeat.item,'longitude') }}"
                  accuracy: "{{ state_attr(repeat.item,'gps_accuracy') | default('', true) }}"
```

## Mapping people to Carbon users

Carbon resolves `person.*` → a Carbon user to know whose tasks to check.

- Self-serve: **Settings → HA person** while signed in.
- Admin (one token for everyone): `POST /api/ha-person { "user": "<id|username>", "person": "person.partner" }` → `{ ok, user, ha_person }`. `person: null` unlinks. The calling token's user must be an admin.

**Important:** a `person` that isn't mapped to any Carbon user is **ignored** (no-op), never
attributed to the token owner. So if someone's reminders are landing on the wrong person,
the cause is almost always a missing/incorrect `ha-person` mapping.

## Relevant Carbon endpoints

```
POST /api/tasks            { title, due_date, note, priority, flagged, geo, ... }  (inbox:write)
POST /api/geo/event        { person, zone, event: enter|leave }                    (tasks:write)
POST /api/gps              { person, lat, lng, accuracy? }                          (tasks:write)
POST /api/ha-person        { user, person }                                        (tasks:write, admin)
GET  /api/where            → { zone, haGps }   the user's last known location       (tasks:read)
GET  /api/health           → { status, version }   (no auth)
```

## Common pitfalls

1. **New rest_command not working** → HA needs a full **restart**, not a reload.
2. **Reminders hit the wrong person** → the `person.*` isn't mapped (or maps to the wrong
   Carbon user). Fix with `/api/ha-person`.
3. **Zone reminders are slow** → expected; HA zone events lag. Switch that task to GPS
   (coordinates + radius) and add the GPS automation.
4. **GPS reminder never fires** → the task has no coordinates (only a label), or the HA
   Companion app location permission isn't "Always".
5. **JSON breaks on apostrophes** → use `{{ value | to_json }}` in the payload, not bare
   `"{{ value }}"`.
6. **Token leakage** → `tasks:write` can write as its user. Keep it out of any
   internet-exposed automation you don't control.

## Verification checklist

- [ ] `GET /api/health` returns `{status:"ok"}` from the HA host
- [ ] `rest_command`s load after HA restart (Developer Tools → Services lists them)
- [ ] Each person is mapped (`/api/ha-person` or Settings → HA person)
- [ ] A test `carbon_geo`/`carbon_gps` call returns `{ok:true}` (and `saved:false`/`matched:0`
      with `reason:"unmapped person"` if the person isn't mapped)
- [ ] A task with a matching zone label or coordinates pushes a notification on arrival
