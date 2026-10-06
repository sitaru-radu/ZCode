import assert from 'node:assert/strict';
import test from 'node:test';

import type { Mission, MissionPlan, PlanTask, Review, Task, Validation } from '@zcode/projects-core';

import {
  assessCompletion,
  buildReviewBrief,
  parseReviewVerdict,
  reviewerWorkspaceIsClean,
  summarizeValidationRun,
  type AssessInput,
  type ReviewBriefInput,
  type ReviewChangeFacts,
} from '../src/runner-review.js';

const NOW = 1_700_000_000_000;
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

const LONG_DIFF = [
  'diff --git a/src/health.ts b/src/health.ts',
  '--- a/src/health.ts',
  '+++ b/src/health.ts',
  '@@ -1,3 +1,6 @@',
  "+export function health() { return { status: 'ok' }; }",
].join('\n');

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'msn_1',
    projectId: 'prj_1',
    title: 'Add health endpoint',
    objective: 'Expose GET /health returning {"status":"ok"} without breaking existing routes.',
    source: { kind: 'text', text: 'add a health endpoint' },
    status: 'testing',
    phase: 'test',
    createdAt: NOW,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tsk_1',
    missionId: 'msn_1',
    planId: 'pln_1',
    planKey: 'health',
    title: 'Add the health route',
    description: 'Register GET /health in the router.',
    deps: [],
    required: true,
    filesHint: ['src/health.ts'],
    acceptance: ['GET /health returns 200', 'the body is {"status":"ok"}'],
    status: 'done',
    attempts: 1,
    ...overrides,
  };
}

function makePlanTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    key: 'health',
    title: 'Add the health route',
    description: 'Register GET /health in the router.',
    dependsOn: [],
    filesHint: ['src/health.ts'],
    acceptance: ['GET /health returns 200'],
    ...overrides,
  };
}

function makePlan(tasks: PlanTask[] = [makePlanTask()]): MissionPlan {
  return {
    id: 'pln_1',
    missionId: 'msn_1',
    version: 1,
    summary: 'Add the health endpoint',
    assumptions: [],
    affectedAreas: ['src'],
    tasks,
    validationPlan: ['npm test'],
    risks: [],
    createdAt: NOW,
  };
}

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: 'rev_1',
    missionId: 'msn_1',
    round: 1,
    verdict: 'pass',
    findings: [],
    reviewedCommit: HEAD,
    createdAt: NOW,
    ...overrides,
  };
}

function makeValidation(overrides: Partial<Validation> = {}): Validation {
  return {
    id: 'val_1',
    missionId: 'msn_1',
    phase: 'test',
    command: 'npm test',
    exitCode: 0,
    durationMs: 0,
    result: 'pass',
    ...overrides,
  };
}

/**
 * A store row: the domain `Validation` plus the store's own extras (`StoredValidation`,
 * `projects-store` domain §…), which is what `store.listValidations` hands to the gate.
 */
function makeStoredValidation(overrides: Partial<Validation> = {}, commitSha = HEAD): Validation & { commitSha: string } {
  return { ...makeValidation(), commitSha, ...overrides };
}

function makeFacts(overrides: Partial<ReviewChangeFacts> = {}): ReviewChangeFacts {
  return {
    branch: 'zcode/mission-1/integration',
    commit: HEAD,
    changedFiles: ['src/health.ts'],
    diffStat: ' src/health.ts | 3 +++\n 1 file changed, 3 insertions(+)',
    diff: LONG_DIFF,
    diffTruncated: false,
    instructions: [{ path: 'AGENTS.md', text: 'Run pnpm lint before pushing.' }],
    ...overrides,
  };
}

function makeBriefInput(overrides: Partial<ReviewBriefInput> = {}): ReviewBriefInput {
  return {
    mission: makeMission(),
    round: 1,
    reviewedCommit: HEAD,
    tasks: [makeTask()],
    facts: makeFacts(),
    ...overrides,
  };
}

