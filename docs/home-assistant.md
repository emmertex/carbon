# Carbon ↔ Home Assistant

Carbon keeps the **sensing in Home Assistant** and lets HA push triggers to Carbon over a
simple REST API. With it you can turn any HA event into a task, get **location reminders**
that fire when you arrive somewhere (HA does the geofencing your phone browser can't), and
do it for **everyone in the household** from a single HA token.

This is a practical setup guide. The full REST reference is in [`api.md`](api.md).

---

## 1. One-time setup

### 1a. Create a Carbon API token

In Carbon, **Settings → API tokens** (you must be an admin), create a token and pick the
scopes you need:

| You want to… | Scope |
|---|---|
| Turn HA events into inbox tasks | `inbox:write` |
| Location reminders (zones / GPS) | `tasks:write` |
| Read or update tasks from HA | `tasks:read`, `tasks:write` |

Copy the token — it's shown once.

### 1b. Tell Home Assistant about Carbon

Store the token as a secret and define the `rest_command`s you'll call. Use your own
workspace URL (e.g. `https://carbon.example.com`).

```yaml
# secrets.yaml
carbon_token: "Bearer carbon_xxxxxxxxxxxxxxxxxxxx"   # include the literal "Bearer " prefix
```

```yaml
# configuration.yaml
rest_command:
  # Create a Carbon inbox task.
  carbon_task:
    url: "https://carbon.example.com/api/tasks"
    method: POST
    headers:
      Authorization: !secret carbon_token
      Content-Type: application/json
    payload: >-
      {"title": {{ title | to_json }}{% if due is defined %}, "due_date": {{ due | to_json }}{% endif %}{% if note is defined %}, "note": {{ note | to_json }}{% endif %}}

  # Report a zone enter/leave for location reminders.
  carbon_geo:
    url: "https://carbon.example.com/api/geo/event"
    method: POST
    headers:
      Authorization: !secret carbon_token
      Content-Type: application/json
    payload: >-
      {"person": {{ person | to_json }}, "zone": {{ zone | to_json }}, "event": {{ event | to_json }}}

  # Report a raw GPS fix (faster, coordinate-based reminders).
  carbon_gps:
    url: "https://carbon.example.com/api/gps"
    method: POST
    headers:
      Authorization: !secret carbon_token
      Content-Type: application/json
    payload: >-
      {"person": {{ person | to_json }}, "lat": {{ lat }}, "lng": {{ lng }}{% if accuracy is defined and accuracy not in [None, "None", "unknown", "unavailable", ""] %}, "accuracy": {{ accuracy }}{% endif %}}
```

> The `{{ … | to_json }}` filter safely quotes/escapes each value, so titles with quotes or
> apostrophes won't break the JSON. After adding new `rest_command`s, **restart Home
> Assistant** — a YAML reload doesn't pick them up.

---

## 2. Turn an HA event into a task

The classic "low battery / device offline / leak detected → make me a task". Needs
`inbox:write`.

```yaml
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

Any task field works in the payload (`note`, `priority`, `flagged`, `defer_date`,
`reminder_at`, …) — just extend the `rest_command` payload to pass it through.

---

## 3. Location reminders

A task can carry a **location** (Scheduling section in Carbon): a place **name** that matches
an HA zone (e.g. `Home`, `Office`), and/or **coordinates + radius** ("Use my location" fills
these in). When you reach that place, Carbon pushes the task to you. There are several ways to feed your
location to Carbon — HA zones (§3b), HA GPS (§3c), each device reporting its own fix (§3d) —
use any combination, and let a place name geocode itself (§3e).

### 3a. Link your Carbon user to an HA person

So Carbon knows whose tasks to check, map your Carbon account to your HA `person` entity:
**Settings → HA person** while signed in (or see [§5](#5-multiple-people) for doing the whole
household from one token).

### 3b. Zone-based (simple)

Fire `carbon_geo` whenever the person enters or leaves any zone. One automation covers all
zones by reading the person's state (the zone name):

```yaml
- alias: "Carbon: zone enter/leave"
  triggers:
    - trigger: state
      entity_id: person.you
  conditions:
    - condition: template
      value_template: "{{ trigger.from_state.state != trigger.to_state.state }}"
  actions:
    - choose:
        - conditions: "{{ trigger.to_state.state not in ['not_home','unknown','unavailable',''] }}"
          sequence:
            - service: rest_command.carbon_geo
              data: { person: person.you, zone: "{{ trigger.to_state.state }}", event: enter }
        - conditions: "{{ trigger.from_state.state not in ['not_home','unknown','unavailable',''] }}"
          sequence:
            - service: rest_command.carbon_geo
              data: { person: person.you, zone: "{{ trigger.from_state.state }}", event: leave }
```

Carbon matches active tasks whose location **label** equals the zone name (case- and
whitespace-insensitive) and notifies the owner and assignees. Zone names map to task labels,
so a task labelled `Home` fires when HA reports the `home` zone.

> **Heads-up:** HA zone transitions can lag by a minute or more — fine for "remind me at the
> shops", less so for time-critical reminders. For faster, use GPS below.

### 3c. GPS-based (faster, coordinate-matched)

Stream raw coordinates and let Carbon match by radius — no zone names needed. Carbon stores
the latest fix and, **once a minute**, notifies you the first time you're inside a task's
radius (it won't re-nag). Give the task **coordinates + radius** instead of (or as well as) a
label.

```yaml
- alias: "Carbon: push GPS"
  triggers:
    - trigger: state            # on every location update
      entity_id: person.you
    - trigger: time_pattern     # plus a safety-net tick
      minutes: "/2"
  action:
    - if: "{{ state_attr('person.you','latitude') is not none }}"
      then:
        - service: rest_command.carbon_gps
          data:
            person: person.you
            lat: "{{ state_attr('person.you','latitude') }}"
            lng: "{{ state_attr('person.you','longitude') }}"
            accuracy: "{{ state_attr('person.you','gps_accuracy') | default('', true) }}"
```

Reminder cadence is as fast as HA reports the device's location (the HA Companion app, set to
"always" location, is typically far quicker than a zone crossing).

### 3d. Per-device locations (no HA required)

HA is only one location *source*. Each signed-in device can also report **its own** GPS fix:
the browser/phone/desktop reports where it is, and every device on the account sees the
others. In Carbon these appear as **toggleable source pills** in the location/Nearby view —
the HA tracker, this device, and any other recently-seen device — and the freshest, most
accurate active source wins. You can force a source on/off by tapping its pill, name this
device under **Settings → This device**, and retire an old one from the device list (devices
unseen for >24h age out automatically). This works with no Home Assistant at all; HA simply
becomes one more (often the most reliable) source when present.

> Cross-user reports stay safe: a named `person` GPS report can only update that user's
> single HA fix — it can never inject a named device pill into someone else's source list.
> Only a device reporting *its own* location (the signed-in client) registers a named source.

### 3e. "Nearest place" reminders (geocoding)

Beyond zones and fixed coordinates, a reminder can pin itself to the **nearest matching
place**. Via a [natural-language command](usage-and-shortcuts.md#natural-language-commands)
or the agent API ("remind me to get milk at Coles"), Carbon geocodes the place against your
current location (OpenStreetMap Overpass/Nominatim by default) and stamps the closest match's
coordinates onto the tag's geofence — no coordinates to look up. Geocoding is opt-in on
multi-tenant hosts and on by default for single-tenant self-host; see the
`CARBON_GEOCODE_*` knobs in `.env.example`.

---

## 4. Multiple people

Each household member maps their Carbon user to their HA `person`. Either each person
self-maps in **Settings → HA person**, or an **admin** maps everyone from one place using
their API token:

```
POST /api/ha-person   { "user": "partner", "person": "person.partner" }
→ 200  { "ok": true, "user": "partner", "ha_person": "person.partner" }
```

`user` is a username or id; `person: null` unlinks. (Admin-gated — the calling token must
belong to an admin.)

A `person` named in a `carbon_geo`/`carbon_gps` call that **isn't** mapped to a Carbon user
is simply ignored — never attributed to the token's owner — so one admin token can safely
report the whole household. Cover everyone in one automation by looping:

```yaml
- alias: "Carbon: push GPS (household)"
  triggers:
    - trigger: state
      entity_id: [person.you, person.partner]
    - trigger: time_pattern
      minutes: "/2"
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

---

## 5. Two-way: Carbon as a queue for HA or an agent

To close the loop — HA (or an LLM agent) reads tasks, acts, and comments back — use the full
REST API with a `tasks:read,tasks:write` token; see [`api.md`](api.md). For an **agentic**
bot that reasons over a task and replies in its thread, see the Hermes path
([`hermes.md`](hermes.md) / [`carbon-agent-api.md`](carbon-agent-api.md)).

---

## Reminders without Home Assistant

No HA? Carbon's own server handles due/defer reminders: **Settings → Reminders → Enable push
reminders** (needs an HTTPS server; it scans every minute and pushes to owner + assignees).
Foreground-only geofencing (this device, while the app is open) is a toggle there too.

## Notes & caveats

- Push delivery and geofencing need a **real device + HTTPS** to work end-to-end.
- The `geo`/`gps`/`ha-person` calls need `tasks:write`. Treat that token like a password —
  it can write as its owning user. Keep it off any internet-exposed automation you don't
  control.
- Adding or changing a `rest_command` requires an HA **restart**, not just a reload.
- Zone reminders match by **name**; GPS reminders match by **coordinates + radius**. A task
  can have either or both.
