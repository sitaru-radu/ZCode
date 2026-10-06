/**
 * `submit_result` MCP bridge (spec §5, mechanism 1).
 *
 * A dependency-free stdio MCP server: raw JSON-RPC 2.0 on stdin/stdout, nothing else. It exposes
 * exactly one tool whose input schema the caller supplies, answers `initialize`/`tools/list`, and
 * reports every `tools/call` to a callback. DSH probes with the draft `server/discover` method
 * first (probe §6) and falls back to the legacy `initialize` handshake when it is not implemented,
 * so `server/discover` is answered with `-32601` on purpose.
 *
 * Two ways to use it:
 *  - in-process (`createSubmitServer`) for tests and embedded bridges;
 *  - spawned by the agent (`createSubmitMcpServer` builds the `session/new` descriptor, the module
 *    is run directly with the schema in `DSH_SUBMIT_SCHEMA`).
 *
 * The adapter does not need an out-of-band channel to see the payload: the tool call reaches it as a
 * normal `session/update` whose `rawInput` is the arguments the worker passed. The optional
 * `DSH_SUBMIT_RESULT_FILE` sink exists only as an audit trail.
 */

import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  encodeError,
  encodeResult,
  isRecord,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
} from '../jsonrpc.js';
import type { DshMcpServer } from '../types.js';
import { McpConfigError } from './servers.js';

/** Protocol version used by the legacy handshake DSH falls back to (probe §6). */
export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_SUBMIT_TOOL_NAME = 'submit_result';
export const SUBMIT_SERVER_NAME = 'dsh-executor-submit';
export const SUBMIT_SERVER_VERSION = '0.1.0';
export const DEFAULT_SUBMIT_DESCRIPTION =
  'Submit the final typed result of this task. Call it exactly once when the task is complete.';

export const SUBMIT_SCHEMA_ENV = 'DSH_SUBMIT_SCHEMA';
export const SUBMIT_SCHEMA_FILE_ENV = 'DSH_SUBMIT_SCHEMA_FILE';
export const SUBMIT_TOOL_NAME_ENV = 'DSH_SUBMIT_TOOL_NAME';
export const SUBMIT_RESULT_FILE_ENV = 'DSH_SUBMIT_RESULT_FILE';