function makeAssessInput(overrides: Partial<AssessInput> = {}): AssessInput {
  return {
    mission: makeMission(),
    tasks: [makeTask()],
    reviews: [makeReview()],
    validations: [makeStoredValidation()],
    plan: makePlan(),
    mandatory: ['npm test'],
    dirtyWorktrees: [],
    maxReviewRounds: 2,
    commitSha: HEAD,
    ...overrides,
  };
}

function blockerCodes(input: AssessInput): string[] {
  return assessCompletion(input).blockers.map((blocker) => blocker.code);
}

// --- buildReviewBrief -------------------------------------------------------

test('brief states the mission objective and identity', () => {
  const brief = buildReviewBrief(makeBriefInput());
  assert.match(brief, /Objective:\nExpose GET \/health/);
  assert.match(brief, /Mission id: msn_1/);
});

test('brief lists the acceptance criteria of the reviewed tasks', () => {
  const brief = buildReviewBrief(makeBriefInput());
  assert.match(brief, /Add the health route/);
  assert.match(brief, /GET \/health returns 200/);
  assert.match(brief, /the body is \{"status":"ok"\}/);
});

test('brief carries deterministic change facts', () => {
  const brief = buildReviewBrief(makeBriefInput());
  assert.match(brief, /Branch: zcode\/mission-1\/integration/);
  assert.match(brief, new RegExp(`Commit: ${HEAD}`));
  assert.match(brief, /- src\/health\.ts/);
  assert.match(brief, /1 file changed, 3 insertions\(\+\)/);
  assert.match(brief, /\+export function health\(\)/);
  assert.match(brief, /AGENTS\.md/);
  assert.match(brief, /Run pnpm lint before pushing/);
});

test('brief forbids modification explicitly', () => {
  const brief = buildReviewBrief(makeBriefInput());
  assert.match(brief, /You must not modify any file/);
  assert.match(brief, /invalidates this review/);
});

test('brief states the JSON verdict contract', () => {
  const brief = buildReviewBrief(makeBriefInput());
  assert.match(brief, /```json/);
  assert.match(brief, /"verdict": "pass" \| "fail"/);
  assert.match(brief, /"findings"/);
  assert.match(brief, /"severity": "blocking" \| "advisory"/);
  assert.match(brief, /"requirement"/);
});

test('brief reports truncation when the caller truncated the diff', () => {
  const brief = buildReviewBrief(makeBriefInput({ facts: makeFacts({ diffTruncated: true }) }));
  assert.match(brief, /TRUNCATED/);
});

test('brief is silent about truncation for a complete diff', () => {
  const brief = buildReviewBrief(makeBriefInput());
  assert.doesNotMatch(brief, /TRUNCATED/);
});

test('brief applies maxDiffChars and then says so', () => {
  const brief = buildReviewBrief(makeBriefInput({ maxDiffChars: 10 }));
  assert.match(brief, /diff --git/);
  assert.match(brief, /cut after 10 characters/);
  assert.match(brief, /TRUNCATED/);
  assert.doesNotMatch(brief, /export function health/);
});

test('brief is deterministic for the same input', () => {
  const input = makeBriefInput();
  assert.equal(buildReviewBrief(input), buildReviewBrief(input));
});

test('brief falls back to a diff-stat placeholder when the caller sent none', () => {
  const brief = buildReviewBrief({
    missionObjective: 'Expose GET /health returning {"status":"ok"}.',
    tasks: [{ title: 'Add the health route', acceptance: ['GET /health returns 200'] }],
    branch: 'zcode/mission-1/integration',
    commit: HEAD,
    changedFiles: ['src/health.ts'],
    diff: LONG_DIFF,
    instructions: [{ path: 'AGENTS.md', text: 'Run pnpm lint before pushing.' }],
    maxDiffChars: 60_000,
  });
  assert.match(brief, /Objective:\nExpose GET \/health/);
  assert.match(brief, new RegExp(`Reviewed commit: ${HEAD}`));
  assert.match(brief, /Branch: zcode\/mission-1\/integration/);
  assert.match(brief, /- src\/health\.ts/);
  assert.match(brief, /Diff stat:\n\(no diff stat was supplied; read the diff below\)/);
  assert.match(brief, /Add the health route/);
  assert.match(brief, /GET \/health returns 200/);
  assert.match(brief, /You must not modify any file/);
  assert.match(brief, /```json/);
  assert.doesNotMatch(brief, /TRUNCATED/);
});

