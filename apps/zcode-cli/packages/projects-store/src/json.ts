import { invalidArgument, ProjectsStoreError } from "./errors.js";

/**
 * JSON codecs for the `*_json` columns.
 *
 * The store persists the exact domain shapes from `@zcode/projects-core`; JSON is only the transport
 * between those shapes and SQLite TEXT. `null` is never used to mean "absent" for optional domain
 * fields — absent fields are stored as SQL NULL so an unmarshalled entity equals the entity that was
 * written.
 */

export function encodeJson(value: unknown, context: string): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new ProjectsStoreError("invalid_argument", `${context} is not JSON-serializable`, {
      cause: error,
    });
  }
  if (text === undefined) throw invalidArgument(`${context} is not JSON-serializable`);
  return text;
}

export function decodeJson<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ProjectsStoreError("invalid_argument", `${context} holds invalid JSON`, {
      cause: error,
    });
  }
}

export function decodeJsonArray<T>(text: string, context: string): T[] {
  const value = decodeJson<unknown>(text, context);
  if (!Array.isArray(value)) throw invalidArgument(`${context} must hold a JSON array`);
  return value as T[];
}
