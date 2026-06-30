# Privacy Policy

**App:** Carbon (`com.emmertex.carbon`)
**Last updated:** 30 June 2026

Carbon is an offline-first task manager. This policy explains what the app does with your
data. In short: **the developer does not collect, receive, or have access to your data.**

## What we collect

**Nothing.** The developer operates no servers and runs no analytics, advertising, or tracking
in the app. We do not see your tasks, notes, files, account details, or usage.

## Where your data lives

By default, all of your data (tasks, notes, attachments, settings) is stored **locally on your
device** and never leaves it.

Carbon can optionally sync to a server **you choose** — one you self-host, or a Carbon sync
server. If you enable sync in Settings, your data is sent only to that server.

A Carbon sync server **collects nothing beyond what the app needs to function.** It stores
only your data (tasks, notes, attachments, settings) and the account credentials needed to
sign you in and sync — nothing more. There is no analytics, advertising, tracking, or sale of
data. If you self-host, the server is yours and the same applies — you are its only operator.

**Email address.** When you use a sync server, your email address is collected and stored for
account management, security, and account deletion. If you delete your account, your email
address is deleted with it. You can delete your account at
**https://carbon.etx.sx/delete-account**.

**Location.** Location sharing is optional and is a **sync-server-only** feature. If you enable
it while using a sync server, your current location is pushed to the server and retained only
until it goes stale — **no location history is kept**, and all location data is deleted after
24 hours with no updates. Only you can see your location; other workspace members and
administrators cannot.

To turn coordinates into place names (reverse geocoding) and to search for locations by name,
the sync server queries **OpenStreetMap (Nominatim)**. These lookups are made **anonymously** —
no account, user, or device identifier is attached — and only the coordinates or search text
needed for the lookup are sent. This also happens only when you use a sync server.

## Permissions the app requests

- **Internet** — only to sync with a server you have configured. With no sync server set, the
  app makes no network connections for your content.
- **Notifications / exact alarms / run at startup** — to show task reminders on time, including
  after a reboot.
- **Location (foreground only)** — used for location-based reminders while the app is open.
  Matching against your tasks happens **on your device**. In local-only mode your location is
  never transmitted. If you enable location sharing with a sync server, it is pushed there
  under the limits described above. This permission is optional; reminders that don't use
  location work without it.
- **Vibrate** — for reminder alerts.

## Push notifications

If you enable push notifications with a sync server, delivery uses standard mobile push
infrastructure (Google Firebase Cloud Messaging). Message delivery passes through that
service; keep sensitive detail out of notification text if this matters to you.

## Children

Carbon is not directed at children and does not knowingly collect information from anyone.

## Changes

If this policy changes, the updated version will be published at this location with a new
"Last updated" date.

## Contact

Questions about this policy: **email@emmertex.com**