test('brief caps an over-long flat diff and says so', () => {
  const brief = buildReviewBrief({
    missionObjective: 'Expose GET /health.',
    tasks: [],
    branch: 'zcode/mission-1/integration',
    commit: HEAD,
    changedFiles: [],
    diff: LONG_DIFF,
    maxDiffChars: 20,
  });
  assert.match(brief, /cut after 20 characters/);
  assert.match(brief, /TRUNCATED/);
  assert.doesNotMatch(brief, /export function health/);
});

// --- parseReviewVerdict -----------------------------------------------------

test('parses a valid pass verdict', () => {
  const result = parseReviewVerdict('Looks good.\n\n```json\n{"verdict":"pass","findings":[]}\n```\n');
  assert.deepEqual(result, { verdict: 'pass', findings: [] });
});

test('parses a valid fail verdict and keeps optional fields', () => {
  const reply = [
    '```json',
    JSON.stringify({
      verdict: 'fail',
      findings: [
        {
          severity: 'blocking',
          title: 'Route returns 500',
          detail: 'GET /health throws when the router has no db handle.',
          file: 'src/health.ts',
          line: 12,
          requirement: 'GET /health returns 200',
        },
      ],
    }),
    '```',
  ].join('\n');
  assert.deepEqual(parseReviewVerdict(reply), {
    verdict: 'fail',
    findings: [
      {
        severity: 'blocking',
        title: 'Route returns 500',
        detail: 'GET /health throws when the router has no db handle.',
        file: 'src/health.ts',
        line: 12,
        requirement: 'GET /health returns 200',
      },
    ],
  });
});

test('drops unknown fields at every level', () => {
  const reply = [
    '```json',
    JSON.stringify({
      verdict: 'fail',
      confidence: 0.9,
      findings: [{ severity: 'advisory', title: 'Naming', detail: 'Prefer handler().', noise: [1, 2] }],
    }),
    '```',
  ].join('\n');
  assert.deepEqual(parseReviewVerdict(reply), {
    verdict: 'fail',
    findings: [{ severity: 'advisory', title: 'Naming', detail: 'Prefer handler().' }],
  });
});

test('takes the last fenced json block', () => {
  const reply = [
    'Example of the contract:',
    '```json',
    '{"verdict":"fail","findings":[{"severity":"blocking","title":"example","detail":"example"}]}',
    '```',
    'My verdict:',
    '```json',
    '{"verdict":"pass","findings":[{"severity":"advisory","title":"Nit","detail":"Rename the file."}]}',
    '```',
  ].join('\n');
  const result = parseReviewVerdict(reply);
  assert.ok(!('error' in result));
  assert.equal(result.verdict, 'pass');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.title, 'Nit');
});

test('reports a missing json block', () => {
  const result = parseReviewVerdict('I reviewed the change and it looks fine to me.');
  assert.ok('error' in result);
  assert.match(result.error, /no fenced ```json block/);
});

test('ignores fenced blocks that are not tagged json', () => {
  const result = parseReviewVerdict('```\n{"verdict":"pass","findings":[]}\n```');
  assert.ok('error' in result);
  assert.match(result.error, /no fenced ```json block/);
});

test('reports invalid JSON', () => {
  const result = parseReviewVerdict('```json\n{ "verdict": "pass", "findings": [], }\n```');
  assert.ok('error' in result);
  assert.match(result.error, /not valid JSON/);
});

test('reports a non-object payload without throwing', () => {
  for (const body of ['null', '[]', '"pass"', '42']) {
    const result = parseReviewVerdict(`\`\`\`json\n${body}\n\`\`\``);
    assert.ok('error' in result, `expected an error for ${body}`);
    assert.match(result.error, /not a JSON object/);
  }
});

