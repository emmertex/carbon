/** Build only a workspace under the configured base, preserving browser transport. */
export function landingWorkspaceUrl(
  input: string,
  baseDomain: string,
  origin: string,
): string | null {
  const base = baseDomain.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(base)) return null;
  let label = input.trim().toLowerCase();
  if (label.endsWith(`.${base}`)) label = label.slice(0, -(base.length + 1));
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  url.hostname = `${label}.${base}`;
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.href;
}
