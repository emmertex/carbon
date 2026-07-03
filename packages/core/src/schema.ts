// Schema is applied by the migration runner (see migrate.ts). Each migration is
// additive and idempotent where practical; the runner tracks the applied version
// in the `meta` table so upgrades never silently wipe data.

export interface Migration {
  version: number;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS items (
        id            TEXT PRIMARY KEY,
        parent_id     TEXT,
        type          TEXT NOT NULL CHECK(type IN ('project','task')),
        title         TEXT NOT NULL DEFAULT '',
        note          TEXT,
        status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','dropped')),
        flagged       INTEGER NOT NULL DEFAULT 0,
        priority      INTEGER NOT NULL DEFAULT 0,
        defer_date    TEXT,
        due_date      TEXT,
        completed_at  TEXT,
        review_interval INTEGER,
        reviewed_at   TEXT,
        recurrence    TEXT,
        color         TEXT,
        sort_order    REAL NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        deleted       INTEGER NOT NULL DEFAULT 0,
        -- per-field last-write clocks as JSON: { field: { ts, dev } } — drives LWW merge
        clocks        TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
      CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
      CREATE INDEX IF NOT EXISTS idx_items_order ON items(sort_order);

      -- Append-only operation log; the source of truth that syncs between peers.
      CREATE TABLE IF NOT EXISTS ops (
        id         TEXT PRIMARY KEY,
        item_id    TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        device_id  TEXT NOT NULL,
        fields     TEXT NOT NULL,
        -- client bookkeeping: 0 = not yet pushed to server. Server ignores it.
        synced     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ops_item ON ops(item_id);
      CREATE INDEX IF NOT EXISTS idx_ops_ts ON ops(ts);
      CREATE INDEX IF NOT EXISTS idx_ops_synced ON ops(synced);

      CREATE TABLE IF NOT EXISTS tags (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        color      TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS item_tags (
        item_id TEXT NOT NULL,
        tag_id  TEXT NOT NULL,
        PRIMARY KEY (item_id, tag_id)
      );
      CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);

      CREATE TABLE IF NOT EXISTS time_logs (
        id         TEXT PRIMARY KEY,
        item_id    TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time   TEXT,
        note       TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_time_logs_item ON time_logs(item_id);
    `,
  },
];

MIGRATIONS.push({
  version: 2,
  // The multi-user / agent-ready model (see ROADMAP.md). Tables are created now so
  // the schema is stable; sync wiring + UI for them lands in Phase C/D. Item columns
  // are additive (owner_id = Phase C, geo/alerts = Phase E).
  up: `
    ALTER TABLE items ADD COLUMN owner_id TEXT;
    ALTER TABLE items ADD COLUMN geo TEXT;       -- JSON {lat,lng,radius,label}
    ALTER TABLE items ADD COLUMN alerts TEXT;    -- JSON array of ISO datetimes

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      display_name  TEXT,
      role          TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
      is_bot        INTEGER NOT NULL DEFAULT 0,
      avatar_color  TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      deleted       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS shares (
      id          TEXT PRIMARY KEY,
      item_id     TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      permission  TEXT NOT NULL DEFAULT 'read' CHECK(permission IN ('read','write')),
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted     INTEGER NOT NULL DEFAULT 0,
      UNIQUE(item_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shares_item ON shares(item_id);
    CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);

    CREATE TABLE IF NOT EXISTS assignees (
      id          TEXT PRIMARY KEY,
      item_id     TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted     INTEGER NOT NULL DEFAULT 0,
      UNIQUE(item_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assignees_item ON assignees(item_id);

    CREATE TABLE IF NOT EXISTS comments (
      id          TEXT PRIMARY KEY,
      item_id     TEXT NOT NULL,
      author_id   TEXT,
      body        TEXT NOT NULL DEFAULT '',
      mentions    TEXT,                 -- JSON array of user ids
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id);

    CREATE TABLE IF NOT EXISTS attachments (
      id          TEXT PRIMARY KEY,
      parent_type TEXT NOT NULL CHECK(parent_type IN ('item','comment')),
      parent_id   TEXT NOT NULL,
      filename    TEXT NOT NULL,
      mime_type   TEXT,
      size        INTEGER NOT NULL DEFAULT 0,
      hash        TEXT NOT NULL,        -- content-addressed blob reference
      created_by  TEXT,
      created_at  TEXT NOT NULL,
      deleted     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_parent ON attachments(parent_type, parent_id);
  `,
});

MIGRATIONS.push({
  version: 3,
  // Append-only log for row-level entities (shares, assignees, …) that sync as
  // LWW records rather than through the item field-level op-log. Same rowid-cursor
  // model as `ops`, so it is clock-skew-safe.
  up: `
    CREATE TABLE IF NOT EXISTS record_ops (
      id         TEXT PRIMARY KEY,
      entity     TEXT NOT NULL,
      row_id     TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      device_id  TEXT NOT NULL,
      data       TEXT NOT NULL,
      synced     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_record_ops_synced ON record_ops(synced);
    CREATE INDEX IF NOT EXISTS idx_record_ops_entity ON record_ops(entity);
  `,
});

MIGRATIONS.push({
  version: 4,
  // Denormalize the owning task onto attachments so record-op sync scoping is
  // uniform (every synced record carries item_id).
  up: `ALTER TABLE attachments ADD COLUMN item_id TEXT;`,
});

MIGRATIONS.push({
  version: 5,
  // Attribute time logs to a user so time can be summarized per person; time logs
  // now sync as records (entity 'timelog').
  up: `ALTER TABLE time_logs ADD COLUMN user_id TEXT;`,
});

MIGRATIONS.push({
  version: 6,
  // Make tags & tag links syncable (entities 'tag' / 'item_tag'): add LWW
  // updated_at + tombstone columns, and switch tags to deterministic,
  // content-addressed ids ('t:'+lower(name)) so the same tag created on two
  // devices converges instead of colliding on UNIQUE(name).
  up: `
    ALTER TABLE tags ADD COLUMN updated_at TEXT;
    ALTER TABLE tags ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
    UPDATE tags SET updated_at = created_at WHERE updated_at IS NULL;

    ALTER TABLE item_tags ADD COLUMN updated_at TEXT;
    ALTER TABLE item_tags ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
    UPDATE item_tags SET updated_at = '1970-01-01T00:00:00.000Z' WHERE updated_at IS NULL;

    -- Repoint existing links to deterministic tag ids (merge dupes via OR REPLACE).
    UPDATE OR REPLACE item_tags
      SET tag_id = 't:' || lower(trim((SELECT name FROM tags WHERE tags.id = item_tags.tag_id)))
      WHERE tag_id IN (SELECT id FROM tags WHERE id NOT LIKE 't:%');

    -- Recreate tag rows under deterministic ids (name UNIQUE conflict drops the old row).
    INSERT OR REPLACE INTO tags (id, name, color, created_at, updated_at, deleted)
      SELECT 't:' || lower(trim(name)), name, color, created_at, updated_at, deleted
      FROM tags WHERE id NOT LIKE 't:%';
    DELETE FROM tags WHERE id NOT LIKE 't:%';
  `,
});

MIGRATIONS.push({
  version: 7,
  // Optional push-reminder time for tasks with a due date.
  up: `ALTER TABLE items ADD COLUMN reminder_at TEXT;`,
});

MIGRATIONS.push({
  version: 8,
  // Estimated effort in minutes.
  up: `ALTER TABLE items ADD COLUMN estimate_minutes INTEGER;`,
});

MIGRATIONS.push({
  version: 9,
  // Time tracking v2: sessions (project), task segments, and pauses.
  // `kind` = 'session' | 'task' | 'pause'; `session_id` links segments/pauses to a
  // session. Existing per-item timers become standalone task segments.
  up: `
    ALTER TABLE time_logs ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';
    ALTER TABLE time_logs ADD COLUMN session_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_time_logs_session ON time_logs(session_id);
    CREATE INDEX IF NOT EXISTS idx_time_logs_open ON time_logs(end_time);
  `,
});

MIGRATIONS.push({
  version: 10,
  // Tombstone for time logs so deletions sync.
  up: `ALTER TABLE time_logs ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;`,
});

MIGRATIONS.push({
  version: 11,
  // Optional custom avatar initial (letter) per user; colour already exists.
  up: `ALTER TABLE users ADD COLUMN avatar_initial TEXT;`,
});

MIGRATIONS.push({
  version: 12,
  // Stage 2 planning: per-user curated Plan (record-synced) + budget settings.
  up: `
    CREATE TABLE IF NOT EXISTS plan (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      item_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_plan_user ON plan(user_id);
    ALTER TABLE users ADD COLUMN plan_startup_min INTEGER;
    ALTER TABLE users ADD COLUMN plan_default_estimate_min INTEGER;
  `,
});

MIGRATIONS.push({
  version: 13,
  // Hierarchical tags: a tag's `name` is now a colon-delimited path
  // ("Shopping:Coles:FreshGoods") and `status` lets a tag be put on hold
  // (OmniFocus-style) to defer its tasks out of Today/Available. Existing flat
  // tags are already valid single-segment paths, so no data rewrite is needed.
  up: `ALTER TABLE tags ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`,
});

MIGRATIONS.push({
  version: 14,
  // Availability / blocking model (OmniFocus + Gantt). `order_mode` makes a
  // container sequential (only the first incomplete child is available),
  // parallel (all available — the default and previous behaviour), or a
  // single-action list. `item_deps` is a directed predecessor->successor edge
  // ("pred_id blocks succ_id"), synced row-level like item_tags.
  up: `
    ALTER TABLE items ADD COLUMN order_mode TEXT NOT NULL DEFAULT 'parallel';

    CREATE TABLE IF NOT EXISTS item_deps (
      pred_id    TEXT NOT NULL,
      succ_id    TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pred_id, succ_id)
    );
    CREATE INDEX IF NOT EXISTS idx_item_deps_pred ON item_deps(pred_id);
    CREATE INDEX IF NOT EXISTS idx_item_deps_succ ON item_deps(succ_id);
  `,
});

MIGRATIONS.push({
  version: 15,
  // Sidebar folders: a visual-only grouping layer. A folder is an `items` row with
  // type='folder'; projects reference their folder via the new `folder_id` column
  // (NULL = top-level). folder_id is deliberately separate from parent_id so folders
  // never touch task nesting / availability.
  //
  // SQLite can't relax the type CHECK in place, so the items table is rebuilt with
  // CHECK(type IN ('project','task','folder')) and the folder_id column. There are no
  // SQL foreign keys, triggers, or views referencing items, and the whole migration
  // runs inside migrate()'s single transaction, so a failure rolls back cleanly.
  up: `
    CREATE TABLE items_v15 (
      id            TEXT PRIMARY KEY,
      parent_id     TEXT,
      type          TEXT NOT NULL CHECK(type IN ('project','task','folder')),
      title         TEXT NOT NULL DEFAULT '',
      note          TEXT,
      status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','dropped')),
      flagged       INTEGER NOT NULL DEFAULT 0,
      priority      INTEGER NOT NULL DEFAULT 0,
      defer_date    TEXT,
      due_date      TEXT,
      completed_at  TEXT,
      review_interval INTEGER,
      reviewed_at   TEXT,
      recurrence    TEXT,
      color         TEXT,
      sort_order    REAL NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      deleted       INTEGER NOT NULL DEFAULT 0,
      clocks        TEXT NOT NULL DEFAULT '{}',
      owner_id      TEXT,
      geo           TEXT,
      alerts        TEXT,
      reminder_at   TEXT,
      estimate_minutes INTEGER,
      order_mode    TEXT NOT NULL DEFAULT 'parallel',
      folder_id     TEXT
    );

    INSERT INTO items_v15 (
      id, parent_id, type, title, note, status, flagged, priority, defer_date,
      due_date, completed_at, review_interval, reviewed_at, recurrence, color,
      sort_order, created_at, updated_at, deleted, clocks, owner_id, geo, alerts,
      reminder_at, estimate_minutes, order_mode
    )
    SELECT
      id, parent_id, type, title, note, status, flagged, priority, defer_date,
      due_date, completed_at, review_interval, reviewed_at, recurrence, color,
      sort_order, created_at, updated_at, deleted, clocks, owner_id, geo, alerts,
      reminder_at, estimate_minutes, order_mode
    FROM items;

    DROP TABLE items;
    ALTER TABLE items_v15 RENAME TO items;

    CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
    CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
    CREATE INDEX IF NOT EXISTS idx_items_order ON items(sort_order);
    CREATE INDEX IF NOT EXISTS idx_items_folder ON items(folder_id);
  `,
});

MIGRATIONS.push({
  version: 16,
  // Powerful tags: tags gain manual ordering (sort_order, like items) and an
  // optional location (geo, same JSON shape as items.geo). sort_order lets the
  // sidebar drag-reorder/reparent tags; geo lets a tag carry a location that a
  // task without its own location falls back to (task > tag > project).
  up: `
    ALTER TABLE tags ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;
    ALTER TABLE tags ADD COLUMN geo TEXT;
  `,
});

MIGRATIONS.push({
  version: 17,
  // System-notice marker: a first-class item field flagging an item as a
  // Carbon-authored task (federation offers, billing issues, invoices, …).
  // NULL = an ordinary user task. A plain nullable TEXT column — no CHECK
  // constraint, so no table rebuild; it flows through the op-log like any field.
  up: `ALTER TABLE items ADD COLUMN sys_kind TEXT;`,
});

MIGRATIONS.push({
  version: 18,
  // Federation shadow users: a user row can represent a remote peer's user so
  // shares/assignees/comments render against them like any local user.
  // `is_remote=1` + `home_server=<host>`; the row's id is namespaced
  // `remote:<host>:<remoteUserId>` (see federation.ts provisionShadowUser).
  // Plain ALTER TABLE — these ride the users record-op stream like the other
  // user columns, so a shadow user materialises on every client.
  up: `
    ALTER TABLE users ADD COLUMN is_remote INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN home_server TEXT;
  `,
});

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