test('rejects a verdict outside pass|fail', () => {
  const result = parseReviewVerdict('```json\n{"verdict":"maybe","findings":[]}\n```');
  assert.ok('error' in result);
  assert.match(result.error, /must be "pass" or "fail"/);
});

test('rejects a verdict with no findings array', () => {
  const missing = parseReviewVerdict('```json\n{"verdict":"fail"}\n```');
  assert.ok('error' in missing);
  assert.match(missing.error, /no "findings" array/);

  const wrongType = parseReviewVerdict('```json\n{"verdict":"fail","findings":{}}\n```');
  assert.ok('error' in wrongType);
  assert.match(wrongType.error, /no "findings" array/);
});

test('rejects a pass verdict that carries a blocking finding', () => {
  const reply = [
    '```json',
    JSON.stringify({
      verdict: 'pass',
      findings: [{ severity: 'blocking', title: 'Missing test', detail: 'No test covers /health.' }],
    }),
    '```',
  ].join('\n');
  const result = parseReviewVerdict(reply);
  assert.ok('error' in result);
  assert.match(result.error, /"pass" but finding "Missing test" is blocking/);
});

test('allows advisory findings on a pass verdict', () => {
  const reply = [
    '```json',
    JSON.stringify({
      verdict: 'pass',
      findings: [{ severity: 'advisory', title: 'Nit', detail: 'Consider a named export.' }],
    }),
    '```',
  ].join('\n');
  const result = parseReviewVerdict(reply);
  assert.ok(!('error' in result));
  assert.equal(result.verdict, 'pass');
});

test('rejects bad finding severity, title and detail', () => {
  const cases: [string, RegExp][] = [
    ['{"severity":"critical","title":"t","detail":"d"}', /severity must be/],
    ['{"severity":"blocking","detail":"d"}', /title must be a non-empty string/],
    ['{"severity":"blocking","title":"   ","detail":"d"}', /title must be a non-empty string/],
    ['{"severity":"blocking","title":"t"}', /detail must be a non-empty string/],
  ];
  for (const [finding, pattern] of cases) {
    const result = parseReviewVerdict(`\`\`\`json\n{"verdict":"fail","findings":[${finding}]}\n\`\`\``);
    assert.ok('error' in result, `expected an error for ${finding}`);
    assert.match(result.error, pattern);
  }
});

test('rejects non-object findings', () => {
  const result = parseReviewVerdict('```json\n{"verdict":"fail","findings":["blocking"]}\n```');
  assert.ok('error' in result);
  assert.match(result.error, /findings\[0\] is not an object/);
});

test('rejects bad line values', () => {
  for (const line of ['0', '-3', '1.5', '"12"', 'true']) {
    const reply = `\`\`\`json\n{"verdict":"fail","findings":[{"severity":"advisory","title":"t","detail":"d","line":${line}}]}\n\`\`\``;
    const result = parseReviewVerdict(reply);
    assert.ok('error' in result, `expected an error for line ${line}`);
    assert.match(result.error, /line must be a positive integer/);
  }
});

test('treats null optionals as absent and rejects empty optional strings', () => {
  const nulls = parseReviewVerdict(
    '```json\n{"verdict":"fail","findings":[{"severity":"advisory","title":"t","detail":"d","file":null,"line":null,"requirement":null}]}\n```',
  );
  assert.deepEqual(nulls, { verdict: 'fail', findings: [{ severity: 'advisory', title: 't', detail: 'd' }] });

  const empty = parseReviewVerdict(
    '```json\n{"verdict":"fail","findings":[{"severity":"advisory","title":"t","detail":"d","file":"  "}]}\n```',
  );
  assert.ok('error' in empty);
  assert.match(empty.error, /file must be a non-empty string/);
});

test('trims whitespace around parsed strings', () => {
  const result = parseReviewVerdict(
    '```json\n{"verdict":"fail","findings":[{"severity":"blocking","title":"  T  ","detail":"  D  ","file":" src/a.ts "}]}\n```',
  );
  assert.deepEqual(result, {
    verdict: 'fail',
    findings: [{ severity: 'blocking', title: 'T', detail: 'D', file: 'src/a.ts' }],
  });
});

