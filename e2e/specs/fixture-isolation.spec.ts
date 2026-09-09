import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import config from "../playwright.config";
import { login } from "../helpers/api";

test("workers and retries share the server database and persisted MFA state", async ({}, info) => {
  const dir = process.env.E2E_RUN_DATA_DIR!;
  expect(dir).toBeTruthy();
  expect(process.env.E2E_DATA_DIR).toBe(dir);
  expect(
    (config.webServer as Array<{ env?: Record<string, string> }>)[0].env
      ?.DATABASE_PATH,
  ).toBe(join(dir, "carbon.db"));
  expect(existsSync(join(dir, "carbon.db"))).toBe(true);
  const marker = join(dir, `fixture-worker-${info.repeatEachIndex}.json`);
  const user = await login(undefined, "alice", "e2e-test-pass");
  expect(user.token).toBeTruthy();
  expect(existsSync(join(dir, "e2e-auth-state.json"))).toBe(true);
  if (info.retry) {
    const prior = JSON.parse(readFileSync(marker, "utf8"));
    expect(prior.dir).toBe(dir);
    expect(prior.pid).not.toBe(process.pid);
    expect(prior.userId).toBe(user.user.id);
  } else {
    writeFileSync(
      marker,
      JSON.stringify({ dir, pid: process.pid, userId: user.user.id }),
    );
    // Explicit diagnostic mode forces a fresh retry worker; normal suites stay green.
    if (process.env.E2E_VERIFY_RETRY === "1")
      throw new Error("intentional fixture retry probe");
  }
});
