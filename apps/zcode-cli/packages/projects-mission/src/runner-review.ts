/**
 * Review protocol, verdict parsing and completion assessment — spec `specs/projects/50-mission-runner.md`
 * §7 (review protocol), §8 (completion gate), §12 (failure modes), §13 (invariants) plus the domain
 * rules of `specs/projects/10-domain.md` §6.
 *
 * The module is pure and dependency-injected: the caller runs git and the validation commands and
 * hands the raw text in. Nothing here spawns a process, reads a file or talks to a model, so every
 * function is deterministic (same input ⇒ same output) and testable without a repository.
 *
 * The reviewer is untrusted input: its prose is only ever parsed, never executed, and a reply that
 * does not match the §7 contract is an error rather than a guess.
 */
import type { Blocker, Mission, MissionPlan, PlanTask, Review, ReviewFinding, Task, Validation } from '@zcode/projects-core';
import { deriveId, evaluateCompletion, remediationTasksFor } from '@zcode/projects-core';

/** A reviewed task as the brief needs it: the runner may pass slimmed rows instead of full `Task`s. */
export interface ReviewBriefTask {
  planKey?: string;
  title: string;
  description?: string;
  acceptance?: string[];
}

/** Deterministic change facts the runner read from git for the reviewed commit (§7). */
export interface ReviewChangeFacts {
  /** Mission branch the commit lives on. */
  branch: string;
  /** Integrated commit (sha) the reviewer worktree is checked out at. */
  commit: string;
  /** Repository-relative paths changed by the reviewed tasks. */
  changedFiles: string[];
  /** `git diff --stat` output; when absent the brief says so instead of guessing. */
  diffStat?: string;
  /** `git diff` output; may be cut short, see `diffTruncated`. */
  diff: string;
  /** True when `diff` is a truncated view of the real change. */
  diffTruncated?: boolean;
  /** Repository instruction excerpt (`AGENTS.md`, `CONTRIBUTING.md`), capped by the caller. */
  instructions?: { path: string; text: string }[];
}

/** Everything the reviewer's brief is built from: mission identity, acceptance bar, git facts (§7). */
export interface ReviewBriefInput {
  /** Full mission row: adds the mission title and id to the brief. */
  mission?: Mission;
  /** Mission objective, when the caller does not pass the mission row. */
  missionObjective?: string;
  /** Review round this brief belongs to (1-based), when the caller numbers rounds. */
  round?: number;
  /** Integrated commit (sha) under review; the verdict is recorded against it. */
  reviewedCommit?: string;
  /** The tasks under review — their acceptance criteria are the bar the diff must clear. */
  tasks: ReviewBriefTask[];
  /** Grouped change facts: the shape `runner.ts` passes. */
  facts?: ReviewChangeFacts;
  /** Inline alternative to `facts.branch`. */
  branch?: string;
  /** Inline alternative to `facts.commit`; `reviewedCommit` is used when both are absent. */
  commit?: string;
  /** Inline alternative to `facts.changedFiles`. */
  changedFiles?: string[];
  /** Inline alternative to `facts.diffStat`. */
  diffStat?: string;
  /** Inline alternative to `facts.diff`. */
  diff?: string;
  /** Inline alternative to `facts.diffTruncated`. */
  diffTruncated?: boolean;
  /** Inline alternative to `facts.instructions`. */
  instructions?: { path: string; text: string }[];
  /** Optional hard cap on the emitted diff text; exceeding it marks the diff as truncated. */
  maxDiffChars?: number;
}

/**
 * Rules the reviewer must obey. The no-modification rule is the §12 "reviewer modifies files" guard:
 * a dirty reviewer worktree invalidates the review, so the rule is stated first and unambiguously.
 */
