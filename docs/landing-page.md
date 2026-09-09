# Landing page setup

Carbon builds a static marketing document alongside its application. The page has
readable HTML, ordinary links, metadata and screenshots; it does not initialize the
browser task database. JavaScript only enhances the existing-workspace form.

## Preview

Run `npm run dev -w @carbon/web` and open
[the landing preview](http://localhost:3042/landing.html).
The application remains at `/`. **Try locally** opens `/local`, remembers local
use for that browser origin, and enters `/today` without connecting to a server.
To return to the local data, use the same address and browser. The local choice
remains active on a single-tenant deployment until a server is configured in Settings.

Signup stays on the current origin. Vite alone does not provide the signup API;
use the built Carbon server to exercise hosted signup.

## Deployment routes

Build the web and server together:

```sh
npm run build:server
```

Point the server's `STATIC_DIR` at the complete `apps/web/dist` directory. Include
both HTML documents and all assets; do not deploy just the marketing file.

| Entry | Result |
| --- | --- |
| `/` on the configured `BASE_DOMAIN` apex or a reserved marketing alias | Static landing page |
| `/` on `APP_HOST.BASE_DOMAIN` | Local application |
| `/` on a workspace subdomain | Workspace application |
| `/` with no `BASE_DOMAIN` | Existing single-tenant application |
| `/landing` | Explicit static landing page, including on a custom deployment |
| `/local` on a hosted apex or workspace host | Redirect to the configured local app host |
| `/local` on a custom or local app host | Local application on that origin |
| `/signup`, `/privacy` | Public pages without task database startup |

Local links preserve the browser's scheme and explicit port. For example, an apex
at `http://localhost:3051` with `APP_HOST=offline` links to
`http://offline.localhost:3051/local`. Configure DNS and reverse-proxy routing for
both the apex and app/workspace hosts in a hosted deployment. Preserve the original
`Host` header, including its external port when nonstandard. HTTPS termination does
not require forwarding a scheme header for these links.

A cached application shell at the apex checks the host role before importing the
application and hands off to `/landing`. The marketing document does not register
a service worker; the application retains its existing registration.

## Metadata and content

The default canonical URL is `https://carbon.etx.sx/`. For a standalone/custom
build, set `VITE_PUBLIC_SITE_URL` to an HTTP(S) origin at build time. Paths, query
strings and credentials are rejected. A server configured with `BASE_DOMAIN`
uses `https://BASE_DOMAIN/` for canonical and social URLs. Local preview CTA links
still use HTTP where appropriate. Do not point crawlers at a preview host.

The page's prices match the hosted plans: $7.50 AUD for three months or $20 AUD
for one year, with a 30-day trial and basic AI under fair-use limits. If operating
a custom host with different terms, update its page to match its configuration.

Downloads link to the release listing so visitors can see the files and notes for
each release. Update platform copy only when the corresponding artifacts are
available and validated. Keep setup and technical instructions in documentation.
