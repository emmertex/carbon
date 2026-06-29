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
  docs: `${DOCS}/README.md`,
  openSource: `${DOCS}/open-source.md`,
  emmertex: 'https://emmertex.com',
  releases: `${REPO}/releases`,
} as const;