const REVIEW_RULES = [
  'You must not modify any file: do not write, create, delete, rename, format or revert anything in the worktree. The runner checks that the worktree is still clean afterwards; a dirty worktree invalidates this review.',
  'You must not change repository state: no commits, no installs, no branch or worktree operations, no writes outside the worktree.',
  'Judge only the reviewed commit and the facts listed here. Read files in the worktree to confirm details, but never the mission log or other tasks.',
  'Check every acceptance criterion listed above against the diff and report anything you cannot verify.',
  'Use severity "blocking" only when the mission must not complete in this state; use "advisory" for improvements a human can handle later.',
  'Do not invent commands, files or line numbers: cite only what you actually saw.',
  'Reply with exactly one fenced ```json block containing the verdict contract and nothing else.',
].join('\n- ');

/** The §7 verdict contract, verbatim, as the reviewer must emit it. */
const VERDICT_CONTRACT = `{
  "verdict": "pass" | "fail",
  "findings": [
    { "severity": "blocking" | "advisory", "title": "short imperative title",
      "detail": "what is wrong, where, and which evidence you used",
      "file": "relative/path", "line": 12, "requirement": "objective or acceptance item this violates" }
  ]
}`;

/** Printed whenever the emitted diff is not the whole change, so the verdict is scoped honestly. */
const TRUNCATION_NOTICE =
  'Diff note: the diff above is TRUNCATED and is not the whole change. Judge only what is shown, say in the finding detail when a decision depended on the hidden part, and never assume the hidden part is correct.';

const ACCEPTANCE_HEADING = 'Acceptance criteria of the reviewed tasks:';
const FACTS_HEADING = 'Deterministic change facts (read from git by the runner — treat them as given):';

/** Build the reviewer's brief. Deterministic for a given input; it is the reviewer's only context. */
export function buildReviewBrief(input: ReviewBriefInput): string {
  const facts = changeFactsOf(input);
  const sections: string[] = [
    'You are an independent reviewer for an autonomous development mission. The change is already ' +
      'committed and integrated. You inspect it, you report a verdict, and you never edit it.',
  ];
  if (input.mission !== undefined) sections.push(`Mission: ${input.mission.title}\nMission id: ${input.mission.id}`);
  sections.push(`Objective:\n${input.mission?.objective ?? input.missionObjective ?? '(no objective was supplied)'}`);
  const round = input.round === undefined ? '(not numbered)' : String(input.round);
  sections.push(`Review round: ${round}\nReviewed commit: ${facts.commit}`);
  sections.push(acceptanceSection(input.tasks));
  sections.push(changeFactsSection(facts, input.maxDiffChars));
  const instructions = facts.instructions ?? [];
  if (instructions.length > 0) {
    const joined = instructions.map((file) => `--- ${file.path} ---\n${file.text}`).join('\n\n');
    sections.push(`Repository instructions (excerpt, must be respected):\n${joined}`);
  }
  sections.push(`Rules:\n- ${REVIEW_RULES}`);
  sections.push(`Verdict contract — reply with exactly one fenced json block:\n\`\`\`json\n${VERDICT_CONTRACT}\n\`\`\``);
  return sections.join('\n\n');
}

/** The acceptance bar: one block per reviewed task, criteria verbatim. */
function acceptanceSection(tasks: ReviewBriefTask[]): string {
  if (tasks.length === 0) return `${ACCEPTANCE_HEADING}\n(none supplied — judge the diff against the objective)`;
  const blocks = tasks.map((task) => {
    const heading = task.planKey === undefined ? `- ${task.title}` : `- ${task.planKey}: ${task.title}`;
    const criteria = task.acceptance !== undefined && task.acceptance.length > 0 ? task.acceptance : ['(no explicit criteria — use the description)'];
    const lines = task.description === undefined || task.description.trim() === '' ? [heading] : [heading, `  description: ${task.description}`];
    return [...lines, ...criteria.map((criterion) => `  - ${criterion}`)].join('\n');
  });
  return `${ACCEPTANCE_HEADING}\n${blocks.join('\n')}`;
}

