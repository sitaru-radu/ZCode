/**
 * Runner configuration and the two deterministic readers a mission needs before it can dispatch
 * anything: validation-command discovery (`specs/projects/50-mission-runner.md` §6) and repository
 * instructions (§4.3).
 *
 * Everything here is pure of ambient state: every path derives from the caller's `repositoryPath`,
 * no process cwd is read, no shell is spawned, and a discovered command is always plain argv that
 * `world.run(command, args)` can execute. An empty discovery result is a legitimate answer — the
 * caller turns it into a `blocked` mission, never into a silent pass.
 */
import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

/** Raised for every rejected configuration value or discovery input. */
export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerConfigError';
  }
}

/** Which discovery step produced a command; recorded so a validation row is auditable. */
export type ValidationCommandSource = 'override' | 'package-script' | 'makefile' | 'ci';

/** One validation command as argv; nothing here may be handed to a shell. */
export interface DiscoveredCommand {
  command: string;
  args: string[];
  source: ValidationCommandSource;
  /** The discovered set is the mandatory set: one failure blocks the mission. */
  required: true;
}

/** Runner defaults, overridable per project (§10). */
export interface MissionConfig {
  /** Concurrent DSH workers; maps to the workflow engine's `Caps.maxConcurrency`. */
  maxWorkers: number;
  /** Dispatch + integration attempts per task before the task is `failed`. */
  maxTaskAttempts: number;
  /** Review → remediation cycles before the mission is `blocked`. */
  maxReviewRounds: number;
  /** Opaque executor model ids; unset means "the project default". Never invented here. */
  plannerModel?: string;
  workerModel?: string;
  reviewerModel?: string;
  /** Unset means unlimited; exceeding it blocks the mission. */
  tokenBudgetPerMission?: number;
  /** Absolute path outside every repository; unset means the runner derives it from `dataDir`. */
  worktreeRoot?: string;
  /** Explicit commands; an empty list means "discover them" (§6.1). */
  validationCommands: string[];
  autoResume: boolean;
}

/** Default truncation cap for one instruction file, in bytes (§4.3 "configured cap"). */
export const DEFAULT_INSTRUCTION_MAX_BYTES = 8000;

/** Mandatory fields always have a concrete value, so they may never be explicitly unset. */
type ConfigKey = keyof MissionConfig;
const MANDATORY_KEYS: readonly ConfigKey[] = [
  'maxWorkers', 'maxTaskAttempts', 'maxReviewRounds', 'validationCommands', 'autoResume',
];
const OPTIONAL_KEYS: readonly ConfigKey[] = [
  'plannerModel', 'workerModel', 'reviewerModel', 'tokenBudgetPerMission', 'worktreeRoot',
];
/** Every accepted key. Unknown keys are rejected instead of silently dropped (typo protection). */
const CONFIG_KEYS: ReadonlySet<string> = new Set<string>([...MANDATORY_KEYS, ...OPTIONAL_KEYS]);

const SCRIPT_PRIORITY = ['typecheck', 'lint', 'test', 'build'];
const MAKE_FILES = ['Makefile', 'GNUmakefile', 'makefile'];
const MAKE_TARGETS = ['check', 'test', 'ci'];
type PackageManager = 'npm' | 'pnpm' | 'yarn';
/** Lockfile → package manager, in the precedence the spec lists. The fallback is npm. */
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm'],
];
/**
 * Instruction files read from the repository root, in order of preference. A closed allowlist of
 * non-hidden names, so an `.env`-like file can never be read by this module.
 */
const INSTRUCTION_FILES = ['AGENTS.md', 'CONTRIBUTING.md', 'CONTRIBUTING', 'README.md'];

/**
 * Build a mission configuration: spec defaults plus validated overrides.
 *
 * Rejects nonsense instead of repairing it — non-positive worker counts, negative attempt/round
 * counters, empty model ids, malformed command overrides, relative worktree roots, and mandatory
 * fields passed as `undefined`. Model ids stay opaque strings; this function never invents one.
 */
