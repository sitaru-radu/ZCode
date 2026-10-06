import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  areProjectsMigrationsApplied,
  inspectProjectsMigrationKind,
  isChecksumMismatch,
  migrationIds,
  PROJECT_STORE_INDEXES,
  PROJECT_STORE_TABLES,
  ProjectsStore,
  runProjectsMigrations,
} from '../src/index.js';

function tempDatabaseFile(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'projects-store-migrations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'projects.db');
}

function objectNames(db: DatabaseSync, type: string): string[] {
  return db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
    .all(type)
    .map((row) => String(row.name));
}

test('the first open applies migration 0001 and records one ledger row', (t) => {
  const file = tempDatabaseFile(t);
  const initial = new ProjectsStore({ file });
  initial.close();

  const db = new DatabaseSync(file);
  try {
    const tables = objectNames(db, 'table');
    for (const table of PROJECT_STORE_TABLES) assert.ok(tables.includes(table), table);
    const indexes = objectNames(db, 'index');
    for (const index of PROJECT_STORE_INDEXES) assert.ok(indexes.includes(index), index);

    const ledger = db.prepare('SELECT id, checksum, applied_at FROM schema_migrations').all();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.id, migrationIds()[0]);
    assert.equal(String(ledger[0]?.checksum).length, 64);
    assert.ok(Number(ledger[0]?.applied_at) > 0);
  } finally {
    db.close();
  }
});

test('the schema keeps the declared column and key shapes', (t) => {
  const file = tempDatabaseFile(t);
  new ProjectsStore(file).close();

  const db = new DatabaseSync(file);
  try {
    const columns = (table: string) =>
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;
    const eventKeys = columns('mission_events').filter((column) => column.pk > 0);
    assert.deepEqual(
      eventKeys.map((column) => column.name),
      ['mission_id', 'seq'],
    );
    const attempts = columns('tasks').find((column) => column.name === 'attempts');
    assert.equal(attempts?.notnull, 1);
    assert.equal(attempts?.type, 'INTEGER');
    const planVersion = columns('missions').find((column) => column.name === 'plan_version');
    assert.equal(planVersion?.notnull, 0);
  } finally {
    db.close();
  }
});

test('reopening an initialized database is a no-op (idempotent migrations)', (t) => {
  const file = tempDatabaseFile(t);
  const first = new ProjectsStore({ file });
  first.createProject({
    id: 'prj_1',
    name: 'once',
    repositoryPath: '/tmp/repo',
    defaultBranch: 'main',
    status: 'active',
    createdAt: 1,
  });
  first.close();

  const raw = new DatabaseSync(file);
  const appliedAt = raw.prepare('SELECT applied_at FROM schema_migrations').get()?.applied_at;
  raw.close();

  const second = new ProjectsStore({ file });
  try {
    assert.equal(second.listProjects().length, 1);
    const again = new DatabaseSync(file);
    try {
      const rows = again.prepare('SELECT id, applied_at FROM schema_migrations').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.applied_at, appliedAt);
    } finally {
      again.close();
    }
  } finally {
    second.close();
  }

  const raw2 = new DatabaseSync(file);
  try {
    assert.equal(areProjectsMigrationsApplied(raw2), true);
    assert.equal(inspectProjectsMigrationKind(raw2), 'none');
    const facts = runProjectsMigrations(raw2);
    assert.equal(facts.kind, 'none');
    assert.equal(facts.executedCount, 0);
    assert.equal(facts.committedCount, 0);
  } finally {
    raw2.close();
  }
});

test('migrating an empty database reports initialize, then upgrade work is reported once', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.equal(inspectProjectsMigrationKind(db), 'initialize');
    const facts = runProjectsMigrations(db);
    assert.equal(facts.kind, 'initialize');
    assert.equal(facts.executedCount, 1);
    assert.equal(facts.committedCount, 1);
    assert.equal(facts.lastAppliedMigrationId, null);
  } finally {
    db.close();
  }
});

test('a changed checksum is refused instead of being re-applied', () => {
  const db = new DatabaseSync(':memory:');
  try {
    runProjectsMigrations(db);
    const [firstId] = migrationIds();
    assert.ok(firstId);
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE id = ?').run('tampered', firstId);

    assert.throws(
      () => runProjectsMigrations(db),
      (error: unknown) => isChecksumMismatch(error),
      'running migrations must refuse a changed checksum',
    );
    assert.throws(() => inspectProjectsMigrationKind(db), (error: unknown) =>
      isChecksumMismatch(error),
    );
    assert.throws(() => areProjectsMigrationsApplied(db), (error: unknown) =>
      isChecksumMismatch(error),
    );
  } finally {
    db.close();
  }
});

test('a tampered ledger makes opening the store fail', (t) => {
  const file = tempDatabaseFile(t);
  new ProjectsStore(file).close();

  const db = new DatabaseSync(file);
  const [firstId] = migrationIds();
  assert.ok(firstId);
  db.prepare('UPDATE schema_migrations SET checksum = ? WHERE id = ?').run('tampered', firstId);
  db.close();

  assert.throws(
    () => new ProjectsStore({ file }),
    (error: unknown) => isChecksumMismatch(error) && String(error).includes(firstId),
  );
});

test('a file database runs in WAL mode with foreign keys enforced', (t) => {
  const file = tempDatabaseFile(t);
  new ProjectsStore(file).close();

  const db = new DatabaseSync(file);
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  } finally {
    db.close();
  }
});

test('a failed migration leaves no partial schema behind', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() =>
      runProjectsMigrations(db, {
        onProgress: (phase) => {
          if (phase === 'committing') throw new Error('synthetic failure before commit');
        },
      }),
    );
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get(),
      undefined,
      'the transaction must roll the DDL back',
    );
    assert.equal(db.isTransaction, false);
  } finally {
    db.close();
  }
});
