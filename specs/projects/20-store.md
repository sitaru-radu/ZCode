# Projects — SQLite persistence (`@zcode/projects-store`)

Status: interface freeze for M1. Package: `apps/zcode-cli/packages/projects-store`.
Owns: `projects.db` schema, migrations, repositories and recovery queries.
Normative companions: `00-overview.md` (decisions D5/D6), `10-domain.md` (domain types this store
persists).

## 1. Purpose and ownership

The mission layer needs durable truth for projects, missions, plans, tasks, workers, events,
validations and reviews. Per decision **D5** that truth lives in **its own SQLite file**
(`projects.db`) and never in the core ZCode database: this package opens, migrates and validates
exactly one file and knows nothing about the core schema, its connection lifecycle or its
migrations. Execution truth (nodes, journal, replay) stays in the `@zcode/dynamic-workflow` journal;
the two stores are linked by `missions.run_id`, not by shared tables.

Consequences that shape everything below:

| Consequence | Rule |
|---|---|
| The file is independent | The store creates missing parent directories and runs its own ledger; it never attaches, copies or reads another database |
| The API is synchronous | `node:sqlite` `DatabaseSync` only — no `await`, no promise-returning method, no background writer |
| The domain is owned elsewhere | Every domain type is imported (type-only) from `@zcode/projects-core`; this package redefines no domain type and holds no domain decision (lifecycle, readiness, gates live in core) |
| One writer per mission process | Concurrency is still safe: WAL for readers, `BEGIN IMMEDIATE` for the read-modify-write sequences |

Database location is a caller decision. Tests use `':memory:'`; the mission runner uses
`<zcode data dir>/projects.db`.

## 2. Schema

One migration (`0001_initial_schema`) creates eight tables. The declarations are frozen in
`src/schema.ts`; see §3 for why editing them is a breaking change.

| Table | Columns |
|---|---|
| `projects` | `id` PK, `name`, `repository_path`, `default_branch`, `status`, `created_at` |
| `missions` | `id` PK, `project_id`, `title`, `objective`, `source_json`, `status`, `phase`, `run_id`, `plan_version`, `created_at`, `started_at`, `completed_at`, `summary`, `block_reason` |
| `mission_plans` | `id` PK, `mission_id`, `version`, `summary`, `assumptions_json`, `affected_areas_json`, `validation_plan_json`, `risks_json`, `tasks_json`, `created_at`, `UNIQUE(mission_id, version)` |
| `tasks` | `id` PK, `mission_id`, `plan_id`, `plan_key`, `plan_index`, `title`, `description`, `deps_json`, `required`, `files_hint_json`, `acceptance_json`, `status`, `worker_id`, `worktree_path`, `branch`, `attempts DEFAULT 0`, `result_json`, `last_error` |
| `workers` | `id` PK, `task_id`, `session_id`, `state`, `model`, `worktree_path`, `started_at`, `completed_at` |
| `mission_events` | `mission_id`, `seq`, `type`, `payload_json`, `run_seq`, `created_at`, `PRIMARY KEY(mission_id, seq)` |
| `validations` | `id` PK, `mission_id`, `task_id`, `phase`, `command`, `exit_code`, `duration_ms`, `result`, `log_ref`, `commit_sha`, `created_at` |
| `reviews` | `id` PK, `mission_id`, `round`, `verdict`, `findings_json`, `reviewed_commit`, `created_at` |
| `schema_migrations` | `id` PK, `checksum`, `applied_at` — the migration ledger, created by the runner |

Indexes (one per real access path):

| Index | Access path |
|---|---|
| `idx_missions_project_status` | missions of a project filtered by status |
| `idx_missions_status_created` | restart-recovery scan (`status IN (non-terminal)` ordered by `created_at`) |
| `idx_tasks_mission_status` | schedulable tasks of a mission |
| `idx_tasks_mission_plan` | `listTasks(missionId)` in plan order (`mission_id`, `plan_index`, `id`) |
| `idx_workers_task` | worker history of a task |
| `idx_validations_mission_created` | validations of a mission in time order |
| `idx_validations_mission_commit` | completion gate: validations recorded against one commit |
| `idx_reviews_mission_round` | review rounds of a mission |