/** The facts section: everything here was read from git by the runner, so the reviewer cannot re-derive it. */
function changeFactsSection(facts: ReviewChangeFacts, maxDiffChars?: number): string {
  const stat = facts.diffStat?.trim();
  const capped = capDiff(facts.diff, facts.diffTruncated === true, maxDiffChars);
  const files = facts.changedFiles.length === 0 ? 'Changed files: none reported' : `Changed files (${facts.changedFiles.length}):\n- ${facts.changedFiles.join('\n- ')}`;
  const statLine = stat === undefined || stat === '' ? '(no diff stat was supplied; read the diff below)' : stat;
  const lines = [FACTS_HEADING, `Branch: ${facts.branch}`, `Commit: ${facts.commit}`, files, `Diff stat:\n${statLine}`, `Diff:\n${capped.text}`];
  if (capped.truncated) lines.push(TRUNCATION_NOTICE);
  return lines.join('\n');
}

/** Read the grouped facts when given, otherwise assemble them from the inline fields. */
function changeFactsOf(input: ReviewBriefInput): ReviewChangeFacts {
  const facts = input.facts;
  const diffStat = facts?.diffStat ?? input.diffStat;
  const instructions = input.instructions ?? facts?.instructions;
  return {
    branch: facts?.branch ?? input.branch ?? '(not supplied)',
    commit: facts?.commit ?? input.commit ?? input.reviewedCommit ?? '(not supplied)',
    changedFiles: facts?.changedFiles ?? input.changedFiles ?? [],
    ...(diffStat === undefined ? {} : { diffStat }),
    diff: facts?.diff ?? input.diff ?? '',
    diffTruncated: facts?.diffTruncated === true || input.diffTruncated === true,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

/** Apply the caller's cap and report whether what is emitted is the whole change. */
function capDiff(diff: string, alreadyTruncated: boolean, maxDiffChars?: number): { text: string; truncated: boolean } {
  if (maxDiffChars !== undefined && diff.length > maxDiffChars) return { text: `${diff.slice(0, maxDiffChars)}\n[cut after ${maxDiffChars} characters]`, truncated: true };
  return { text: diff.trim() === '' ? '(empty)' : diff, truncated: alreadyTruncated };
}

/** `parseReviewVerdict` either yields the §7 verdict or explains why the reply is unusable. */
export type ReviewVerdictResult = { verdict: 'pass' | 'fail'; findings: ReviewFinding[] } | { error: string };

/**
 * Parse the reviewer's final message: the LAST fenced ```json block wins (a model that restates the
 * contract before answering would otherwise be read on its example). Strict validation, never throws:
 * an unusable reply becomes `{ error }`, which the caller turns into an invalidated review.
 *
 * Unknown keys are dropped rather than rejected, so the contract can grow without breaking callers;
 * `null` for an optional field means "absent". A `pass` carrying a `blocking` finding is a
 * contradiction and therefore an error: the gate must never see a passing verdict with live blockers.
 */
export function parseReviewVerdict(text: string): ReviewVerdictResult {
  try {
    if (typeof text !== 'string') return { error: 'review reply is not text' };
    const blocks = collectJsonBlocks(text);
    const last = blocks[blocks.length - 1];
    if (last === undefined) return { error: 'review reply contains no fenced ```json block' };
    let payload: unknown;
    try {
      payload = JSON.parse(last);
    } catch (error) {
      return { error: `review verdict is not valid JSON: ${messageOf(error)}` };
    }
    return validateVerdict(payload);
  } catch (error) {
    return { error: `review verdict could not be parsed: ${messageOf(error)}` };
  }
}

/** Every fenced ```json block, in order. Only the language-tagged json fence counts (§7). */
function collectJsonBlocks(text: string): string[] {
  const pattern = /```json[ \t]*\r?\n([\s\S]*?)```/gi;
  const blocks: string[] = [];
  for (const match of text.matchAll(pattern)) if (match[1] !== undefined) blocks.push(match[1]);
  return blocks;
}

/** Validate the decoded payload against the §7 schema with no leniency beyond dropping unknown keys. */
function validateVerdict(payload: unknown): ReviewVerdictResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'review verdict is not a JSON object' };
  const raw = payload as Record<string, unknown>;
  const verdict = raw.verdict;
  if (verdict !== 'pass' && verdict !== 'fail') return { error: `review verdict must be "pass" or "fail", received ${describeValue(verdict)}` };
  if (!Array.isArray(raw.findings)) return { error: 'review verdict has no "findings" array' };
  const findings: ReviewFinding[] = [];
  for (const [index, entry] of raw.findings.entries()) {
    const parsed = parseFinding(entry, index);
    if ('error' in parsed) return { error: parsed.error };
    findings.push(parsed.finding);
  }
  const contradiction = findings.find((finding) => finding.severity === 'blocking');
  if (verdict === 'pass' && contradiction !== undefined) return { error: `review verdict is "pass" but finding "${contradiction.title}" is blocking` };
  return { verdict, findings };
}

