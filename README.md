# Carbon

Task management with projects, notes, recurring tasks, time tracking and offline storage.
Use Carbon locally, connect to a hosted workspace, or run your own sync server.

## Development

```sh
npm install
npm run dev
```

Open http://localhost:3042. The development server runs on port 3069.
Configure sync in **Settings → Sync server**.

```sh
npm test
npm run build:server
```

## Self-hosting

```sh
npm run add-user -w @carbon/server -- username 'your-password'
```

Save the generated user entry as `AUTH_USERS` in `.env`, then start the server:

```sh
docker compose up -d --build
```

The container serves the app and API on port 3069 and stores data in `./data`.
The data directory must be writable by the container user (UID 1000 by default).
Use HTTPS for remote access. Sync accounts require two-factor authentication;
configure `SMTP_*` for email codes or use an authenticator app.

See [server configuration](apps/server/.env.example) and
[backup and restore](docs/self-hosting.md).

## Code layout

| Path | Contents |
| --- | --- |
| `packages/core` | Data model, SQLite schema, migrations and field-level CRDT sync |
| `apps/web` | React PWA with local SQLite storage persisted to IndexedDB |
| `apps/server` | Sync server, REST API and integrations; serves the web build |
| `apps/desktop` | Tauri desktop app |
| `apps/mobile` | Capacitor Android app |

## Documentation

- [Usage and shortcuts](docs/usage-and-shortcuts.md)
- [Features](docs/features.md)
- [Native apps](docs/native-apps.md)
- [API](docs/api.md)
- [Data security](docs/data-security.md)
- [All documentation](docs/README.md)
- [Release notes](CHANGELOG.md)
