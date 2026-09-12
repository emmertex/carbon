# Home Assistant

Use Home Assistant events to create tasks and report locations through the [REST API](api.md).

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


## 2. Turn an HA event into a task

Requires `inbox:write`.

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

`POST /api/tasks` also accepts `note`, `project_id`, `flagged`, and `priority` — extend the
`rest_command` payload to pass any of those through. (It's a create-only endpoint: fields
like `defer_date` or reminders aren't set at creation — use `PATCH /api/tasks/:id` afterwards
if you need those, see [`api.md`](api.md).)


## 3. Location reminders

A task can carry a **location** (Scheduling section in Carbon): a place **name** that matches
an HA zone (e.g. `Home`, `Office`), and/or **coordinates + radius** ("Use my location" fills
these in). When you reach that place, Carbon pushes the task to you. There are several ways to feed your
location to Carbon — HA zones (§3b), HA GPS (§3c), each device reporting its own fix (§3d) —
use any combination, and let a place name geocode itself (§3e).

### 3a. Link your Carbon user to an HA person

So Carbon knows whose tasks to check, map your Carbon account to your HA `person` entity:
**Settings → HA person** while signed in (or see [Multiple people](#4-multiple-people) for doing the whole
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



### 3c. GPS-based (faster, coordinate-matched)

Stream raw coordinates and let Carbon match by radius — no zone names needed. Carbon stores
the latest fix and, **once a minute**, notifies you the first time you're inside a task's
radius (it won't re-nag). Give the task **coordinates + radius** instead of (or as well as) a
label.

```yaml
- alias: "Carbon: push GPS"
  triggers:
    - trigger: state            # Location update
      entity_id: person.you
    - trigger: time_pattern     # Periodic location update
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



### 3d. Per-device locations (no HA required)

Signed-in devices can report GPS independently of Home Assistant. Select location
sources in Nearby; Carbon uses the freshest, most accurate enabled source. Name or
retire devices in **Settings → This device**. Sources expire after 24 hours without updates.

A named `person` report updates that user’s Home Assistant source. Only the signed-in
device can register itself as a named device source.

### 3e. "Nearest place" reminders (geocoding)

Beyond zones and fixed coordinates, a reminder can pin itself to the **nearest matching
place**. Via a [natural-language command](usage-and-shortcuts.md#natural-language-commands)
or the agent API ("remind me to get milk at Supermarket"), Carbon geocodes the place against your
current location (OpenStreetMap Overpass/Nominatim by default) and stamps the closest match's
coordinates onto the tag's geofence — no coordinates to look up. Geocoding is opt-in on
multi-tenant hosts and on by default for single-tenant self-host; see the
`CARBON_GEOCODE_*` knobs in `.env.example`.


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


## 5. Read and update tasks

Use a token with `tasks:read` and `tasks:write` to read tasks and post updates or
comments. See the [API guide](api.md).

## Reminders without Home Assistant

Carbon handles due/defer reminders: **Settings → Reminders → Enable push
reminders** (needs an HTTPS server; it scans every minute and pushes to owner + assignees).
Foreground-only geofencing (this device, while the app is open) is a toggle there too.
