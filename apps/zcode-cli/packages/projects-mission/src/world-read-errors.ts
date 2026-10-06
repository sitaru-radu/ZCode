/**
 * Structured, catchable world-read errors.
 *
 * Every op rejects with a {@link WorldReadError}; nothing is a bare `throw` and nothing is a
 * silent truncation. The `code` field is the machine-readable half: a workflow script catches
 * one of these and branches on `error.code`.
 */

import type { WorldReadErrorCode } from "./world-read-types.js";

/** Error thrown by every world read. `code` is stable and safe to branch on. */
export class WorldReadError extends Error {
  /** Machine-readable failure kind. */
  readonly code: WorldReadErrorCode;

  constructor(code: WorldReadErrorCode, message: string) {
    super(message);
    this.name = "WorldReadError";
    this.code = code;
  }
}

/** A cap was exceeded — rejection instead of truncation, with a next step in the message. */
export function tooLarge(message: string): WorldReadError {
  return new WorldReadError("WORLD_READ_TOO_LARGE", message);
}

/** The positional arguments of one op do not have the shape the op requires. */
export function invalidArgs(message: string): WorldReadError {
  return new WorldReadError("WORLD_READ_INVALID_ARGS", message);
}

/** The observation itself did not hold: spawn failure, git failure, unreadable file. */
export function failed(message: string): WorldReadError {
  return new WorldReadError("WORLD_READ_FAILED", message);
}

/** A path resolved outside the workspace. */
export function pathEscape(message: string): WorldReadError {
  return new WorldReadError("WORLD_READ_PATH_ESCAPE", message);
}

/** The command did not finish inside its timeout. */
export function timedOut(message: string): WorldReadError {
  return new WorldReadError("WORLD_READ_TIMEOUT", message);
}

/** Is this value a world-read error (works across a duplicated module instance too)? */
export function isWorldReadError(value: unknown): value is WorldReadError {
  return (
    value instanceof WorldReadError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { name?: unknown }).name === "WorldReadError" &&
      typeof (value as { code?: unknown }).code === "string")
  );
}
