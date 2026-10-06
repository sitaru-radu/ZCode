import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import type { ProjectsStoreOptions } from "./domain.js";
import { invalidArgument } from "./errors.js";
import { runProjectsMigrations } from "./migrations.js";
import { PROJECT_STORE_PRAGMAS } from "./schema.js";

/**
 * Connection, schema and query plumbing shared by every store layer.
 *
 * The public store is assembled from thin layers (`store-projects`, `store-plans`,
 * `store-execution`, `store-evidence`) so each file stays cohesive and under the repository's
 * 400-line gate; see `store.ts` for the composed class. Nothing here talks to the core ZCode
 * database: one file, one schema, one migration ledger (decision D5).
 */
export class ProjectsStoreBase {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  constructor(options: ProjectsStoreOptions | string) {
    const file = typeof options === "string" ? options : options.file;
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      // WAL + foreign_keys are per-connection facts, so they are applied on every open, not once.
      for (const pragma of PROJECT_STORE_PRAGMAS) this.db.exec(pragma);
      runProjectsMigrations(this.db);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        /* The original failure is the one worth reporting. */
      }
      throw error;
    }
  }

  /** Closes the connection; idempotent so `finally` blocks can call it unconditionally. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  /** Runs `work` in a transaction; joins an already open one instead of nesting. */
  protected transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
      } catch {
        /* Keep the error that aborted the transaction. */
      }
      throw error;
    }
  }

  protected prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      if (this.closed) throw invalidArgument("projects store is closed");
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  protected query<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.prepare(sql).all(...params) as unknown as T[];
  }

  protected queryOne<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.prepare(sql).get(...params) as unknown as T | undefined;
  }

  protected execute(sql: string, ...params: SQLInputValue[]): void {
    this.prepare(sql).run(...params);
  }
}
