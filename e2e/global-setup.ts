import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Wipe and recreate the throwaway server data dir before each Playwright run. */
export default function globalSetup(): void {
  const dataDir = join(process.cwd(), 'e2e', '.tmp');
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  process.env.E2E_DATA_DIR = dataDir;
}