export function createRunnerConfig(overrides: Partial<MissionConfig> = {}): MissionConfig {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new RunnerConfigError('runner configuration overrides must be a plain object');
  }
  for (const key of Object.keys(overrides)) {
    if (!CONFIG_KEYS.has(key)) throw new RunnerConfigError(`unknown runner configuration key "${key}"`);
  }
  for (const key of MANDATORY_KEYS) {
    if (key in overrides && overrides[key] === undefined) {
      throw new RunnerConfigError(`${key} is mandatory and cannot be unset`);
    }
  }
  const { maxWorkers, maxTaskAttempts, maxReviewRounds, tokenBudgetPerMission, validationCommands } = overrides;
  const { autoResume } = overrides;
  if (autoResume !== undefined && typeof autoResume !== 'boolean') {
    throw new RunnerConfigError(`autoResume must be a boolean, received ${describeValue(autoResume)}`);
  }
  return {
    maxWorkers: maxWorkers === undefined ? 3 : integer(maxWorkers, 'maxWorkers', 1),
    maxTaskAttempts: maxTaskAttempts === undefined ? 2 : integer(maxTaskAttempts, 'maxTaskAttempts', 0),
    maxReviewRounds: maxReviewRounds === undefined ? 2 : integer(maxReviewRounds, 'maxReviewRounds', 0),
    plannerModel: optionalText(overrides.plannerModel, 'plannerModel', false),
    workerModel: optionalText(overrides.workerModel, 'workerModel', false),
    reviewerModel: optionalText(overrides.reviewerModel, 'reviewerModel', false),
    tokenBudgetPerMission:
      tokenBudgetPerMission === undefined ? undefined : integer(tokenBudgetPerMission, 'tokenBudgetPerMission', 1),
    worktreeRoot: optionalText(overrides.worktreeRoot, 'worktreeRoot', true),
    validationCommands: validationCommands === undefined ? [] : commandOverrides(validationCommands),
    autoResume: autoResume ?? false,
  };
}

/** Counters and budgets: an integer at or above `min` (workers ≥ 1, retries and rounds ≥ 0). */
function integer(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new RunnerConfigError(`${field} must be an integer >= ${min}, received ${describeValue(value)}`);
  }
  return value;
}

/** Optional strings: model ids are opaque, while a worktree root must be absolute (never cwd-based). */
function optionalText(value: unknown, field: string, absolute: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RunnerConfigError(`${field} must be a non-empty string when set, received ${describeValue(value)}`);
  }
  if (absolute && !isAbsolute(value)) throw new RunnerConfigError(`${field} must be absolute: ${value}`);
  return value;
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** Command overrides are shell strings on the way in and argv on the way out, or they are rejected. */
function commandOverrides(value: unknown): string[] {
  if (!Array.isArray(value)) throw new RunnerConfigError('validationCommands must be an array of command strings');
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') throw new RunnerConfigError('blank validation command');
    tokenizeCommand(entry);
    return entry.trim();
  });
}

// ---------------------------------------------------------------------------------------------
// Command tokenizing
// ---------------------------------------------------------------------------------------------

/** Unquoted characters a shell would treat as structure rather than as part of an argument. */
const SHELL_OPERATORS = new Set(['|', '&', ';', '<', '>', '$', '`', '(', ')']);
const WHITESPACE = new Set([' ', '\t', '\r', '\n']);
/** Refusal message for a command that only a shell could run. */
const NEEDS_SHELL = 'command needs a shell; pass plain argv (quote literal text, or split the commands)';

/**
 * Split one command line into argv the way a shell would split *words*, without any expansion.
 *
 * Supported: whitespace separation, single quotes (fully literal), double quotes, backslash escapes.
 * Rejected with `RunnerConfigError`: pipes, `&&`/`;`, redirections, command substitution, `$`
 * expansion, and unterminated quotes. Such a string needs a shell, and this module never grants one,
 * so failing loudly beats executing something subtly different from what was written.
 */