test('never throws on hostile input', () => {
  const samples = [
    '',
    '```json',
    '```json\n',
    '```json\n{{{',
    '```json\nundefined\n```',
    '```json\n{"verdict":"pass","findings":[]}\n```trailing',
    '\u0000```json\n{"verdict":"pass"}\n```',
  ];
  for (const sample of samples) {
    const result = parseReviewVerdict(sample);
    if ('error' in result) {
      assert.equal(typeof result.error, 'string');
    } else {
      assert.equal(result.verdict, 'pass');
    }
  }
});

// --- reviewerWorkspaceIsClean ----------------------------------------------

test('treats empty and whitespace-only porcelain output as clean', () => {
  assert.equal(reviewerWorkspaceIsClean(''), true);
  assert.equal(reviewerWorkspaceIsClean('   '), true);
  assert.equal(reviewerWorkspaceIsClean('\n\n  \n'), true);
});

test('ignores --branch headers', () => {
  const porcelain = ['# branch.oid a1b2c3', '# branch.head (detached)', '# branch.ab +0 -0', ''].join('\n');
  assert.equal(reviewerWorkspaceIsClean(porcelain), true);
});

test('detects modified files', () => {
  assert.equal(
    reviewerWorkspaceIsClean('1 .M N... 100644 100644 100644 aaa bbb src/health.ts\n'),
    false,
  );
  assert.equal(
    reviewerWorkspaceIsClean('1 M. N... 100644 100644 100644 aaa bbb src/health.ts\n'),
    false,
  );
  assert.equal(
    reviewerWorkspaceIsClean('2 .M N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts\n'),
    false,
  );
});

test('detects untracked files', () => {
  assert.equal(reviewerWorkspaceIsClean('? notes.txt\n'), false);
  assert.equal(reviewerWorkspaceIsClean('# branch.head (detached)\n? notes.txt\n'), false);
});

test('detects conflicts', () => {
  const porcelain = 'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts\n';
  assert.equal(reviewerWorkspaceIsClean(porcelain), false);
});

test('handles CRLF output', () => {
  assert.equal(reviewerWorkspaceIsClean('# branch.head (detached)\r\n'), true);
  assert.equal(reviewerWorkspaceIsClean('1 .M N... 100644 100644 100644 aaa bbb src/health.ts\r\n'), false);
});

// --- summarizeValidationRun -------------------------------------------------

test('normalizes passing results into test-phase rows', () => {
  const summary = summarizeValidationRun({
    results: [
      { command: 'npm run lint', exitCode: 0 },
      { command: 'npm test', exitCode: 0 },
    ],
    mandatory: ['npm run lint', 'npm test'],
    ids: { missionId: 'msn_1', commitSha: HEAD, now: NOW },
  });

  assert.deepEqual(summary.failures, []);
  assert.equal(summary.validations.length, 2);
  const first = summary.validations[0];
  assert.equal(first?.missionId, 'msn_1');
  assert.equal(first?.phase, 'test');
  assert.equal(first?.command, 'npm run lint');
  assert.equal(first?.exitCode, 0);
  assert.equal(first?.durationMs, 0);
  assert.equal(first?.result, 'pass');
  // The domain row stays clean: commit and creation time travel beside it, not inside it.
  assert.equal('commitSha' in (first ?? {}), false);
  assert.equal('createdAt' in (first ?? {}), false);
  assert.equal(summary.commitSha, HEAD);
  assert.equal(summary.createdAt, NOW);
  assert.match(first?.id ?? '', /^val_[a-z2-7]{10}$/);
  assert.notEqual(summary.validations[0]?.id, summary.validations[1]?.id);
});

test('keeps a supplied durationMs', () => {
  const summary = summarizeValidationRun({
    results: [{ command: 'npm test', exitCode: 0, durationMs: 1234 }],
    mandatory: ['npm test'],
    ids: { missionId: 'msn_1', commitSha: HEAD, now: NOW },
  });
  assert.equal(summary.validations[0]?.durationMs, 1234);
});