Connection setup, applied on **every** open: `journal_mode = WAL`, `synchronous = NORMAL`,
`foreign_keys = ON`, `busy_timeout = 5000`. WAL is what lets a second process (or a second store
instance, see `tests/persistence.test.ts`) read while the mission runner writes.

Column encoding rules (`src/json.ts`, `src/sql.ts`):

- JSON columns hold the exact domain shape (`MissionSource`, `PlanTask[]`, `TaskResult`,
  `ReviewFinding[]`, event payloads). JSON is transport only; decoding never reorders or renames.
- Booleans are stored as `0`/`1` (`tasks.required`) and come back as booleans.
- Optional domain fields are SQL `NULL` when absent and are returned as **absent properties**, never
  as `undefined`. That is what makes `deepEqual(store.getMission(id), mission)` hold.
- `undefined` is rejected as a bind value (SQLite has no such value); a JSON payload that stringifies
  to `undefined` (for example `undefined`) is rejected with `invalid_argument` rather than silently
  stored as `NULL`.

## 3. Migration policy

`src/migrations.ts` follows the repository pattern
(`packages/services/src/session/tasksDatabase/migrations.ts`):

1. **Frozen definitions.** Every migration is `{ id, checksumInput, apply }`, where `checksumInput` is
   a frozen list of strings (the DDL text plus a semantic version marker). Function source text is
   never hashed — bundlers rewrite it.
2. **Checksum.** `checksum = sha256(JSON.stringify(checksumInput))`, stored in `schema_migrations`
   together with `applied_at`.
3. **Idempotency.** A migration whose id is already recorded is skipped; opening the same database
   twice applies nothing the second time and leaves `applied_at` untouched.
4. **Refusal.** A recorded id with a different checksum aborts the open with
   `ProjectsStoreError` `code: 'checksum_mismatch'` (and `migrationId`). A released migration is
   immutable: the ledger is never repaired, rewritten or downgraded automatically.
5. **Atomicity.** All pending migrations plus their ledger writes run inside one
   `BEGIN IMMEDIATE` transaction; a failure rolls the DDL back (asserted by
   `tests/migrations.test.ts` — "a failed migration leaves no partial schema behind").
6. **Append-only.** Schema changes ship as a new id (`0002_…`); reordering or editing a released
   `checksumInput` is forbidden. `inspectProjectsMigrationKind` and `areProjectsMigrationsApplied`
   are read-only pre-checks that also throw on a mismatch, so a caller cannot "carry on anyway".
7. **Progress facts.** `runProjectsMigrations` returns `{ kind, executedCount, committedCount,
   lastAppliedMigrationId }` and accepts `onProgress(phase, facts)` for startup reporting.

`kind` is `initialize` (empty database), `upgrade` (pending work on an existing one) or `none`
(everything applied).

## 4. API

`new ProjectsStore({ file })` or `new ProjectsStore(':memory:')`. Every method is synchronous.
Failures raise `ProjectsStoreError` with `code` in `not_found | conflict | invalid_argument |
checksum_mismatch`; callers branch on the code, never on message text.

| Group | Methods |
|---|---|
| Projects | `createProject`, `getProject`, `listProjects`, `updateProjectStatus` |
| Missions | `createMission`, `getMission`, `listMissionsByProject`, `listActiveMissions`, `recoverableMissionIds`, `updateMission(id, patch)` |
| Plans | `insertPlan`, `getLatestPlan`, `listPlans` |
| Tasks | `insertTasks`, `getTask`, `listTasks`, `updateTask(id, patch)`, `updateTaskStatus(id, status, patch?)`, `incrementTaskAttempts`, `setTaskWorktree(id, path, branch?)`, `setTaskResult(id, result)` |
| Workers | `insertWorker`, `updateWorkerState(id, state, { completedAt? })`, `getWorker`, `listWorkersByTask` |
| Events | `appendEvent(missionId, type, payload, runSeq?, { createdAt? })`, `listEvents(missionId, afterSeq?)`, `lastEventSeq(missionId)` |
| Evidence | `insertValidation(validation, { commitSha?, createdAt? })`, `listValidations(missionId, commitSha?)`, `insertReview`, `listReviews`, `latestReview` |
| Lifecycle | `close()` — idempotent; any later call fails with `invalid_argument` |

