import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { checksumMismatch, ProjectsStoreError } from "./errors.js";
import {
  PROJECT_INDEXES_SQL,
  PROJECT_TABLES_SQL,
  SCHEMA_MIGRATIONS_DDL,
} from "./schema.js";

/**
 * Checksummed migrations for `projects.db`, following the repository pattern
 * (`packages/services/src/session/tasksDatabase/migrations.ts`).
 *
 * Policy (normative, see specs/projects/20-store.md §3):
 * - Each migration is identified by a stable id and hashes a FROZEN list of inputs (DDL text and
 *   semantic version markers). Function source text is never hashed — bundlers rewrite it.
 * - A migration runs exactly once, inside a transaction, and its checksum is recorded in
 *   `schema_migrations`.
 * - Re-running with an already-applied id is a no-op when the checksum matches and a hard failure
 *   (`checksum_mismatch`) when it does not: a released migration is immutable in place.
 * - Schema changes ship as a NEW migration id; released `checksumInput` arrays are frozen.
 */

/** Progress/result facts of a migration run. */
export interface ProjectsMigrationFacts {
  kind: "none" | "initialize" | "upgrade";
  executedCount: number;
  committedCount: number;
  lastAppliedMigrationId: string | null;
}

export interface ProjectsMigration {
  readonly id: string;
  readonly checksumInput: readonly unknown[];
  readonly apply: (db: DatabaseSync) => void;
}

/** The migration list. Append-only: never edit or reorder a released entry. */
const migrations: readonly ProjectsMigration[] = [
  {
    id: "0001_initial_schema",
    checksumInput: ["projects-store/initial-schema-v1", PROJECT_TABLES_SQL, PROJECT_INDEXES_SQL],
    apply: (db) => {
      db.exec(PROJECT_TABLES_SQL);
      db.exec(PROJECT_INDEXES_SQL);
    },
  },
];

export interface RunProjectsMigrationsOptions {
  /** Set when the caller already opened a transaction that must stay open. */
  transactionOpen?: boolean;
  /** Pre-computed facts, so a caller can publish progress without re-inspecting the ledger. */
  migration?: ProjectsMigrationFacts;
  onProgress?: (phase: "migrating" | "committing", facts: ProjectsMigrationFacts) => void;
}

export function migrationIds(): string[] {
  return migrations.map((migration) => migration.id);
}

export function migrationChecksum(migration: ProjectsMigration): string {
  return createHash("sha256").update(JSON.stringify(migration.checksumInput)).digest("hex");
}

/** Runs every pending migration; idempotent and safe to call on every open. */
export function runProjectsMigrations(
  db: DatabaseSync,
  options: RunProjectsMigrationsOptions = {},
): ProjectsMigrationFacts {
  const facts: ProjectsMigrationFacts = options.migration ?? {
    kind: "none",
    executedCount: 0,
    committedCount: 0,
    lastAppliedMigrationId: null,
  };
  const ownsTransaction = !options.transactionOpen && !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  let currentMigrationId: string | undefined;
  try {
    if (!options.migration) facts.kind = inspectProjectsMigrationKind(db);
    db.exec(SCHEMA_MIGRATIONS_DDL);
    const baseline = db
      .prepare("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1")
      .get() as { id?: string } | undefined;
    facts.lastAppliedMigrationId = baseline?.id ?? null;
    for (const migration of migrations) {
      currentMigrationId = migration.id;
      const checksum = migrationChecksum(migration);
      const applied = db
        .prepare("SELECT checksum FROM schema_migrations WHERE id = ?")
        .get(migration.id) as { checksum?: string } | undefined;
      if (applied) {
        if (applied.checksum !== checksum) throw checksumMismatch(migration.id);
        continue;
      }
      if (facts.kind === "none") facts.kind = "upgrade";
      options.onProgress?.("migrating", { ...facts });
      migration.apply(db);
      db.prepare("INSERT INTO schema_migrations(id, checksum, applied_at) VALUES(?,?,?)").run(
        migration.id,
        checksum,
        Date.now(),
      );
      facts.executedCount += 1;
    }
    options.onProgress?.("committing", { ...facts });
    if (ownsTransaction) db.exec("COMMIT");
    facts.committedCount = facts.executedCount;
    return facts;
  } catch (error) {
    // A failing rollback must not replace the error that caused the migration to fail.
    if (ownsTransaction) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {
        /* The connection has to be discarded by the caller. */
      }
    }
    if (error && typeof error === "object" && currentMigrationId !== undefined) {
      Object.assign(error, { migrationId: currentMigrationId });
    }
    throw error;
  }
}

/** Read-only ledger inspection; throws on a checksum mismatch so callers cannot carry on anyway. */
export function inspectProjectsMigrationKind(db: DatabaseSync): ProjectsMigrationFacts["kind"] {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  let pending = false;
  for (const migration of migrations) {
    const row = hasLedger
      ? (db.prepare("SELECT checksum FROM schema_migrations WHERE id = ?").get(migration.id) as
          | { checksum?: string }
          | undefined)
      : undefined;
    if (!row) pending = true;
    else if (row.checksum !== migrationChecksum(migration)) throw checksumMismatch(migration.id);
  }
  if (!pending) return "none";
  const hasUserTables = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table'
       AND name NOT IN ('schema_migrations', 'sqlite_sequence') LIMIT 1`,
    )
    .get();
  return hasUserTables ? "upgrade" : "initialize";
}

/** True only when every migration of this build is applied with the expected checksum. */
export function areProjectsMigrationsApplied(db: DatabaseSync): boolean {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (!hasLedger) return false;
  for (const migration of migrations) {
    const row = db
      .prepare("SELECT checksum FROM schema_migrations WHERE id = ?")
      .get(migration.id) as { checksum?: string } | undefined;
    if (!row) return false;
    if (row.checksum !== migrationChecksum(migration)) throw checksumMismatch(migration.id);
  }
  return true;
}

/** True when `error` was raised by this module's checksum guard. */
export function isChecksumMismatch(error: unknown): boolean {
  return error instanceof ProjectsStoreError && error.code === "checksum_mismatch";
}