test('reports a mandatory failure with its exit code', () => {
  const summary = summarizeValidationRun({
    results: [
      { command: 'npm run lint', exitCode: 0 },
      { command: 'npm test', exitCode: 1 },
    ],
    mandatory: ['npm run lint', 'npm test'],
    ids: { missionId: 'msn_1', commitSha: HEAD, now: NOW },
  });
  assert.deepEqual(summary.failures, ['npm test']);
  assert.equal(summary.validations[1]?.result, 'fail');
  assert.equal(summary.validations[1]?.exitCode, 1);
});

test('reports a mandatory command that never ran', () => {
  const summary = summarizeValidationRun({
    results: [{ command: 'npm run lint', exitCode: 0 }],
    mandatory: ['npm test', 'npm run lint'],
    ids: { missionId: 'msn_1', commitSha: HEAD, now: NOW },
  });
  assert.deepEqual(summary.failures, ['npm test']);
  assert.equal(summary.validations.length, 1);
});

test('ignores a non-mandatory failure for the failure list but still records it', () => {
  const summary = summarizeValidationRun({
    results: [
      { command: 'npm test', exitCode: 0 },
      { command: 'npm run build', exitCode: 2 },
    ],
    mandatory: ['npm test'],
    ids: { missionId: 'msn_1', commitSha: HEAD, now: NOW },
  });
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.validations[1]?.command, 'npm run build');
  assert.equal(summary.validations[1]?.result, 'fail');
});

test('lists failures in mandatory order and deduplicates the mandatory set', () => {
  const summary = summarizeValidationRun({
    results: [{ command: 'npm run build', exitCode: 1 }],
    mandatory: ['npm run build', 'npm test', 'npm run build'],
    ids: { missionId: 'msn_1', commitSha: HEAD, now: NOW },
  });
  assert.deepEqual(summary.failures, ['npm run build', 'npm test']);
});

test('derives ids deterministically from mission, command and commit', () => {
  const base = { results: [{ command: 'npm test', exitCode: 0 }], mandatory: ['npm test'] };
  const first = summarizeValidationRun({ ...base, ids: { missionId: 'msn_1', commitSha: HEAD, now: NOW } });
  const again = summarizeValidationRun({ ...base, ids: { missionId: 'msn_1', commitSha: HEAD, now: NOW + 5000 } });
  const otherCommit = summarizeValidationRun({ ...base, ids: { missionId: 'msn_1', commitSha: OLD_HEAD, now: NOW } });
  const otherMission = summarizeValidationRun({ ...base, ids: { missionId: 'msn_2', commitSha: HEAD, now: NOW } });

  assert.equal(first.validations[0]?.id, again.validations[0]?.id);
  assert.notEqual(first.validations[0]?.id, otherCommit.validations[0]?.id);
  assert.notEqual(first.validations[0]?.id, otherMission.validations[0]?.id);
});

test('gives repeated commands distinct stable ids', () => {
  const summary = summarizeValidationRun({
    results: [
      { command: 'npm test', exitCode: 1 },
      { command: 'npm test', exitCode: 0 },
    ],
    mandatory: ['npm test'],
    ids: { missionId: 'msn_1', commitSha: HEAD, now: NOW },
  });
  const [first, second] = summary.validations;
  assert.equal(second?.id, `${first?.id}_2`);
  assert.equal(first?.result, 'fail');
  assert.equal(second?.result, 'pass');
  assert.deepEqual(summary.failures, ['npm test']);
});

// --- assessCompletion -------------------------------------------------------

test('completes only with a passing review at the head and every mandatory validation green', () => {
  const result = assessCompletion(makeAssessInput());
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.remediation, []);
  assert.equal(result.complete, true);
});

test('does not complete without a review', () => {
  const input = makeAssessInput({ reviews: [] });
  const result = assessCompletion(input);
  assert.equal(result.complete, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'no-review'));
});

