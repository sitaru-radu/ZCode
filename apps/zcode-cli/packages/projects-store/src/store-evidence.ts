import type {
  MissionId,
  Review,
  StoredValidation,
  Validation,
  ValidationExtras,
} from "./domain.js";
import { conflict, notFound } from "./errors.js";
import { encodeJson } from "./json.js";
import { mapReview, mapValidation, type ReviewRow, type ValidationRow } from "./rows.js";
import { ExecutionMethods } from "./store-execution.js";

const VALIDATION_COLUMNS =
  "id, mission_id, task_id, phase, command, exit_code, duration_ms, result, log_ref, commit_sha, created_at";
const REVIEW_COLUMNS = "id, mission_id, round, verdict, findings_json, reviewed_commit, created_at";

/** Validation and review evidence: what the completion gate reads (specs/projects/10-domain.md §6). */
export interface EvidenceApi {
  insertValidation(validation: Validation, extras?: ValidationExtras): StoredValidation;
  listValidations(missionId: MissionId, commitSha?: string): StoredValidation[];
  insertReview(review: Review): Review;
  listReviews(missionId: MissionId): Review[];
  latestReview(missionId: MissionId): Review | undefined;
}

export class EvidenceMethods extends ExecutionMethods implements EvidenceApi {
  /**
   * Records one validation run. `commitSha` is the commit scope the gate matches on: a validation
   * only counts for the mission head it was produced against.
   */
  insertValidation(validation: Validation, extras: ValidationExtras = {}): StoredValidation {
    if (this.readValidation(validation.id)) throw conflict("validation", validation.id);
    this.execute(
      "INSERT INTO validations(id, mission_id, task_id, phase, command, exit_code, duration_ms, result, log_ref, commit_sha, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      validation.id,
      validation.missionId,
      validation.taskId ?? null,
      validation.phase,
      validation.command,
      validation.exitCode,
      validation.durationMs,
      validation.result,
      validation.logRef ?? null,
      extras.commitSha ?? null,
      extras.createdAt ?? Date.now(),
    );
    return this.requireValidation(validation.id);
  }

  /** Validations of a mission, optionally scoped to the commit they were recorded against. */
  listValidations(missionId: MissionId, commitSha?: string): StoredValidation[] {
    if (commitSha === undefined) {
      return this.query<ValidationRow>(
        `SELECT ${VALIDATION_COLUMNS} FROM validations WHERE mission_id = ? ORDER BY created_at ASC, id ASC`,
        missionId,
      ).map(mapValidation);
    }
    return this.query<ValidationRow>(
      `SELECT ${VALIDATION_COLUMNS} FROM validations WHERE mission_id = ? AND commit_sha = ? ORDER BY created_at ASC, id ASC`,
      missionId,
      commitSha,
    ).map(mapValidation);
  }

  insertReview(review: Review): Review {
    if (this.readReview(review.id)) throw conflict("review", review.id);
    this.execute(
      "INSERT INTO reviews(id, mission_id, round, verdict, findings_json, reviewed_commit, created_at) VALUES(?,?,?,?,?,?,?)",
      review.id,
      review.missionId,
      review.round,
      review.verdict,
      encodeJson(review.findings, "review.findings"),
      review.reviewedCommit,
      review.createdAt,
    );
    return this.requireReview(review.id);
  }

  /** Every review round of a mission, in round order. */
  listReviews(missionId: MissionId): Review[] {
    return this.query<ReviewRow>(
      `SELECT ${REVIEW_COLUMNS} FROM reviews WHERE mission_id = ? ORDER BY round ASC, created_at ASC, id ASC`,
      missionId,
    ).map(mapReview);
  }

  /** Highest round wins; `created_at` and `id` break ties deterministically. */
  latestReview(missionId: MissionId): Review | undefined {
    const row = this.queryOne<ReviewRow>(
      `SELECT ${REVIEW_COLUMNS} FROM reviews WHERE mission_id = ? ORDER BY round DESC, created_at DESC, id DESC LIMIT 1`,
      missionId,
    );
    return row ? mapReview(row) : undefined;
  }

  private readValidation(id: string): StoredValidation | undefined {
    const row = this.queryOne<ValidationRow>(
      `SELECT ${VALIDATION_COLUMNS} FROM validations WHERE id = ?`,
      id,
    );
    return row ? mapValidation(row) : undefined;
  }

  private requireValidation(id: string): StoredValidation {
    const validation = this.readValidation(id);
    if (!validation) throw notFound("validation", id);
    return validation;
  }

  private readReview(id: string): Review | undefined {
    const row = this.queryOne<ReviewRow>(`SELECT ${REVIEW_COLUMNS} FROM reviews WHERE id = ?`, id);
    return row ? mapReview(row) : undefined;
  }

  private requireReview(id: string): Review {
    const review = this.readReview(id);
    if (!review) throw notFound("review", id);
    return review;
  }
}