/** One finding: required severity/title/detail, optional file/line/requirement, unknown keys dropped. */
function parseFinding(entry: unknown, index: number): { finding: ReviewFinding } | { error: string } {
  const at = `findings[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { error: `${at} is not an object` };
  const raw = entry as Record<string, unknown>;
  const severity = raw.severity;
  if (severity !== 'blocking' && severity !== 'advisory') return { error: `${at}.severity must be "blocking" or "advisory", received ${describeValue(severity)}` };
  const title = nonEmptyString(raw.title);
  if (title === undefined) return { error: `${at}.title must be a non-empty string` };
  const detail = nonEmptyString(raw.detail);
  if (detail === undefined) return { error: `${at}.detail must be a non-empty string` };
  const finding: ReviewFinding = { severity, title, detail };
  for (const field of ['file', 'requirement'] as const) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    const parsed = nonEmptyString(value);
    if (parsed === undefined) return { error: `${at}.${field} must be a non-empty string when present` };
    finding[field] = parsed;
  }
  const line = raw.line;
  if (line !== undefined && line !== null) {
    if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) return { error: `${at}.line must be a positive integer when present, received ${describeValue(line)}` };
    finding.line = line;
  }
  return { finding };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decide whether the reviewer changed nothing, from raw `git status --porcelain=v2` output that the
 * caller captured in the reviewer worktree (§7, §12). The module never runs git: the runner passes
 * stdout verbatim, and `true` means the review is based on an untouched checkout.
 *
 * Empty or whitespace-only output is clean. `#`-prefixed lines are the branch headers emitted by
 * `--porcelain=v2 --branch`, not changes; every other line is a change, including untracked (`?`)
 * and conflicted (`u`) entries. Anything else (a non-string) is reported as dirty, never as clean.
 */
export function reviewerWorkspaceIsClean(porcelainV2: string): boolean {
  if (typeof porcelainV2 !== 'string') return false;
  return porcelainV2.split(/\r?\n/).every((line) => {
    const trimmed = line.trim();
    return trimmed === '' || trimmed.startsWith('#');
  });
}

/** One raw validation outcome as reported by the workflow world (`world.run`) or the runner. */
export interface ValidationOutcome {
  command: string;
  exitCode: number;
  /** Wall-clock duration; `0` when the caller did not measure it. */
  durationMs?: number;
}

export interface ValidationRunInput {
  results: ValidationOutcome[];
  /** The discovered validation set (§6): these commands must pass before the gate may complete. */
  mandatory: string[];
  /** Caller-provided identity, so this module stays clock-free and deterministic. */
  ids: { missionId: string; commitSha: string; now: number };
}

export interface ValidationRunSummary {
  /** Domain rows only (domain §1): no store columns are embedded in `Validation`. */
  validations: Validation[];
  /**
   * The extras every row belongs to, kept out of `Validation` on purpose. Persist with
   * `store.insertValidation(row, { commitSha, createdAt })` so the gate can scope rows to the head.
   */
  commitSha: string;
  createdAt: number;
  /** Mandatory commands that failed or never ran, in `mandatory` order (deterministic). */
  failures: string[];
}

/**
 * Normalize raw command outcomes into `Validation` rows and list the mandatory commands that are not
 * green. Every result becomes a row (evidence is never dropped, including non-mandatory failures);
 * ids are derived from mission + command + commit per domain §5, so re-recording the same run is
 * idempotent and a repeated command gets a stable `_2`, `_3`, … suffix instead of colliding.
 */
export function summarizeValidationRun(input: ValidationRunInput): ValidationRunSummary {
  const { missionId, commitSha, now } = input.ids;
  const occurrences = new Map<string, number>();
  const validations = input.results.map((result): Validation => {
    const base = deriveId('val', missionId, commitSha, result.command);
    const occurrence = (occurrences.get(result.command) ?? 0) + 1;
    occurrences.set(result.command, occurrence);
    return {
      id: occurrence === 1 ? base : `${base}_${occurrence}`,
      missionId,
      phase: 'test',
      command: result.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs ?? 0,
      result: result.exitCode === 0 ? 'pass' : 'fail',
    };
  });
  const states = mandatoryStates(input.mandatory, (command) => {
    const rows = input.results.filter((result) => result.command === command);
    if (rows.length === 0) return 'missing';
    return rows.some((row) => row.exitCode !== 0) ? 'fail' : 'pass';
  });
  return { validations, commitSha, createdAt: now, failures: failedCommands(states) };
}

export interface AssessInput {
  mission: Mission;
  tasks: Task[];
  reviews: Review[];
  /** Rows for the current head; the caller scopes them by commit (`store.listValidations(id, head)`). */
  validations: Validation[];
  /** The accepted plan: its task keys are the dependency roots of every remediation task. */
  plan: MissionPlan;
  /** The discovered validation set (§6); a mandatory command with no passing row blocks completion. */
  mandatory?: string[];
  /** Alias of `mandatory` used by `runner.ts`. */
  mandatoryCommands?: string[];
  /** Worktrees holding uncommitted or unmerged work; `[]` when the runner verified none. */
  dirtyWorktrees: string[];
  maxReviewRounds: number;
  /**
   * Current mission-branch head as read from git. When supplied, reviews of other commits are
   * ignored: a `pass` for a superseded commit is not evidence about the head that exists now (§8).
   */
  commitSha?: string;
  /** Alias of `commitSha` used by `runner.ts`. */
  currentCommit?: string;
  /** Accepted for caller symmetry (`runner.ts` passes its clock). Unused: this module is clock-free. */
  now?: number;
}

export interface AssessResult {
  complete: boolean;
  blockers: Blocker[];
  remediation: PlanTask[];
}

/**
 * The completion gate plus the remediation it implies.
 *
 * `evaluateCompletion` (domain §6) owns the decision and is composed verbatim; this function only
 * fills the two gaps the gate cannot see (it has no mandatory-command set and no git head), then
 * turns "not complete" into bounded work:
 *
 * - a failed latest review yields `remediationTasksFor` — one task per blocking finding;
 * - failing or never-run mandatory commands yield exactly one task per command, keyed
 *   `fix-<round>-<n>` in the same round namespace (and numbering) as the review fixes;
 * - the `maxReviewRounds` ceiling turns exhaustion into blockers instead of more remediation;
 * - `complete` is true only for an empty blocker list.
 */
export function assessCompletion(input: AssessInput): AssessResult {
  const head = input.commitSha ?? input.currentCommit;
  const mandatory = input.mandatory ?? input.mandatoryCommands ?? [];
  const reviews = head === undefined ? [...input.reviews] : input.reviews.filter((review) => review.reviewedCommit === head);
  const gate = evaluateCompletion({
    mission: input.mission,
    tasks: input.tasks,
    reviews,
    validations: input.validations,
    dirtyWorktrees: input.dirtyWorktrees,
    maxReviewRounds: input.maxReviewRounds,
  });
  const blockers: Blocker[] = [...gate.blockers];
  const states = mandatoryStates(mandatory, (command) => {
    const rows = input.validations.filter((validation) => validation.command === command);
    if (rows.length === 0) return 'missing';
    return rows.some(isFailingValidation) ? 'fail' : 'pass';
  });
  const unfinished = failedCommands(states);
  const missing = states.filter((state) => state.state === 'missing').map((state) => state.command);
  if (missing.length > 0 && !hasBlocker(blockers, 'validation-missing')) {
    blockers.push({ code: 'validation-missing', message: `no recorded outcome for mandatory command(s): ${missing.join(', ')}` });
  }
  const latest = latestReview(reviews);
  const remediation: PlanTask[] = [];
  if (latest !== undefined && latest.verdict !== 'pass' && canOpenRound(latest.round, input.maxReviewRounds)) {
    remediation.push(...remediationTasksFor(latest, input.plan, input.mission.id));
  }
  if (unfinished.length > 0) {
    if (latest !== undefined && canOpenRound(latest.round, input.maxReviewRounds)) {
      remediation.push(...validationRemediation(unfinished, latest.round, input.plan, remediation));
    } else if (latest !== undefined && !hasBlocker(blockers, 'review-rounds-exhausted')) {
      blockers.push({ code: 'review-rounds-exhausted', message: `mandatory validation(s) failed and no review round is left within maxReviewRounds=${input.maxReviewRounds}` });
    }
  }
  return { complete: blockers.length === 0, blockers, remediation };
}

type MandatoryState = 'pass' | 'fail' | 'missing';

/** Per mandatory command verdict, deduplicated and in `mandatory` order (deterministic). */
function mandatoryStates(mandatory: readonly string[], stateOf: (command: string) => MandatoryState): { command: string; state: MandatoryState }[] {
  const seen = new Set<string>();
  const states: { command: string; state: MandatoryState }[] = [];
  for (const command of mandatory) {
    if (seen.has(command)) continue;
    seen.add(command);
    states.push({ command, state: stateOf(command) });
  }
  return states;
}

/** Commands that are not green, in the order they were declared. */
function failedCommands(states: { command: string; state: MandatoryState }[]): string[] {
  return states.filter((state) => state.state !== 'pass').map((state) => state.command);
}

/** Mirrors the gate's rule: a row fails when it recorded `fail` or a non-zero exit code. */
function isFailingValidation(validation: Validation): boolean {
  return validation.result === 'fail' || validation.exitCode !== 0;
}

/** One remediation task per unfinished command, keyed inside the round they were observed in. */
function validationRemediation(commands: readonly string[], round: number, plan: MissionPlan, already: readonly PlanTask[]): PlanTask[] {
  const taken = new Set<string>([...plan.tasks.map((task) => task.key), ...already.map((task) => task.key)]);
  const dependsOn = uniqueStrings(plan.tasks.map((task) => task.key));
  const tasks: PlanTask[] = [];
  for (const command of commands) {
    let index = 1;
    while (taken.has(`fix-${round}-${index}`)) index += 1;
    const key = `fix-${round}-${index}`;
    taken.add(key);
    const description = `The mandatory validation command "${command}" does not pass on the mission branch head. Make it pass without weakening or skipping it, then re-run it and report the exact outcome.`;
    tasks.push({ key, title: `Fix failing validation: ${command}`, description, dependsOn: [...dependsOn], filesHint: [], acceptance: [`"${command}" exits 0`, 'no other mandatory validation command regresses'], required: true });
  }
  return tasks;
}

/** A remediation cycle is possible only while a review round remains to judge it. */
function canOpenRound(currentRound: number, maxReviewRounds: number): boolean {
  return currentRound + 1 <= maxReviewRounds;
}

/**
 * Latest review round, with the gate's tie-break (round, then `createdAt`, then id) so the
 * remediation derived here always belongs to the review the gate judged.
 */
function latestReview(reviews: readonly Review[]): Review | undefined {
  let latest: Review | undefined;
  for (const review of reviews) if (latest === undefined || compareReviews(review, latest) > 0) latest = review;
  return latest;
}

function compareReviews(left: Review, right: Review): number {
  return left.round - right.round || left.createdAt - right.createdAt || compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function hasBlocker(blockers: readonly Blocker[], code: Blocker['code']): boolean {
  return blockers.some((blocker) => blocker.code === code);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
