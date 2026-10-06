/** Typed errors raised by the Projects store; callers branch on `code`, never on message text. */
export type ProjectsStoreErrorCode =
  | "checksum_mismatch"
  | "conflict"
  | "invalid_argument"
  | "not_found";

export interface ProjectsStoreErrorOptions {
  cause?: unknown;
  /** Set for `checksum_mismatch`, so operators can name the offending migration. */
  migrationId?: string;
}

export class ProjectsStoreError extends Error {
  readonly code: ProjectsStoreErrorCode;
  readonly migrationId: string | undefined;

  constructor(
    code: ProjectsStoreErrorCode,
    message: string,
    options: ProjectsStoreErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProjectsStoreError";
    this.code = code;
    this.migrationId = options.migrationId;
  }
}

export function notFound(entity: string, id: string): ProjectsStoreError {
  return new ProjectsStoreError("not_found", `${entity} not found: ${id}`);
}

export function conflict(entity: string, key: string): ProjectsStoreError {
  return new ProjectsStoreError("conflict", `${entity} already exists: ${key}`);
}

export function invalidArgument(message: string): ProjectsStoreError {
  return new ProjectsStoreError("invalid_argument", message);
}

export function checksumMismatch(migrationId: string): ProjectsStoreError {
  return new ProjectsStoreError(
    "checksum_mismatch",
    `Projects database migration checksum mismatch: ${migrationId}`,
    { migrationId },
  );
}

export function isProjectsStoreError(
  error: unknown,
  code?: ProjectsStoreErrorCode,
): error is ProjectsStoreError {
  return (
    error instanceof ProjectsStoreError && (code === undefined || error.code === code)
  );
}