function tokenizeCommand(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let escaped = false;
  let quote: '"' | "'" | undefined;
  for (const char of value) {
    if (escaped) {
      current += char;
      started = true;
      escaped = false;
    } else if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && char === '\\') escaped = true;
      else if (quote === '"' && (char === '$' || char === '`')) throw new RunnerConfigError(NEEDS_SHELL);
      else {
        current += char;
        started = true;
      }
    } else if (char === '\\') {
      escaped = true;
      started = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (WHITESPACE.has(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else if (SHELL_OPERATORS.has(char)) {
      throw new RunnerConfigError(NEEDS_SHELL);
    } else {
      current += char;
      started = true;
    }
  }
  if (escaped) current += '\\';
  if (quote !== undefined) throw new RunnerConfigError(`unterminated ${quote} quote in ${JSON.stringify(value)}`);
  if (started) tokens.push(current);
  if (tokens.length === 0) throw new RunnerConfigError('command must not be empty');
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Discovery (§6): 1 overrides → 2 package scripts → 3 Makefile → 4 CI → 5 no command
// ---------------------------------------------------------------------------------------------

interface RankedCommand extends DiscoveredCommand {
  /** Sort key inside one discovery step; lower means higher priority. */
  rank: number;
}

/** Assemble one argv command; the only place a `DiscoveredCommand` is built. */
function buildCommand(source: ValidationCommandSource, rank: number, argv: string[]): RankedCommand {
  return { command: argv[0] ?? '', args: argv.slice(1), source, required: true, rank };
}

export interface DiscoverValidationInput {
  /** Absolute path of the repository root; nothing outside it is read. */
  repositoryPath: string;
  /** Explicit commands from the mission configuration; a non-empty list wins outright (§6.1). */
  overrides?: string[];
  /** Detected by the caller; when absent, the lockfile decides and npm is the fallback. */
  packageManager?: string;
}

/**
 * Discover the validation commands of a repository, in the exact order of §6: explicit overrides,
 * `package.json` scripts (`typecheck`, `lint`, `test`, `build`) run with the lockfile's package
 * manager, a `Makefile` target (`check`, `test`, `ci`), an unambiguous CI `run:` step, else nothing.
 *
 * An empty list is not a pass: the caller blocks the mission with "no validation commands discovered".
 */
export async function discoverValidationCommands(input: DiscoverValidationInput): Promise<DiscoveredCommand[]> {
  if (input === null || typeof input !== 'object') throw new RunnerConfigError('discovery input must be an object');
  const root = assertRepositoryPath(input.repositoryPath);
  if (input.overrides !== undefined && !Array.isArray(input.overrides)) {
    throw new RunnerConfigError('overrides must be an array of command strings');
  }
  const overrides = input.overrides ?? [];
  if (overrides.length > 0) {
    return finalize(
      overrides.map((raw, rank) => {
        if (typeof raw !== 'string' || raw.trim() === '') {
          throw new RunnerConfigError('override commands must be non-empty strings');
        }
        return buildCommand('override', rank, tokenizeCommand(raw));
      }),
    );
  }
  const packageManager = await detectPackageManager(root, input.packageManager);
  const scripts = await discoverPackageScripts(root, packageManager);
  if (scripts.length > 0) return finalize(scripts);
  const make = await discoverMakeTargets(root);
  if (make.length > 0) return finalize(make);
  return finalize(await discoverCiCommands(root));
}

/** Deterministic ordering: step priority, then source priority, then command name, then arguments. */
function finalize(commands: readonly RankedCommand[]): DiscoveredCommand[] {
  const byRank = (a: RankedCommand, b: RankedCommand): number =>
    a.rank - b.rank || compareStrings(a.command, b.command) || compareStrings(a.args.join(' '), b.args.join(' '));
  const sorted = [...commands].sort(byRank);
  return sorted.map(({ command, args, source }) => ({ command, args, source, required: true }));
}

/** Code-unit comparison: locale-independent, so ordering is identical on every host. */
function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

async function detectPackageManager(root: string, explicit: unknown): Promise<PackageManager> {
  if (explicit !== undefined) {
    // Accept the manifest form too (`pnpm@10.33.2`): the name is what matters.
    const name = typeof explicit === 'string' ? explicit.trim().toLowerCase().split('@')[0] : undefined;
    if (name !== 'npm' && name !== 'pnpm' && name !== 'yarn') {
      throw new RunnerConfigError(`unsupported package manager ${describeValue(explicit)}; expected npm, pnpm, yarn`);
    }
    return name;
  }
  for (const [file, manager] of LOCKFILES) {
    try {
      if ((await stat(join(root, file))).isFile()) return manager;
    } catch {
      continue; // that lockfile is absent: try the next one
    }
  }
  return 'npm';
}

async function discoverPackageScripts(root: string, packageManager: PackageManager): Promise<RankedCommand[]> {
  const scripts = await readPackageScripts(root);
  if (scripts === undefined) return [];
  const commands: RankedCommand[] = [];
  for (const [rank, name] of SCRIPT_PRIORITY.entries()) {
    const body = scripts[name];
    // Only scripts that exist *and* do something: an empty body validates nothing.
    if (typeof body !== 'string' || body.trim() === '') continue;
    commands.push(buildCommand('package-script', rank, [packageManager, 'run', name]));
  }
  return commands;
}

async function readPackageScripts(root: string): Promise<Record<string, string> | undefined> {
  const text = await readFileText(join(root, 'package.json'));
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined; // a malformed manifest declares nothing; the later steps still apply
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return undefined;
  const result: Record<string, string> = {};
  for (const [name, body] of Object.entries(scripts)) if (typeof body === 'string') result[name] = body;
  return result;
}

async function discoverMakeTargets(root: string): Promise<RankedCommand[]> {
  for (const name of MAKE_FILES) {
    const text = await readFileText(join(root, name));
    if (text === undefined) continue; // absent or unreadable: try the next Makefile name
    const declared = new Set(scanMakeTargets(text));
    const found = MAKE_TARGETS.flatMap((target, rank) =>
      declared.has(target) ? [buildCommand('makefile', rank, ['make', target])] : [],
    );
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * Line-based Makefile scan (no Make parser, deliberately).
 *
 * Recognizes target lines `name: prerequisites` — including `::` rules and several targets on one
 * line — and ignores recipe lines (tab-indented), comments, `.PHONY`-style special targets, and
 * `NAME := value` assignments. Make variables, `include`d fragments, and pattern rules are not
 * evaluated, so a target that only exists after evaluation is not discovered; that is acceptable
 * because this fallback must stay conservative.
 */
function scanMakeTargets(text: string): string[] {
  const targets: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.startsWith('\t')) continue;
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('.')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0 || line[colon + 1] === '=') continue;
    for (const candidate of line.slice(0, colon).split(/\s+/)) {
      if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(candidate) && !targets.includes(candidate)) targets.push(candidate);
    }
  }
  return targets;
}

