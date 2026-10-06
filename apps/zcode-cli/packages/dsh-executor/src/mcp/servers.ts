/**
 * MCP server descriptors: normalization + strict local validation before `session/new`.
 *
 * The probe (gotcha 8.3) proved the agent's deserializer is tolerant: an entry missing a
 * schema-required field (`env` for stdio, `headers` for http) is **silently dropped**, and a normal
 * `sessionId` comes back with zero servers attached. This module therefore refuses to send an
 * incomplete entry and produces the exact wire shape instead:
 *
 *   [{"name":"submit","command":"/abs/node","args":["/abs/server.js"],"env":[{"name":"K","value":"V"}]}]
 *
 * `command` must be absolute, `env`/`headers` are always arrays (never maps), and `sse` is rejected
 * with the same message the agent uses.
 */

import path from 'node:path';

import { isRecord } from '../jsonrpc.js';
import type { AcpEnvVariable, AcpMcpServer, DshMcpServer } from '../types.js';

/** Server names DSH does not rewrite; anything else is hashed and the model sees a different name. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigError';
  }
}

function normalizeVariables(label: string, input: unknown, fallback: 'required' | 'empty'): AcpEnvVariable[] {
  if (input === undefined) {
    if (fallback === 'empty') return [];
    throw new McpConfigError(`${label} is required and must be an array (a missing field is dropped silently)`);
  }
  if (Array.isArray(input)) {
    return input.map((entry, index) => {
      if (!isRecord(entry) || typeof entry['name'] !== 'string' || typeof entry['value'] !== 'string') {
        throw new McpConfigError(`${label}[${String(index)}] must be {name: string, value: string}`);
      }
      return { name: entry['name'], value: entry['value'] };
    });
  }
  if (isRecord(input)) {
    return Object.entries(input).map(([name, value]) => {
      if (typeof value !== 'string') {
        throw new McpConfigError(`${label}.${name} must be a string`);
      }
      return { name, value };
    });
  }
  throw new McpConfigError(`${label} must be a map of strings or an array of {name, value}`);
}

/** Validate and convert caller-facing descriptors into the exact ACP wire shape. */
export function toAcpMcpServers(servers: readonly DshMcpServer[]): AcpMcpServer[] {
  const out: AcpMcpServer[] = [];
  const seen = new Set<string>();
  servers.forEach((server, index) => {
    const label = `mcpServers[${String(index)}]`;
    if (!isRecord(server)) throw new McpConfigError(`${label} must be an object`);
    const name = server['name'];
    if (typeof name !== 'string' || name === '') throw new McpConfigError(`${label}.name is required`);
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      throw new McpConfigError(
        `${label}.name "${name}" does not match ${String(MCP_SERVER_NAME_PATTERN)}; ` +
          'DSH rewrites such names (hash suffix), so the model would see a different tool prefix',
      );
    }
    if (seen.has(name)) throw new McpConfigError(`mcpServers contains duplicate normalized name: ${name}`);
    seen.add(name);

    const type = server['type'];
    if (type === 'sse') throw new McpConfigError(`${label} transport sse is not supported`);
    if (type === 'http') {
      const url = server['url'];
      if (typeof url !== 'string' || url === '') throw new McpConfigError(`${label}.url is required`);
      out.push({
        name,
        type: 'http',
        url,
        headers: normalizeVariables(`${label}.headers`, server['headers'], 'empty'),
      });
      return;
    }
    if (type !== undefined) throw new McpConfigError(`${label} transport "${String(type)}" is not supported`);

    const command = server['command'];
    if (typeof command !== 'string' || command === '') throw new McpConfigError(`${label}.command is required`);
    if (!path.isAbsolute(command)) {
      throw new McpConfigError(`${label}.command must be an absolute path (got "${command}")`);
    }
    const args = server['args'] ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new McpConfigError(`${label}.args must be an array of strings`);
    }
    out.push({
      name,
      command,
      args: [...(args as string[])],
      env: normalizeVariables(`${label}.env`, server['env'], 'empty'),
    });
  });
  return out;
}
