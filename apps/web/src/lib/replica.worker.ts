/// <reference lib="webworker" />

// Read replica of the live database, so the sidebar's background counts run off
// the main thread (docs/internal/worker-db-plan.md, phase 2).
//
// The main thread seeds it with a full export, then forwards every write it
// records (db.ts `replicaOutbox`) in order. Core issues no nondeterministic SQL,
// so redoing the same statements on the same state keeps the copy identical.
// Queries are named functions from sidebarQueries.ts — never closures — and run
// against the state as of the last batch applied; every reply carries that
// revision so the main thread can drop stale answers.

import initSqlJs, { type Database, type Statement } from "sql.js";
import type { Db, Row, SqlParams } from "@carbon/core";
import { SIDEBAR_QUERIES, type SidebarQueryName } from "./sidebarQueries";
import { adoptRevision } from "./dbRevision";
import { setPendingHideIds } from "./completionHold";
import type { MutRec } from "./db";

declare const self: DedicatedWorkerGlobalScope;

export type ReplicaRequest =
  | { t: "seed"; snap: Uint8Array; rev: number }
  | { t: "apply"; recs: MutRec[]; rev: number }
  | {
      t: "query";
      id: number;
      name: SidebarQueryName;
      args: unknown;
      pending: string[];
    };

export type ReplicaResponse =
  | { t: "ready" }
  | { t: "result"; id: number; rev: number; value: unknown }
  | { t: "error"; id?: number; error: string };

let sdb: Database | null = null;
let db: Db | null = null;
let rev = 0;
const SQL = initSqlJs({ locateFile: (file) => `/${file}` });

/** Same read surface as db.ts `wrap`, with a compiled-statement cache. The
 *  replica only executes forwarded writes through `applyRecs`. */
function wrapReadOnly(d: Database): Db {
  const cache = new Map<string, Statement>();
  const stmt = (sql: string) => {
    let st = cache.get(sql);
    if (!st) cache.set(sql, (st = d.prepare(sql)));
    return st;
  };
  const refuse = () => {
    throw new Error("read replica is read-only");
  };
  return {
    all<T = Row>(sql: string, params: SqlParams = []): T[] {
      const st = stmt(sql);
      try {
        st.bind(params as never);
        const rows: T[] = [];
        while (st.step()) rows.push(st.getAsObject() as T);
        return rows;
      } finally {
        st.reset();
      }
    },
    get<T = Row>(sql: string, params: SqlParams = []): T | undefined {
      const st = stmt(sql);
      try {
        st.bind(params as never);
        return st.step() ? (st.getAsObject() as T) : undefined;
      } finally {
        st.reset();
      }
    },
    run: refuse,
    exec: refuse,
    transaction: refuse,
  };
}

function applyRecs(recs: MutRec[]): void {
  for (const rec of recs) {
    if ("tx" in rec)
      sdb!.run(rec.tx === "begin" ? "BEGIN" : rec.tx === "commit" ? "COMMIT" : "ROLLBACK");
    else if (rec.exec) sdb!.exec(rec.sql);
    else sdb!.run(rec.sql, rec.params as never);
  }
}

const post = (msg: ReplicaResponse) => self.postMessage(msg);

// Messages are handled strictly in arrival order (seed and apply must finish
// before any later query runs), so chain them.
let chain: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<ReplicaRequest>) => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      if (msg.t === "seed") {
        const S = await SQL;
        sdb?.close();
        sdb = new S.Database(msg.snap);
        sdb.run("PRAGMA foreign_keys = OFF");
        db = wrapReadOnly(sdb);
        rev = msg.rev;
        adoptRevision(rev);
        post({ t: "ready" });
      } else if (msg.t === "apply") {
        if (!sdb) throw new Error("replica not seeded");
        applyRecs(msg.recs);
        rev = msg.rev;
        adoptRevision(rev);
      } else {
        if (!db) throw new Error("replica not seeded");
        setPendingHideIds(msg.pending);
        const fn = SIDEBAR_QUERIES[msg.name] as (d: Db, a: unknown) => unknown;
        post({ t: "result", id: msg.id, rev, value: fn(db, msg.args) });
      }
    } catch (err) {
      post({
        t: "error",
        id: msg.t === "query" ? msg.id : undefined,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
};
