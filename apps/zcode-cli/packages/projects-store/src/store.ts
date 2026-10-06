import { EvidenceMethods } from "./store-evidence.js";

/**
 * Synchronous SQLite store for the mission layer — its own file (`projects.db`), decision D5.
 *
 * The class is assembled from cohesive layers, each in its own file so every module stays under the
 * repository's 400-line gate:
 *
 *   ProjectsStoreBase   connection, pragmas, migrations, statement cache, transactions
 *   ProjectMethods      projects, missions (lifecycle truth)
 *   PlanMethods         mission plans, task graph
 *   ExecutionMethods    workers, mission events
 *   EvidenceMethods     validations, reviews
 *
 * Every method is synchronous by design (`DatabaseSync`, no async in the store) and every
 * multi-statement write runs inside a transaction, so a crash can neither duplicate a task nor leave
 * a half-written mission. Cross-process writers are serialized by WAL plus `BEGIN IMMEDIATE`.
 *
 * The store persists the exact domain shapes of `@zcode/projects-core`; JSON columns are transport
 * only, and optional domain fields round-trip as absent rather than `undefined`.
 */
export class ProjectsStore extends EvidenceMethods {}