test('does not complete on a passing review of a superseded commit', () => {
  const input = makeAssessInput({ reviews: [makeReview({ reviewedCommit: OLD_HEAD })] });
  const result = assessCompletion(input);
  assert.equal(result.complete, false);
  assert.deepEqual(blockerCodes(input), ['no-review']);
});

test('does not complete when a mandatory validation never ran', () => {
  const input = makeAssessInput({ mandatory: ['npm test', 'npm run lint'] });
  const result = assessCompletion(input);
  assert.equal(result.complete, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'validation-missing'));
  assert.deepEqual(result.remediation.map((task) => task.key), ['fix-1-1']);
  assert.match(result.remediation[0]?.title ?? '', /npm run lint/);
});

test('does not re-scope validations: the caller supplies the rows for the head', () => {
  const input = makeAssessInput({ validations: [makeStoredValidation({}, OLD_HEAD)] });
  assert.equal(assessCompletion(input).complete, true);
});

test('turns a failing mandatory command into exactly one remediation task', () => {
  const input = makeAssessInput({
    validations: [makeStoredValidation({ command: 'npm test', exitCode: 1, result: 'fail' })],
  });
  const result = assessCompletion(input);
  assert.equal(result.complete, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'validation-failed'));
  assert.equal(result.remediation.length, 1);
  const task = result.remediation[0];
  assert.equal(task?.key, 'fix-1-1');
  assert.match(task?.title ?? '', /Fix failing validation: npm test/);
  assert.deepEqual(task?.dependsOn, ['health']);
  assert.equal(task?.required, true);
  assert.ok((task?.acceptance ?? []).some((criterion) => criterion.includes('npm test')));
});

test('emits one remediation task per failing command, in mandatory order', () => {
  const input = makeAssessInput({
    mandatory: ['npm test', 'npm run lint'],
    validations: [
      makeStoredValidation({ command: 'npm test', exitCode: 1, result: 'fail' }),
      makeStoredValidation({ command: 'npm run lint', exitCode: 1, result: 'fail' }),
    ],
  });
  const result = assessCompletion(input);
  assert.deepEqual(result.remediation.map((task) => task.key), ['fix-1-1', 'fix-1-2']);
  assert.match(result.remediation[0]?.title ?? '', /npm test/);
  assert.match(result.remediation[1]?.title ?? '', /npm run lint/);
});

test('ignores a failing non-mandatory command for remediation', () => {
  const input = makeAssessInput({
    validations: [
      makeStoredValidation({ command: 'npm test', exitCode: 0 }),
      makeStoredValidation({ command: 'npm run build', exitCode: 1, result: 'fail' }),
    ],
  });
  const result = assessCompletion(input);
  assert.equal(result.complete, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'validation-failed'));
  assert.deepEqual(result.remediation, []);
});

test('derives remediation from the blocking findings of a failed review', () => {
  const input = makeAssessInput({
    reviews: [
      makeReview({
        verdict: 'fail',
        findings: [
          { severity: 'blocking', title: 'Route returns 500', detail: 'Throws without a db handle.', file: 'src/health.ts', line: 12 },
          { severity: 'advisory', title: 'Nit', detail: 'Rename the helper.' },
          { severity: 'blocking', title: 'No test', detail: 'Nothing covers /health.', requirement: 'GET /health returns 200' },
        ],
      }),
    ],
  });
  const result = assessCompletion(input);
  assert.equal(result.complete, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'review-failed'));
  assert.ok(result.blockers.some((blocker) => blocker.code === 'blocking-findings'));
  assert.deepEqual(result.remediation.map((task) => task.key), ['fix-1-1', 'fix-1-2']);
  assert.deepEqual(result.remediation[0]?.dependsOn, ['health']);
  assert.match(result.remediation[0]?.title ?? '', /Route returns 500/);
  assert.match(result.remediation[1]?.title ?? '', /No test/);
});

test('does not remediate a review that already passed', () => {
  const input = makeAssessInput({ reviews: [makeReview({ verdict: 'pass', findings: [] })] });
  const result = assessCompletion(input);
  assert.equal(result.complete, true);
  assert.deepEqual(result.remediation, []);
});

