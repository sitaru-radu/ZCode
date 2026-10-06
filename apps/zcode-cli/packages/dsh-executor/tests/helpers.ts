/**
 * Test helpers: temp workspaces, adapter configs that point at the scripted fake peer, trace
 * readers, and process-hygiene utilities (every spawned fake is killed and every temp dir removed).
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDshExecutor, type DshExecutorAdapter } from '../src/adapter.js';
import type { DshExecutorConfig } from '../src/config.js';
import type { DshEvent } from '../src/types.js';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAKE_SERVER_PATH = path.join(PACKAGE_ROOT, 'tests', 'fake-acp-server.ts');
export const SUBMIT_SERVER_PATH = path.join(PACKAGE_ROOT, 'src', 'mcp', 'submit-server.ts');
/** `--import <this>` lets a spawned child run TypeScript from any working directory. */
export const TSX_LOADER_URL: string = pathToFileURL(
  createRequire(import.meta.url).resolve('tsx'),
).href;

export interface TempDirs {
  readonly root: string;
  readonly stateDir: string;
  readonly sessionDir: string;
  readonly homeDir: string;
}

export function makeTempDirs(prefix = 'dsh-executor-test-'): TempDirs {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(root, 'state');
  const sessionDir = path.join(root, 'session');
  const homeDir = path.join(root, 'home');
  for (const dir of [stateDir, sessionDir, homeDir]) mkdirSync(dir, { recursive: true });
  return { root, stateDir, sessionDir, homeDir };
}

export function removeTempDirs(dirs: TempDirs): void {
  rmSync(dirs.root, { recursive: true, force: true });
}

export interface FakeAdapterOptions {
  readonly stateDir: string;
  readonly scenario?: string;
  readonly config?: DshExecutorConfig;
}

/** Adapter config that spawns the scripted fake peer instead of the real `dsh`. */
export function fakeAdapterConfig(options: FakeAdapterOptions): DshExecutorConfig {
  return {
    binary: process.execPath,
    profile: '',
    args: ['--import', TSX_LOADER_URL, FAKE_SERVER_PATH],
    childCwd: options.stateDir,
    requestTimeoutMs: 5_000,
    turnTimeoutMs: 10_000,
    ...options.config,
    // The fake's own configuration always survives: scenarios are addressed through the environment.
    env: {
      FAKE_SCENARIO: options.scenario ?? 'stream',
      FAKE_STATE_DIR: options.stateDir,
      ...options.config?.env,
    },
  };
}

export function createFakeAdapter(options: FakeAdapterOptions): DshExecutorAdapter {
  return createDshExecutor(fakeAdapterConfig(options));
}

export interface TraceEntry {
  readonly dir: 'in' | 'out';
  readonly at: number;
  readonly frame: Record<string, unknown>;
}

/** Frames the fake saw (`in`) and sent (`out`), in order. */
export function readTrace(stateDir: string): TraceEntry[] {
  const file = path.join(stateDir, 'trace.ndjson');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TraceEntry);
}

/** Frames the client actually put on the wire. */
export function incomingFrames(stateDir: string, method?: string): Record<string, unknown>[] {
  return readTrace(stateDir)
    .filter((entry) => entry.dir === 'in')
    .filter((entry) => method === undefined || entry.frame['method'] === method)
    .map((entry) => entry.frame);
}

export function readJsonLines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function readJsonFile<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${String(timeoutMs)}ms: ${options.label ?? 'condition'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function forceKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/** Pids of every fake peer ever started in this state dir. */
export function recordedFakePids(stateDir: string): number[] {
  const file = path.join(stateDir, 'fake-starts.ndjson');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { pid: number }).pid);
}

/** Last-resort cleanup: kill any fake peer that is still alive. */
export function killRecordedFakes(stateDir: string): number[] {
  const killed: number[] = [];
  for (const pid of recordedFakePids(stateDir)) {
    if (isAlive(pid)) {
      forceKill(pid);
      killed.push(pid);
    }
  }
  return killed;
}

/** Attach to a session's hot stream and collect events into an array until `stop()`. */
export async function collectEvents(
  adapter: DshExecutorAdapter,
  sessionId: string,
): Promise<{ events: DshEvent[]; stop: () => Promise<void> }> {
  const events: DshEvent[] = [];
  const iterator = adapter.streamEvents(sessionId)[Symbol.asyncIterator]();
  let stopped = false;
  const pump = (async () => {
    while (!stopped) {
      const next = await iterator.next();
      if (next.done === true) return;
      events.push(next.value);
    }
  })();
  return {
    events,
    stop: async () => {
      stopped = true;
      await iterator.return?.(undefined);
      await pump;
    },
  };
}