/**
 * CI scanning is a conservative line/regex scan over raw text, not a YAML parse (this module may not
 * take a YAML dependency). Consequences, all deliberate:
 * - only single-line `run:` steps count; `run: |` block scalars are multi-command scripts and are
 *   therefore not "an unambiguous command";
 * - `${{ … }}` expressions and shell control operators disqualify a step;
 * - a step must name a validation verb (`test`, `lint`, `typecheck`, …) and must not start with a
 *   utility that never validates anything (`echo`, `git`, `curl`, …);
 * - `npm ci` and friends install dependencies and are never treated as validation;
 * - workflow triggers are not parsed: M1 only inspects the default checkout, so every workflow in
 *   the repository is treated as describing the default branch.
 */
const RUN_STEP = /^\s*(?:-\s*)?run:\s*(.*)$/;
/** First token of a step that never validates anything; keeps `run:` noise out of discovery. */
const NON_VALIDATION_PROGRAMS: ReadonlySet<string> = new Set(
  ('apt apt-get apk brew cat cd chmod chown cp curl docker echo exit export false gh git ls mkdir mv ' +
    'printf rm set sleep sudo tar true unzip wget yum zip').split(' '),
);
/** Validation verb → canonical name, so ranking is stable across synonyms. */
const CI_KEYWORDS: Readonly<Record<string, string | undefined>> = {
  typecheck: 'typecheck', tsc: 'typecheck', lint: 'lint', eslint: 'lint', oxlint: 'lint',
  test: 'test', tests: 'test', pytest: 'test', vitest: 'test', jest: 'test', mocha: 'test',
  playwright: 'test', build: 'build', check: 'check', ci: 'ci', verify: 'verify', validate: 'validate',
};
const CI_RANK = ['typecheck', 'lint', 'test', 'build', 'check', 'ci', 'verify', 'validate'];