Semantics worth stating explicitly:

- **Patch shape.** A patch is a partial object; omitted keys are untouched, `null` clears an optional
  column, `undefined` is skipped, and an unknown key is rejected (`invalid_argument`) instead of
  being silently dropped. An empty patch is a read.
- **Ordering.** `listProjects`/`listMissionsByProject`(newest first)/`listPlans`(version order)/
  `listTasks`(plan order)/`listWorkersByTask`(oldest first)/`listValidations`(time order)/
  `listReviews`(round order)/`listEvents`(seq order) are all deterministic; every ordering has a
  unique tiebreaker (`id`).
- **Event seq.** `appendEvent` allocates `seq` itself as
  `COALESCE(MAX(seq), 0) + 1` **inside an immediate transaction**. It is monotonic per mission
  starting at 1, independent between missions, never caller-supplied, and continues across restarts.
  `lastEventSeq` returns `0` for a mission without events.
- **Idempotent tasks.** `insertTasks` keeps an existing row for the same task id and returns it
  unchanged (status, attempts, worker kept). Re-materializing the same plan version after a crash
  therefore neither duplicates nor resets progress (`10-domain.md` §5, §7.2).
- **Atomic batches.** `insertTasks` and every migration run are all-or-nothing; a mid-batch failure
  leaves no row behind.
- **Recovery.** `recoverableMissionIds()` and `listActiveMissions()` return missions whose status is
  non-terminal (`draft`, `planning`, `ready`, `running`, `blocked`, `reviewing`, `testing`), oldest
  first — the worklist a restarted mission runner reconciles.

