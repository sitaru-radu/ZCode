/**
 * Frozen DDL for the Projects store — its own SQLite file (`projects.db`), decision D5.
 *
 * `@zcode/projects-store` never opens, migrates or reads the core ZCode database: mission truth
 * lives here, execution truth stays in the workflow journal.
 *
 * The declarations below are FROZEN: `src/migrations.ts` hashes them into the migration ledger, so
 * editing a released declaration changes its checksum and existing databases refuse to open. Schema
 * changes must therefore ship as a NEW migration, never as an edit of these strings.
 */

/** Table declarations of migration `0001_initial_schema`. */
export const PROJECT_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repository_path TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    source_json TEXT NOT NULL,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    run_id TEXT,
    plan_version INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    summary TEXT,
    block_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS mission_plans (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    summary TEXT NOT NULL,
    assumptions_json TEXT NOT NULL,
    affected_areas_json TEXT NOT NULL,
    validation_plan_json TEXT NOT NULL,
    risks_json TEXT NOT NULL,
    tasks_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(mission_id, version)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    plan_key TEXT NOT NULL,
    plan_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    deps_json TEXT NOT NULL,
    required INTEGER NOT NULL,
    files_hint_json TEXT NOT NULL,
    acceptance_json TEXT NOT NULL,
    status TEXT NOT NULL,
    worker_id TEXT,
    worktree_path TEXT,
    branch TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    state TEXT NOT NULL,
    model TEXT,
    worktree_path TEXT NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS mission_events (
    mission_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    run_seq INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(mission_id, seq)
  );

  CREATE TABLE IF NOT EXISTS validations (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    task_id TEXT,
    phase TEXT NOT NULL,
    command TEXT NOT NULL,
    exit_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    result TEXT NOT NULL,
    log_ref TEXT,
    commit_sha TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    findings_json TEXT NOT NULL,
    reviewed_commit TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

/** Index declarations of migration `0001_initial_schema` (one per real access path). */
export const PROJECT_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_missions_project_status ON missions(project_id, status);
  CREATE INDEX IF NOT EXISTS idx_missions_status_created ON missions(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_mission_status ON tasks(mission_id, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_mission_plan ON tasks(mission_id, plan_index, id);
  CREATE INDEX IF NOT EXISTS idx_workers_task ON workers(task_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_validations_mission_created ON validations(mission_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_validations_mission_commit ON validations(mission_id, commit_sha);
  CREATE INDEX IF NOT EXISTS idx_reviews_mission_round ON reviews(mission_id, round);
`;

/** Ledger of applied migrations; owned by the migration runner, not by migration `0001`. */
export const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
`;

/** Connection setup, applied on every open. */
export const PROJECT_STORE_PRAGMAS: readonly string[] = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
];

/** Table names created by migration `0001_initial_schema`, in dependency-free order. */
export const PROJECT_STORE_TABLES: readonly string[] = [
  "projects",
  "missions",
  "mission_plans",
  "tasks",
  "workers",
  "mission_events",
  "validations",
  "reviews",
];

/** Index names created by migration `0001_initial_schema`. */
export const PROJECT_STORE_INDEXES: readonly string[] = [
  "idx_missions_project_status",
  "idx_missions_status_created",
  "idx_tasks_mission_status",
  "idx_tasks_mission_plan",
  "idx_workers_task",
  "idx_validations_mission_created",
  "idx_validations_mission_commit",
  "idx_reviews_mission_round",
];