export interface SubmitCallReport {
  readonly toolName: string;
  readonly args: unknown;
  /** ISO timestamp, set by the server process. */
  readonly at: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface SubmitServerOptions {
  /** JSON Schema for the single tool, supplied by the caller. */
  readonly inputSchema: Record<string, unknown>;
  readonly toolName?: string;
  readonly toolDescription?: string;
  readonly serverName?: string;
  readonly serverVersion?: string;
  /** Called for every `tools/call`, accepted or not. */
  readonly onCall?: (report: SubmitCallReport) => void;
  readonly onLog?: (line: string) => void;
}

export interface SubmitServer {
  readonly toolName: string;
  /** Calls accepted by the bridge (schema validation passed). */
  readonly callCount: number;
  /** Decode one NDJSON line and return the lines to write back (may be empty). */
  handleLine(line: string): string[];
  /** Handle an already-decoded frame. */
  handle(frame: unknown): string[];
}

/** Check `required` (top level only, which is all a bridge needs) and report the first problem. */
export function validateArguments(schema: Record<string, unknown>, args: unknown): string | undefined {
  if (!isRecord(args)) return 'arguments must be a JSON object';
  const required = schema['required'];
  if (!Array.isArray(required)) return undefined;
  for (const key of required) {
    if (typeof key === 'string' && !(key in args)) return `missing required property "${key}"`;
  }
  return undefined;
}

export function createSubmitServer(options: SubmitServerOptions): SubmitServer {
  const toolName = options.toolName ?? DEFAULT_SUBMIT_TOOL_NAME;
  const serverName = options.serverName ?? SUBMIT_SERVER_NAME;
  const serverVersion = options.serverVersion ?? SUBMIT_SERVER_VERSION;
  let callCount = 0;

  const toolDescriptor = (): Record<string, unknown> => ({
    name: toolName,
    description: options.toolDescription ?? DEFAULT_SUBMIT_DESCRIPTION,
    inputSchema: options.inputSchema,
  });

  const handleRequest = (id: number | string, method: string, params: unknown): string[] => {
    switch (method) {
      case 'initialize': {
        const requested = isRecord(params) ? params['protocolVersion'] : undefined;
        return [
          encodeResult(id, {
            protocolVersion: typeof requested === 'string' ? requested : MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: serverName, version: serverVersion },
          }),
        ];
      }
      case 'ping':
      case 'shutdown':
        return [encodeResult(id, {})];
      case 'tools/list':
        return [encodeResult(id, { tools: [toolDescriptor()] })];
      case 'tools/call': {
        if (!isRecord(params)) return [encodeError(id, RPC_INVALID_PARAMS, 'params must be an object')];
        const name = params['name'];
        if (typeof name !== 'string') return [encodeError(id, RPC_INVALID_PARAMS, 'name is required')];
        const args = params['arguments'] ?? {};
        const at = new Date().toISOString();
        if (name !== toolName) {
          const error = `Unknown tool: ${name}`;
          options.onCall?.({ toolName: name, args, at, ok: false, error });
          return [encodeError(id, RPC_INVALID_PARAMS, error)];
        }
        const problem = validateArguments(options.inputSchema, args);
        if (problem === undefined) callCount += 1;
        options.onCall?.(
          problem === undefined
            ? { toolName, args, at, ok: true }
            : { toolName, args, at, ok: false, error: problem },
        );
        if (problem !== undefined) {
          return [
            encodeResult(id, {
              content: [{ type: 'text', text: `submit_result rejected: ${problem}` }],
              isError: true,
            }),
          ];
        }
        return [
          encodeResult(id, {
            content: [{ type: 'text', text: 'submit_result accepted' }],
            isError: false,
          }),
        ];
      }
      case 'server/discover':
        // Draft method DSH probes first; not implementing it forces the legacy initialize handshake.
        options.onLog?.('server/discover not implemented: falling back to the legacy handshake');
        return [encodeError(id, RPC_METHOD_NOT_FOUND, 'Method not found: server/discover')];
      default:
        return [encodeError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`)];
    }
  };

  const handle = (frame: unknown): string[] => {
    if (!isRecord(frame)) return [encodeError(null, RPC_PARSE_ERROR, 'frame must be a JSON object')];
    const method = frame['method'];
    const id = frame['id'];
    if (typeof method !== 'string') {
      // Responses from the client are not expected; ignore them rather than looping.
      return [];
    }
    // JSON-RPC allows string or numeric ids; DSH's draft `server/discover` probe uses a string.
    if (typeof id !== 'number' && typeof id !== 'string') {
      // Notification (`notifications/initialized`, `notifications/cancelled`, ...): never answered.
      if (method === 'exit') options.onLog?.('exit notification received');
      return [];
    }
    try {
      return handleRequest(id, method, frame['params']);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [encodeError(id, RPC_INTERNAL_ERROR, message)];
    }
  };

  return {
    toolName,
    get callCount(): number {
      return callCount;
    },
    handleLine(line: string): string[] {
      if (line.trim() === '') return [];
      try {
        return handle(JSON.parse(line));
      } catch {
        return [encodeError(null, RPC_PARSE_ERROR, 'Parse error')];
      }
    },
    handle,
  };
}

export interface SubmitServerIo {
  readonly input: Readable;
  readonly output: Writable;
  /** Called when the input side ends (stdin EOF). */
  readonly onEnd?: () => void;
}

/** Wire a server to a pair of streams. Returns a stop function. */
export function attachSubmitServer(server: SubmitServer, io: SubmitServerIo): () => void {
  let buffer = '';
  let stopped = false;
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      for (const out of server.handleLine(line)) io.output.write(out);
      index = buffer.indexOf('\n');
    }
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    io.input.off('data', onData);
    io.input.off('end', onEnd);
  };
  const onEnd = (): void => {
    stop();
    io.onEnd?.();
  };
  io.input.on('data', onData);
  io.input.on('end', onEnd);
  return stop;
}

export interface StdioSubmitServerOptions extends SubmitServerOptions {
  readonly onEnd?: () => void;
}

/** Run a submit server on this process's stdio (used by the spawned entry point). */
export function runSubmitServerStdio(options: StdioSubmitServerOptions): () => void {
  const server = createSubmitServer(options);
  return attachSubmitServer(server, {
    input: process.stdin,
    output: process.stdout,
    onEnd: options.onEnd,
  });
}

function readSchema(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const inline = env[SUBMIT_SCHEMA_ENV];
  const file = env[SUBMIT_SCHEMA_FILE_ENV];
  const raw = inline ?? (file === undefined ? undefined : readFileSync(file, 'utf8'));
  if (raw === undefined) {
    throw new McpConfigError(`missing ${SUBMIT_SCHEMA_ENV} or ${SUBMIT_SCHEMA_FILE_ENV}`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new McpConfigError('submit schema must be a JSON object');
  return parsed;
}

/** Entry point of `node <this file>`: schema from the environment, calls appended to a sink file. */
export function submitServerMain(env: NodeJS.ProcessEnv = process.env): number {
  let schema: Record<string, unknown>;
  try {
    schema = readSchema(env);
  } catch (error) {
    process.stderr.write(
      `[dsh-executor submit bridge] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const resultFile = env[SUBMIT_RESULT_FILE_ENV];
  const toolName = env[SUBMIT_TOOL_NAME_ENV] ?? DEFAULT_SUBMIT_TOOL_NAME;
  runSubmitServerStdio({
    inputSchema: schema,
    toolName,
    onCall: (report) => {
      if (resultFile === undefined) return;
      try {
        appendFileSync(resultFile, `${JSON.stringify(report)}\n`);
      } catch (error) {
        process.stderr.write(
          `[dsh-executor submit bridge] sink write failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    },
    onLog: (line) => {
      process.stderr.write(`[dsh-executor submit bridge] ${line}\n`);
    },
    onEnd: () => {
      process.exit(0);
    },
  });
  return 0;
}

/**
 * Path of the runnable sibling module: the compiled `submit-server.js` when built, otherwise the
 * TypeScript source (which needs `nodeArgs: ['--import', <tsx loader>]` to be spawned).
 */
export function submitServerEntryPath(moduleUrl: string = import.meta.url): string {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  for (const candidate of ['submit-server.js', 'submit-server.ts']) {
    const full = path.join(directory, candidate);
    if (existsSync(full)) return full;
  }
  throw new McpConfigError(`submit server entry not found next to ${directory}`);
}

export interface SubmitMcpServerOptions {
  readonly inputSchema: Record<string, unknown>;
  /** MCP server name; must match `^[A-Za-z0-9_-]{1,32}$`. Default `submit`. */
  readonly name?: string;
  /** Tool name; DSH exposes it as `mcp__<name>__<toolName>`. Default `submit_result`. */
  readonly toolName?: string;
  /** Optional NDJSON audit sink written by the spawned server (must be absolute). */
  readonly resultFile?: string;
  /** Default `process.execPath`. */
  readonly command?: string;
  readonly entryPath?: string;
  /** Launcher args before the entry, e.g. `['--import', <tsx loader>]` when running from source. */
  readonly nodeArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** Build the `session/new` descriptor for the bridge. The caller passes it in `spec.mcpServers`. */
export function createSubmitMcpServer(options: SubmitMcpServerOptions): DshMcpServer {
  const env: Record<string, string> = {
    [SUBMIT_TOOL_NAME_ENV]: options.toolName ?? DEFAULT_SUBMIT_TOOL_NAME,
    [SUBMIT_SCHEMA_ENV]: JSON.stringify(options.inputSchema),
    ...options.env,
  };
  if (options.resultFile !== undefined) env[SUBMIT_RESULT_FILE_ENV] = options.resultFile;
  return {
    name: options.name ?? 'submit',
    command: options.command ?? process.execPath,
    args: [...(options.nodeArgs ?? []), options.entryPath ?? submitServerEntryPath()],
    env,
  };
}

function invokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = submitServerMain();
}
