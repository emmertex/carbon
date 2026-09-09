import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

/** Mounted before SPA fallback. This module never opens a workspace database. */
export function landingRoutes(options: {
  root: string;
  baseDomain: string;
  appHost: string;
  isApex: (host: string) => boolean;
}) {
  const app = new Hono();
  const html = readFileSync(join(options.root, 'landing.html'), 'utf8');
  const sendPage = (host: string) => {
    // Protocol-relative links retain the browser's HTTPS behind a reverse proxy,
    // and HTTP + explicit ports in a local hosted-subdomain preview.
    let local = '/local';
    if (options.baseDomain) {
      const port = new URL(`http://${host}`).port;
      local = `//${options.appHost}.${options.baseDomain}${port ? `:${port}` : ''}/local`;
    }
    let result = html
      .replaceAll('href="/local"', `href="${local}"`)
      .replace('data-workspace-domain=""', `data-workspace-domain="${options.baseDomain}"`);
    if (options.baseDomain) {
      const canonical = `https://${options.baseDomain}/`;
      result = result
        .replace(/(<link\s+rel="canonical"\s+href=")[^"]+/, `$1${canonical}`)
        .replace(/(<meta\s+property="og:url"\s+content=")[^"]+/, `$1${canonical}`)
        .replace(
          /(<meta\s+property="og:image"\s+content=")[^"]+/,
          `$1${canonical}shots/landing-overview.png`,
        );
    }
    return result;
  };
  app.get('/', (c, next) => {
    if (!options.isApex(c.req.header('host') || '')) return next();
    c.header('Cache-Control', 'no-cache');
    return c.html(sendPage(c.req.header('host') || ''));
  });
  app.get('/landing', (c) => {
    c.header('Cache-Control', 'no-cache');
    return c.html(sendPage(c.req.header('host') || ''));
  });
  app.get('/landing.html', (c) => c.redirect('/landing', 302));
  app.get('/local', async (c, next) => {
    const host = c.req.header('host') || '';
    if (
      options.baseDomain &&
      new URL(`http://${host}`).hostname !== `${options.appHost}.${options.baseDomain}`
    ) {
      const port = new URL(`http://${host}`).port;
      return c.redirect(
        `//${options.appHost}.${options.baseDomain}${port ? `:${port}` : ''}/local`,
        302,
      );
    }
    const response = await serveStatic({ path: join(options.root, 'index.html') })(c, next);
    return response || c.res;
  });
  return app;
}
