// Canonical external links surfaced from Settings (docs + downloads). Centralised
// so the repo path lives in one place.

const REPO = 'https://github.com/emmertex/carbon';
const DOCS = `${REPO}/blob/master/docs`;

export const LINKS = {
  usage: `${DOCS}/usage-and-shortcuts.md`,
  dataSecurity: `${DOCS}/data-security.md`,
  hermes: `${DOCS}/hermes.md`,
  agentsApi: `${DOCS}/carbon-agent-api.md`,
  restApi: `${DOCS}/api.md`,
  homeAssistant: `${DOCS}/home-assistant.md`,
  telegram: `${DOCS}/telegram-bot.md`,
  docs: `${DOCS}/README.md`,
  openSource: `${DOCS}/open-source.md`,
  emmertex: 'https://emmertex.com',
  releases: `${REPO}/releases`,
  // Surfaced from the Install section (browser web only). The Android package id
  // matches capacitor.config.ts / tauri.conf.json; `website` points at the hosted app.
  playStore: 'https://play.google.com/store/apps/details?id=com.emmertex.carbon',
  website: 'https://app.carbon.etx.sx',
  github: REPO,
} as const;