test('numbers validation remediation after review remediation in the same round', () => {
  const input = makeAssessInput({
    reviews: [
      makeReview({
        verdict: 'fail',
        findings: [{ severity: 'blocking', title: 'Route returns 500', detail: 'Throws without a db handle.' }],
      }),
    ],
    validations: [makeStoredValidation({ command: 'npm test', exitCode: 1, result: 'fail' })],
  });
  const result = assessCompletion(input);
  assert.deepEqual(result.remediation.map((task) => task.key), ['fix-1-1', 'fix-1-2']);
  assert.match(result.remediation[1]?.title ?? '', /npm test/);
});

test('turns an exhausted review ceiling into blockers, not remediation', () => {
  const input = makeAssessInput({
    maxReviewRounds: 2,
    reviews: [
      makeReview({
        round: 2,
        verdict: 'fail',
        findings: [{ severity: 'blocking', title: 'Still broken', detail: 'The route still throws.' }],
      }),
    ],
  });
  const result = assessCompletion(input);
  assert.equal(result.complete, false);
  assert.deepEqual(result.remediation, []);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'review-rounds-exhausted'));
  assert.ok(result.blockers.some((blocker) => blocker.code === 'review-failed'));
});

test('turns a validation failure with no round left into a blocker, not remediation', () => {
  const input = makeAssessInput({
    maxReviewRounds: 2,
    reviews: [makeReview({ round: 2, verdict: 'pass' })],
    validations: [makeStoredValidation({ command: 'npm test', exitCode: 1, result: 'fail' })],
  });
  const result = assessCompletion(input);
  assert.equal(result.complete, false);
  assert.deepEqual(result.remediation, []);
  assert.deepEqual(blockerCodes(input), ['validation-failed', 'review-rounds-exhausted']);
});

test('completes in the last allowed round when the review passes and tests are green', () => {
  const input = makeAssessInput({ maxReviewRounds: 2, reviews: [makeReview({ round: 2, verdict: 'pass' })] });
  assert.equal(assessCompletion(input).complete, true);
});

test('reports each blocker independently and never completes while one remains', () => {
  const input = makeAssessInput({
    tasks: [makeTask({ status: 'running' })],
    dirtyWorktrees: ['/tmp/wt/task-health'],
    validations: [makeStoredValidation({ command: 'npm test', exitCode: 1, result: 'fail' })],
  });
  const result = assessCompletion(input);
  assert.equal(result.complete, false);
  assert.deepEqual(blockerCodes(input), [
    'tasks-incomplete',
    'validation-failed',
    'dirty-worktrees',
  ]);
  assert.equal(result.complete, result.blockers.length === 0);
});

test('is deterministic for the same input', () => {
  const input = makeAssessInput({
    reviews: [
      makeReview({
        verdict: 'fail',
        findings: [{ severity: 'blocking', title: 'Route returns 500', detail: 'Throws without a db handle.' }],
      }),
    ],
    validations: [makeStoredValidation({ command: 'npm test', exitCode: 1, result: 'fail' })],
  });
  assert.deepEqual(assessCompletion(input), assessCompletion(input));
});

test('accepts the alias field names runner.ts passes', () => {
  const failing = makeStoredValidation({ command: 'npm test', exitCode: 1, result: 'fail' });
  const specNamed = assessCompletion(makeAssessInput({ validations: [failing] }));
  const aliased = assessCompletion({
    mission: makeMission(),
    tasks: [makeTask()],
    reviews: [makeReview()],
    validations: [failing],
    plan: makePlan(),
    mandatoryCommands: ['npm test'],
    dirtyWorktrees: [],
    maxReviewRounds: 2,
    currentCommit: HEAD,
    now: NOW,
  });
  assert.deepEqual(aliased, specNamed);
  assert.equal(aliased.complete, false);
  assert.deepEqual(aliased.remediation.map((task) => task.key), ['fix-1-1']);
});