async function discoverCiCommands(root: string): Promise<RankedCommand[]> {
  const directory = join(root, '.github', 'workflows');
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return []; // no workflow directory: nothing to read
  }
  const commands: RankedCommand[] = [];
  const seen = new Set<string>();
  for (const name of entries.filter((entry) => /\.ya?ml$/i.test(entry)).sort(compareStrings)) {
    const text = await readFileText(join(directory, name));
    if (text === undefined) continue; // an unreadable workflow file contributes nothing
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseRunStep(line);
      if (parsed === undefined) continue;
      const key = `${parsed.command} ${parsed.args.join(' ')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      commands.push(buildCommand('ci', CI_RANK.indexOf(parsed.keyword), [parsed.command, ...parsed.args]));
    }
  }
  return commands;
}

/**
 * Turn one workflow line into argv, or `undefined` when it is not one unambiguous validation command.
 *
 * `line` scanning instead of YAML parsing: only single-line `run:` steps count (`run: |` block
 * scalars are whole shell scripts), `${{ … }}` expressions are rejected, and the resulting argv must
 * not need a shell.
 */
function parseRunStep(line: string): { command: string; args: string[]; keyword: string } | undefined {
  const value = (RUN_STEP.exec(line)?.[1] ?? '').trim();
  if (value === '' || value.startsWith('${{')) return undefined;
  if (/^[|>][+-]?(\s.*)?$/.test(value)) return undefined; // block scalar: a whole shell script
  let argv: string[];
  try {
    argv = tokenizeCommand(value);
  } catch {
    return undefined; // needs a shell, so it is not an unambiguous command
  }
  const [command, ...args] = argv;
  if (command === undefined) return undefined;
  const program = baseName(command);
  if (NON_VALIDATION_PROGRAMS.has(program)) return undefined;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program) && args[0] === 'ci') return undefined; // install only
  const keyword = argv.map((token) => ciKeyword(token)).find((entry) => entry !== undefined);
  return keyword === undefined ? undefined : { command, args, keyword };
}

function ciKeyword(token: string): string | undefined {
  const name = baseName(token)
    .replace(/^-+/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase();
  return CI_KEYWORDS[name] ?? CI_KEYWORDS[name.replace(/[-_]/g, '')];
}

function baseName(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1).replace(/\.exe$/i, '').toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Repository instructions (§4.3)
// ---------------------------------------------------------------------------------------------

export interface ReadInstructionsInput {
  /** Absolute path of the repository root. */
  repositoryPath: string;
  /** Per-file cap in bytes; defaults to {@link DEFAULT_INSTRUCTION_MAX_BYTES}. */
  maxBytes?: number;
}

/**
 * Read the repository instruction files a worker brief may quote, in preference order, each capped
 * at `maxBytes`. Truncation is recorded in the returned text so the model never assumes it saw a
 * whole file, and `path` is repository-relative (`AGENTS.md`), which is what belongs in a prompt.
 *
 * Missing, unreadable, non-regular, or repo-escaping (symlinked) files are skipped silently: a brief
 * without instructions is valid, and a mission must not fail because a README is unreadable.
 */
export async function readRepositoryInstructions(
  input: ReadInstructionsInput,
): Promise<{ path: string; text: string }[]> {
  if (input === null || typeof input !== 'object') {
    throw new RunnerConfigError('readRepositoryInstructions input must be an object');
  }
  const root = assertRepositoryPath(input.repositoryPath);
  const maxBytes =
    input.maxBytes === undefined ? DEFAULT_INSTRUCTION_MAX_BYTES : integer(input.maxBytes, 'maxBytes', 1);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return []; // no repository, no instructions
  }

  const found: { path: string; text: string }[] = [];
  for (const name of INSTRUCTION_FILES) {
    const candidate = join(realRoot, name);
    let stats: Stats;
    try {
      stats = await lstat(candidate);
    } catch {
      continue; // absent (or not statable): instruction files are optional
    }
    let readable = candidate;
    if (stats.isSymbolicLink()) {
      try {
        readable = await realpath(candidate);
      } catch {
        continue; // broken link
      }
      if (!isInside(realRoot, readable)) continue; // never follow a link out of the repository
    } else if (!stats.isFile()) {
      continue; // a directory named CONTRIBUTING is not an instruction file
    }
    const text = await readFileText(readable);
    if (text === undefined) continue; // unreadable: ignore silently
    found.push({ path: name, text: capText(text, maxBytes) });
  }
  return found;
}

/** Truncate to a byte budget without splitting a UTF-8 sequence, and say so in the text. */
function capText(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  const head = buffer.subarray(0, end).toString('utf8');
  return `${head}\n\n[truncated: showing the first ${end} of ${buffer.length} bytes]`;
}

/** Containment test on already-resolved paths; rejects `..` escapes and other volumes. */
function isInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function assertRepositoryPath(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RunnerConfigError('repositoryPath is mandatory and must be a non-empty string');
  }
  if (!isAbsolute(value)) throw new RunnerConfigError(`repositoryPath must be absolute: ${value}`);
  return value;
}

/** Read a file as UTF-8, or `undefined` when it is absent, a directory, or unreadable. */
async function readFileText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}
