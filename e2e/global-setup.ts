import { existsSync } from "node:fs";

/** webServer runs before globalSetup. Never delete its open database here. */
export default function globalSetup(): void {
  const dataDir = process.env.E2E_DATA_DIR;
  if (!dataDir || !existsSync(dataDir))
    throw new Error(
      "E2E config must select a disposable data directory before server startup",
    );
  // Retain the owned directory for diagnostics; no teardown races with live servers.
}