## 5. Invariants

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Opening an initialized database applies nothing and changes no ledger row | `runProjectsMigrations` (#3), test "reopening … is a no-op" |
| I2 | A changed checksum refuses the open (`checksum_mismatch`, with `migrationId`) | `migrationChecksum` comparison, tests "a changed checksum is refused…", "a tampered ledger makes opening the store fail" |
| I3 | A failed migration leaves no partial schema | transaction boundary, test "a failed migration leaves no partial schema behind" |
| I4 | `seq` is allocated by the store, strictly monotonic per mission, unique per mission | `mission_events` PK + immediate transaction, tests "event seq … stays monotonic", "two connections on one file allocate distinct event sequences" |
| I5 | Event seq continues after a restart | test "everything written to a real file survives close and reopen" |
| I6 | `insertTasks` is idempotent per task id and preserves progress | insert-or-keep inside a transaction, test "re-inserting a materialized plan version keeps stored progress" |
| I7 | A batch write never half-applies | `BEGIN IMMEDIATE`/`ROLLBACK`, test "a failing batch insert rolls the whole batch back" |
| I8 | Every entity round-trips exactly, including JSON columns and optional fields | row mappers, tests per entity group (projects, missions, plans, tasks, workers, events, validations, reviews) |
| I9 | Optional fields come back absent, not `undefined` | `withOptional` in `src/rows.ts`, tests "a minimal mission round-trips…", "validations round-trip with and without their optional facts" |
| I10 | Duplicate primary keys are refused (`conflict`), never overwritten | `createProject`, `createMission`, `insertPlan` (mission+version), `insertWorker`, `insertValidation`, `insertReview` |
| I11 | Missing rows raise `not_found` instead of returning a silently empty update | `requireProject`/`requireMission`/`requireTask`/`requireWorker`/`requireValidation`/`requireReview` |
| I12 | Recovery queries return exactly the non-terminal missions, deterministically ordered | `status IN (non-terminal)`, tests in `tests/recovery.test.ts` |
| I13 | Booleans round-trip as booleans, and a non-0/1 value is rejected | `toBoolean` in `src/rows.ts` |
| I14 | The store never opens another database and never touches the core schema | single `DatabaseSync` in `ProjectsStoreBase`, no other `node:sqlite` import except the migration module |

## 6. Deviations from the frozen schema brief (with reasons)

1. **No standalone index on `mission_events(mission_id, seq)`.** `PRIMARY KEY(mission_id, seq)` is a
   real index over exactly those columns; a second one would only add write cost. Same for
   `mission_plans`: `UNIQUE(mission_id, version)` already serves the mission+version path. The brief's
   "obvious access paths" are all covered (see the index table in §2).
2. **No `FOREIGN KEY` clauses.** The frozen DDL declares none, and adding them would change release
   semantics (insert order requirements, delete behaviour). `PRAGMA foreign_keys = ON` is still
   applied, so any future FK is enforced from day one. Cross-table referential integrity
   (mission→project, task→mission, task→plan, worker→task, evidence→mission) is therefore the mission
   layer's responsibility; the store enforces identity, idempotency and ordering invariants (§5).
3. **Extra read-back fields.** The brief's tables carry `tasks.plan_index`,
   `validations.commit_sha` and `validations.created_at`, which the domain types of
   `10-domain.md` §1 have no place for. Instead of discarding them on read, the store returns
   `StoredTask = Task & { planIndex }` and `StoredValidation = Validation & { commitSha?, createdAt }`.
   Both are structurally assignable to the domain types, so core functions accept them unchanged, and
   the completion gate can match validations per commit (§4).
4. **`insertTasks` is insert-or-keep, not plain insert.** Required by `10-domain.md` §5/§7.2
   (idempotent re-materialization) and by restart recovery; a plain insert would make recovery throw.
5. **Local status constants.** `TERMINAL_MISSION_STATUSES` / `NON_TERMINAL_MISSION_STATUSES` are
   declared locally (typed `satisfies readonly MissionStatus[]`) instead of importing core's runtime
   values, so this package keeps **type-only** dependencies on `@zcode/projects-core`: its tests run
   without core's build output. The values mirror `lifecycle.ts`'s terminal list exactly.
6. **Store-local types.** `MissionEventRecord`, `TaskInsert`, `StoredTask`, `StoredValidation`,
   `MissionPatch`, `TaskPatch`, `TaskStatusPatch`, `ValidationExtras`, `AppendEventOptions`,
   `WorkerStateOptions` are persistence concerns the pure domain has no opinion about; they are
   declared here and are *not* redefinitions of core types.
7. **Signature details.** `updateMission`/`updateTask` take `(id, patch)` (the brief writes
   "updateMission(patch)"); `insertValidation` takes commit scope as a second argument;
   `appendEvent` takes its optional `runSeq` before an options object; `listMissionsByProject` is
   newest-first while the recovery queries are oldest-first.
8. **`listActiveMissions` filter.** Implemented as `status IN (non-terminal)` — the complementary
   "non-terminal status" definition from `10-domain.md` §2 — rather than
   `status NOT IN (terminal)`, so an unknown status value written by a future version is not
   misclassified as active.

## 7. Verification

```bash
pnpm --filter @zcode/projects-store lint        # oxlint, 0 warnings, 0 errors
pnpm --filter @zcode/projects-store typecheck   # tsc --noEmit -p tsconfig.tests.json
pnpm --filter @zcode/projects-store test        # node --import tsx --test "tests/**/*.test.ts"
```

Test layout: `tests/migrations.test.ts` (policy §3), `tests/store.test.ts` (projects, missions,
plans, tasks), `tests/execution.test.ts` (workers, events), `tests/evidence.test.ts` (validations,
reviews), `tests/recovery.test.ts` (restart worklist), `tests/persistence.test.ts` (real temp file,
reopen, second connection), `tests/smoke.test.ts` (public surface of the composed class).

Source layout: `schema.ts` (frozen DDL), `migrations.ts` (ledger), `domain.ts` (type barrel +
store-local types), `rows.ts` (row mappers), `sql.ts` (bind/update builders), `json.ts` (JSON
codecs), `errors.ts` (typed errors), `store-base.ts` → `store-projects.ts` → `store-plans.ts` →
`store-execution.ts` → `store-evidence.ts` → `store.ts` (composed `ProjectsStore`). Each file stays
under the repository's 400-line gate.
