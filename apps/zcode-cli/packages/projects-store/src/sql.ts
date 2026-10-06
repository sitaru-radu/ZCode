import type { SQLInputValue } from "node:sqlite";

import { invalidArgument } from "./errors.js";

/** SQLite has no boolean type; domain booleans are stored as 0/1 INTEGER. */
export function encodeScalar(value: unknown, context: string): SQLInputValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  throw invalidArgument(`${context} is not a SQLite scalar value: ${typeof value}`);
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * One mutable column of a table. `encode` defaults to {@link encodeScalar}; JSON columns pass their
 * own encoder so optional domain fields keep their shape.
 */
export interface PatchField {
  readonly column: string;
  readonly encode?: (value: unknown) => SQLInputValue;
}

export interface UpdateStatement {
  readonly sql: string;
  readonly values: SQLInputValue[];
}

/**
 * Builds `UPDATE <table> SET … WHERE id = ?` from a patch object (the caller appends the id).
 *
 * `undefined` patch fields are skipped, `null` clears the column, and unknown fields are rejected
 * instead of being silently dropped — a typo in a patch must never look like a successful update.
 * Returns `undefined` when the patch carries no change, so "patch with nothing to do" stays a read.
 */
export function buildUpdate(
  table: string,
  spec: Readonly<Record<string, PatchField>>,
  patch: object,
): UpdateStatement | undefined {
  const assignments: string[] = [];
  const values: SQLInputValue[] = [];
  for (const [field, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const definition = spec[field];
    if (!definition) throw invalidArgument(`Unknown ${table} patch field: ${field}`);
    assignments.push(`${definition.column} = ?`);
    values.push(
      definition.encode ? definition.encode(value) : encodeScalar(value, `${table}.${field}`),
    );
  }
  if (assignments.length === 0) return undefined;
  return { sql: `UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ?`, values };
}
