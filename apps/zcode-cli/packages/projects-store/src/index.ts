/**
 * @zcode/projects-store — public entry point.
 *
 * The exported surface is defined by specs/projects/ (see specs/projects/20-store.md); keep this file
 * a re-export barrel so module boundaries stay visible and files stay under the repository's
 * 400-line gate. Domain types live in `@zcode/projects-core` and are only re-exported here.
 */
export const packageName = "@zcode/projects-store" as const;

export { ProjectsStore } from "./store.js";

export type { ProjectsApi } from "./store-projects.js";
export type { PlansApi } from "./store-plans.js";
export type { ExecutionApi } from "./store-execution.js";
export type { EvidenceApi } from "./store-evidence.js";

export {
  ProjectsStoreError,
  isProjectsStoreError,
  type ProjectsStoreErrorCode,
  type ProjectsStoreErrorOptions,
} from "./errors.js";

export {
  PROJECT_INDEXES_SQL,
  PROJECT_STORE_INDEXES,
  PROJECT_STORE_PRAGMAS,
  PROJECT_STORE_TABLES,
  PROJECT_TABLES_SQL,
  SCHEMA_MIGRATIONS_DDL,
} from "./schema.js";

export {
  areProjectsMigrationsApplied,
  inspectProjectsMigrationKind,
  isChecksumMismatch,
  migrationChecksum,
  migrationIds,
  runProjectsMigrations,
  type ProjectsMigration,
  type ProjectsMigrationFacts,
  type RunProjectsMigrationsOptions,
} from "./migrations.js";

export {
  NON_TERMINAL_MISSION_STATUSES,
  TERMINAL_MISSION_STATUSES,
} from "./domain.js";

export type {
  AppendEventOptions,
  EpochMs,
  Mission,
  MissionEventRecord,
  MissionId,
  MissionPatch,
  MissionPhase,
  MissionPlan,
  MissionSource,
  MissionStatus,
  PlanId,
  PlanTask,
  Project,
  ProjectId,
  ProjectsStoreOptions,
  ProjectStatus,
  Review,
  ReviewFinding,
  StoredTask,
  StoredValidation,
  Task,
  TaskId,
  TaskInsert,
  TaskPatch,
  TaskResult,
  TaskStatus,
  TaskStatusPatch,
  Validation,
  ValidationExtras,
  Worker,
  WorkerId,
  WorkerState,
  WorkerStateOptions,
} from "./domain.js";
