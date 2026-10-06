/**
 * Tests for `compilePlanToScript`.
 *
 * Most assertions read the emitted script the way the dynamic-workflow compiler does: at the
 * structural level — which call, in which order — rather than pinning the whole file. Three pin
 * more: the escaping test reconstructs the escaped literal, `the emitted script compiles through
 * the engine pipeline` runs the real compiler the mission flow uses, and the concurrency tests
 * assert dispatch order, the one property no single line can show.
 *
 * Import specifiers carry `.js` because the package is NodeNext. `tsx` maps them back to the
 * `.ts` sources; a `dist/` left behind by an older `pnpm build` shadows them, so remove or
 * rebuild it before running these tests — the authoritative artifact is the current source.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { CompilePlanInput } from '../src/compile-plan.js';
import { COMPILE_PLAN_SCRIPT_FORMAT, compilePlanToScript } from '../src/compile-plan.js';
import { ScriptCompileError, compileMissionScript } from '../src/runner-execute.js';

/**
 * A plan with one dependency chain (`wire` → `schema` → `cache`) and one hostile description, so
 * every wave holds exactly one task. This fixture pins the ordering guarantees.
 */
function sampleInput(): CompilePlanInput {
  return {
    plan: {
      objective: 'Add a cache layer to the projects service.',
      tasks: [
        {
          key: 'wire',
          title: 'Wire the cache into the service',
          description: 'Use the cache from the plan task above.',
          dependsOn: ['schema'],
          filesHint: ['apps/zcode-cli/packages/projects-store/src/cache.ts'],
          acceptance: ['The service reads through the cache.'],
        },
        {
          key: 'cache',
          title: 'Add the cache module; beware `backticks`, ${interpolation} and "quotes"',
          description:
            'Implement a small LRU.\nSecond line.\nThen a `code span` and ${aTemplate} and "quotes".',
          dependsOn: [],
          acceptance: ['LRU evicts the least recently used entry.'],
          filesHint: ['src\\cache.ts'],
        },
        {
          key: 'schema',
          title: 'Define the cache schema',
          description: 'Types only.',
          dependsOn: ['cache'],
          acceptance: [],
        },
      ],
      validationPlan: [],
    },
    repoInstructions: 'Run pnpm lint before every commit.\nNever edit specs/.',
    taskValidationCommands: { cache: ['pnpm exec vitest run src/cache.test.ts'] },
    validationCommands: [
      { cmd: 'pnpm', args: ['--filter', '@zcode/projects-store', 'lint'] },
      { cmd: 'pnpm', args: ['test'], timeoutMs: 60000 },
    ],
    extraWorkingRules: ['Keep the diff under 400 lines per file.'],
    integrationWorktreeHint: 'C:/work/missions/msn_1/integration',
  };
}

/**
 * Two independent tasks (the shape the live mission ran) plus one that depends on both, so the
 * first wave is a real fan-out and the second is a join.
 */
function fanOutInput(): CompilePlanInput {
  return {
    plan: {
      objective: 'Add two independent routes to the service.',
      tasks: [
        {
          key: 'implement-health-route',
          title: 'Implement the health route',
          description: 'Add the health endpoint.',
          dependsOn: [],
        },
        {
          key: 'implement-metrics-route',
          title: 'Implement the metrics route',
          description: 'Add the metrics endpoint.',
          dependsOn: [],
        },
        {
          key: 'document-routes',
          title: 'Document both routes',
          description: 'Describe both endpoints.',
          dependsOn: ['implement-health-route', 'implement-metrics-route'],
        },
      ],
    },
    validationCommands: [{ cmd: 'pnpm', args: ['test'] }],
  };
}

/** One-based line numbers of every line containing `needle`. */
function findLines(script: string, needle: string): number[] {
  return script
    .split('\n')
    .map((line, index) => (line.includes(needle) ? index + 1 : 0))
    .filter((line) => line > 0);
}

/** The first `agent("task-key", …)` line, which dispatches that task in its wave. */
function agentLineFor(script: string, key: string): number {
  const lines = findLines(script, `agent("task-${key}"`);
  assert.equal(lines.length, 1, 'exactly one agent for ' + key + ' (got ' + lines.length + ')');
  return lines[0] ?? 0;
}

/** Every line on which a wave settles: `const waveSettled = await Promise.all(`. */
function waveAwaitLines(script: string): number[] {
  return findLines(script, 'const waveSettled = await Promise.all(');
}

/** The lines that dispatch a task's ask: exactly one per task. */
function dispatchLines(script: string, key: string): number[] {
  return findLines(script, `agent("task-${key}", `);
}

test('identical plans produce byte-identical scripts and site maps', () => {
  const first = compilePlanToScript(sampleInput());
  const second = compilePlanToScript(sampleInput());
  assert.equal(first.script, second.script);
  assert.deepEqual(first.siteMap, second.siteMap);
  assert.deepEqual(compilePlanToScript(fanOutInput()), compilePlanToScript(fanOutInput()));
  assert.ok(first.script.length > 0);
});

test('the loaded generator is the current one, not a stale build', () => {
  // `../src/compile-plan.js` resolves to `dist/compile-plan.js` when an older build left one, and
  // every assertion below would then describe yesterday's generator. Assert the current shape
  // directly, so a stale build fails here instead of passing quietly.
  const { script } = compilePlanToScript(sampleInput());
  assert.ok(
    script.includes('const waveNodes = ['),
    'stale build detected: run `pnpm --filter @zcode/projects-mission build` (or delete dist/) first',
  );
  assert.equal(COMPILE_PLAN_SCRIPT_FORMAT, 'wave-v2');
});

test('the script declares the typed-ask interfaces and both phases in order', () => {
  const { script } = compilePlanToScript(sampleInput());
  const taskOutcome = script.indexOf('interface TaskOutcome {');
  const missionReport = script.indexOf('interface MissionReport {');
  const execute = script.indexOf('phase("execute");');
  const testPhase = script.indexOf('phase("test");');

  assert.ok(taskOutcome >= 0, 'TaskOutcome is declared');
  assert.ok(missionReport > taskOutcome, 'MissionReport follows it');
  assert.ok(execute > missionReport, 'the execute phase opens after the declarations');
  assert.ok(testPhase > execute, 'the test phase opens after execute');
  for (const field of [
    'status: "done" | "blocked";',
    'summary: string;',
    'filesChanged: string[];',
    'acceptance: { criterion: string; met: boolean; evidence: string }[];',
    'validationCommands: string[];',
    'blockers: string[];',
  ]) {
    assert.ok(script.includes(field), 'TaskOutcome declares ' + field);
  }
  assert.ok(script.includes('tasks: TaskOutcome[];'), 'MissionReport carries the tasks');
  assert.ok(
    script.includes('validations: { command: string; exitCode: number }[];'),
    'MissionReport carries the validation results',
  );
});

test('every task gets one actor named task-<key>, and the site map resolves it', () => {
  const { script, siteMap } = compilePlanToScript(sampleInput());
  const names = [...script.matchAll(/agent\("(task-[^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(names.sort(), ['task-cache', 'task-schema', 'task-wire']);
  assert.equal(new Set(names).size, names.length, 'actor names are unique');
  assert.deepEqual(siteMap, {
    cache: 'task-cache',
    schema: 'task-schema',
    wire: 'task-wire',
  });
  assert.deepEqual(compilePlanToScript(fanOutInput()).siteMap, {
    'document-routes': 'task-document-routes',
    'implement-health-route': 'task-implement-health-route',
    'implement-metrics-route': 'task-implement-metrics-route',
  });
});

test('independent tasks are dispatched together in one wave, before the first await', () => {
  const { script } = compilePlanToScript(fanOutInput());
  const awaits = waveAwaitLines(script);
  const health = agentLineFor(script, 'implement-health-route');
  const metrics = agentLineFor(script, 'implement-metrics-route');

  assert.equal(awaits.length, 2, 'one wave await per dependency layer (fan-out, join)');
  const [firstWaveAwait] = awaits as [number, number];
  assert.ok(health < firstWaveAwait, 'the health actor is dispatched before the wave is awaited');
  assert.ok(metrics < firstWaveAwait, 'the metrics actor is dispatched before the wave is awaited');
  assert.ok(
    !script
      .split('\n')
      .slice(health, metrics)
      .some((line) => line.includes('await ')),
    'no await sits between the two independent dispatches',
  );
  assert.equal(
    script.split('\n').filter((line) => line.trim() === 'const waveNodes = [').length,
    2,
    'one wave array per layer: both asks are in a single array the engine can start together',
  );
  assert.equal(findLines(script, 'phase("execute");').length, 1, 'one execute phase covers both waves');
});

test('a later wave starts only after every dependency it needs has settled', () => {
  const { script } = compilePlanToScript(fanOutInput());
  const [fanOutAwait = 0, joinAwait = 0] = waveAwaitLines(script);
  const joinDispatch = agentLineFor(script, 'document-routes');

  assert.ok(fanOutAwait > 0 && joinAwait > fanOutAwait, 'the two waves settle in order');
  assert.ok(
    joinDispatch > fanOutAwait && joinDispatch < joinAwait,
    'the dependent task is dispatched only after the fan-out wave settled',
  );
  for (const dependency of ['implement_health_route', 'implement_metrics_route']) {
    const line = findLines(script, `  await node_${dependency};`)[0];
    assert.ok(line !== undefined, dependency + ' is awaited by name before the join');
    assert.ok(line < joinDispatch, 'awaiting ' + dependency + ' precedes the join dispatch');
  }
});

test('a dependency ask is awaited before the dependent actor is dispatched', () => {
  const { script } = compilePlanToScript(sampleInput());

  for (const [dependent, dependency] of [
    ['wire', 'schema'],
    ['schema', 'cache'],
  ] as const) {
    const awaited = findLines(script, `  await node_${dependency};`);
    assert.equal(awaited.length, 1, 'the dependent awaits node_' + dependency + ' exactly once');
    // In the wave shape the actor is created and its ask dispatched on one line, so that line is
    // what the predecessor's await has to precede: the driver creates the worktree at dispatch.
    assert.ok(
      (awaited[0] ?? 0) < agentLineFor(script, dependent),
      'awaiting ' + dependency + ' precedes dispatching the ' + dependent + ' ask',
    );
  }
  // Independent tasks are ordered deterministically by key, so cache precedes schema.
  assert.ok(agentLineFor(script, 'cache') < agentLineFor(script, 'schema'));
  assert.ok(script.includes('node_cache = waveNodes[0];'), 'each wave publishes its nodes');
  assert.ok(script.includes('node_schema = waveNodes[0];'));
});

test('each ask is wrapped so a failure becomes a blocked outcome instead of failing the run', () => {
  const { script } = compilePlanToScript(sampleInput());

  assert.equal(dispatchLines(script, 'cache').length, 1, 'a task is dispatched exactly once');
  assert.equal(
    findLines(script, 'node.then(').length,
    3,
    'every node is mapped through a settle handler',
  );
  assert.equal(
    findLines(
      script,
      '(error: unknown) => ({ ok: false, outcome: blockedOutcome(String(error)), error: String(error) }),',
    ).length,
    3,
    'a rejected ask becomes a blocked outcome',
  );
  assert.equal(findLines(script, 'taskOutcomes.push(').length, 3, 'each outcome is collected');
  assert.equal(
    findLines(script, 'function blockedOutcome(reason: string): TaskOutcome {').length,
    1,
    'one helper builds the blocked outcome every failure path uses',
  );
  assert.equal(
    findLines(script, 'const settled_cache = waveSettled[0];').length,
    1,
    'the wave indexes its settled array once per task',
  );
  assert.equal(
    findLines(script, 'if (settled_cache === undefined) {').length,
    1,
    'a missing array entry is guarded explicitly rather than typed away',
  );
  assert.equal(
    findLines(script, 'let node_cache: Node<TaskOutcome>;').length,
    1,
    'each node is declared at script scope so a dependent wave can await it',
  );
  assert.equal(
    findLines(
      script,
      'const outcome_cache: TaskOutcome = settled_cache.ok ? settled_cache.outcome : blockedOutcome(settled_cache.error);',
    ).length,
    1,
    'the ask result is used when it settled, the failure text otherwise',
  );
  assert.equal(
    findLines(script, 'if (!settled_cache.ok) log("task " + "cache" + " blocked: " + settled_cache.error);')
      .length,
    1,
    'the blocked task is narrated with its key',
  );
  // The wave itself must never reject: every node is mapped through its own rejection handler
  // inside the wave, so one failing task cannot take the run down.
  const handlers = findLines(script, 'node.then(');
  const nodes = findLines(script, 'const waveNodes = [');
  const settles = findLines(script, 'const waveSettled = await Promise.all(');
  assert.equal(nodes.length, 3);
  assert.equal(settles.length, 3);
  for (const [index, node] of nodes.entries()) {
    // The mapping is an argument of the `await Promise.all(...)`, so it is evaluated before the
    // wave can settle; structurally it must sit inside that wave's own block.
    assert.ok((handlers[index] ?? 0) > node, 'the wave maps its nodes through the handler');
    assert.ok((handlers[index] ?? 0) < (settles[index + 1] ?? Number.MAX_SAFE_INTEGER));
  }
});

test('validation commands are emitted as literals with their argv and exit codes are collected', () => {
  const { script } = compilePlanToScript(sampleInput());

  assert.ok(script.includes('await world.run("pnpm", ["--filter", "@zcode/projects-store", "lint"])'));
  assert.ok(script.includes('await world.run("pnpm", ["test"], { timeoutMs: 60000 })'));
  assert.ok(
    script.includes('recordValidation("pnpm --filter @zcode/projects-store lint", exitCodeOf('),
    'the recorded command is the literal cmd plus argv',
  );
  assert.ok(
    script.includes('recordValidation("pnpm test", exitCodeOf('),
    'the second command is recorded with its argv',
  );
  assert.ok(script.includes('return settled.ok ? settled.result.exitCode : null;'));
  assert.ok(
    script.includes(
      'return { tasks: taskOutcomes, validations: validationOutcomes } satisfies MissionReport;',
    ),
    'the run returns the report',
  );
});

test('a plan without validation commands blocks instead of passing silently', () => {
  const input = sampleInput();
  const { script } = compilePlanToScript({ ...input, validationCommands: [] });
  assert.ok(script.includes('phase("test");'));
  assert.ok(script.includes('no validation commands discovered'));
  assert.ok(!script.includes('world.run('), 'no command is invented');
  assert.ok(script.includes('satisfies MissionReport;'), 'the report is still returned');
});

test('the script has no import or export and ends with the return', () => {
  const { script } = compilePlanToScript(sampleInput());
  assert.ok(!/^\s*import\b/m.test(script), 'no import statement');
  assert.ok(!/^\s*export\b/m.test(script), 'no export statement');
  assert.ok(!/(^|[^.\w])require\s*\(/.test(script), 'no require call');
  assert.ok(/^\s*return \{ tasks: taskOutcomes, validations: validationOutcomes \}/m.test(script));
  assert.ok(
    script.trimEnd().endsWith('satisfies MissionReport;'),
    'the last statement is the report return',
  );
});

test('brief escaping: backticks, ${, quotes and newlines survive as one literal', () => {
  const { script } = compilePlanToScript(sampleInput());
  const escapedInterpolation = '\\${';
  // Indentation-insensitive on purpose: the brief's text is what matters, not its column.
  assert.equal(
    findLines(script, 'Title: Add the cache module').length,
    1,
    'the hostile title is in the brief',
  );
  assert.deepEqual(
    findLines(
      script,
      'Title: Add the cache module; beware \\`backticks\\`, \\${interpolation} and "quotes"',
    ),
    findLines(script, 'Title: Add the cache module'),
    'the title escapes its backticks and ${',
  );
  assert.equal(
    findLines(script, 'Then a \\`code span\\` and \\${aTemplate} and "quotes".').length,
    1,
    'the description escapes its backticks and ${',
  );

  const lines = script.split('\n');
  const start = lines.findIndex((line) => line.includes('.ask<TaskOutcome>(String.raw`'));
  assert.ok(start >= 0, 'the ask argument is a String.raw template literal');
  const end = lines.findIndex((line, index) => index > start && line.trimEnd().endsWith('`),'));
  assert.ok(end > start, 'the template literal is closed');
  assert.ok(end - start > 30, 'the brief is one multi-line literal, not an escaped one-liner');

  // Inside the template literal nothing may be left unescaped: a raw backtick would end it and a
  // raw `${` would open an interpolation. The persona on line `start` is a plain string literal,
  // where both are legal, so the check starts after it — and the escaped forms are stripped first,
  // because `\`` and `\${` are exactly what a correct brief contains.
  const briefLines = lines
    .slice(start + 1, end)
    .map((line) => line.replaceAll('\\`', '').replaceAll(escapedInterpolation, ''));
  assert.deepEqual(
    briefLines.filter(
      (line) => line.includes('`') || line.includes(escapedInterpolation.replace('\\$', '$')),
    ),
    [],
    'no unescaped backtick or interpolation inside the brief',
  );
  assert.equal(
    briefLines.filter((line) => line.includes('## Result contract')).length,
    1,
    'the whole brief is inside the single literal',
  );
  for (const heading of [
    '## Mission objective',
    '## This task',
    '## Repository instructions',
    '## Working rules',
    '## Validation commands for this task',
    '## Result contract',
  ]) {
    assert.ok(script.includes(heading), 'the brief has ' + heading);
  }
  assert.ok(script.includes('src/cache.ts'), 'file hints are normalised to forward slashes');
});

test('the emitted literal for a hostile description parses as TypeScript', async () => {
  const typescript = await importOrUndefined<typeof import('typescript')>('typescript');
  if (typescript === undefined) {
    // No compiler on hand: assert the escape at the text level instead of skipping silently.
    const { script } = compilePlanToScript(sampleInput());
    assert.ok(script.includes('\\`backticks\\`'), 'backticks are escaped');
    assert.ok(script.includes('\\${interpolation}'), '${ is escaped');
    return;
  }
  const { script } = compilePlanToScript(sampleInput());
  const wrapped = 'async function __workflowScript__() {\n' + script + '\n}\nexport {};\n';
  const transpiled = typescript.transpileModule(wrapped, {
    fileName: 'workflow-script.ts',
    reportDiagnostics: true,
    compilerOptions: { target: typescript.ScriptTarget.ES2022 },
  });
  const parseErrors = (transpiled.diagnostics ?? []).map(
    (diagnostic) =>
      diagnostic.code + ': ' + typescript.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  );
  assert.deepEqual(parseErrors, [], 'the generated script has no syntax errors');
});

test('the emitted script compiles through the engine pipeline (dependent + independent tasks)', () => {
  for (const input of [sampleInput(), fanOutInput()]) {
    const { script } = compilePlanToScript(input);
    try {
      const compiled = compileMissionScript(script);
      assert.ok(compiled.lowered.length > 0, 'the script lowers to executable code');
      assert.ok(compiled.askSpecs.size > 0, 'every ask site has a spec');
    } catch (error) {
      if (error instanceof ScriptCompileError) {
        assert.deepEqual(
          error.diagnostics.map((diagnostic) => JSON.stringify(diagnostic)),
          [],
          'the engine rejected the generated script',
        );
      }
      throw error;
    }
  }
});

test('the run command set is exactly the literals the generator emitted', () => {
  const { script } = compilePlanToScript(sampleInput());
  assert.deepEqual(compileMissionScript(script).commands, ['pnpm']);
  assert.equal(
    compilePlanToScript({ ...sampleInput(), validationCommands: [] }).script.includes('world.run('),
    false,
    'a plan with no commands declares none',
  );
});

test('the generated script typechecks against the dynamic-workflow facade when available', async () => {
  interface WorkflowCompiler {
    compileWorkflowScript(text: string): {
      ok: boolean;
      diagnostics: { line: number; column: number; message: string }[];
    };
  }
  const facade = await importOrUndefined<WorkflowCompiler>('@zcode/dynamic-workflow');
  if (facade === undefined) {
    // The compiler package is not installed in this checkout yet; the engine-pipeline test above
    // still compiles the emitted script for real.
    return;
  }
  for (const input of [sampleInput(), fanOutInput()]) {
    const { script } = compilePlanToScript(input);
    const result = facade.compileWorkflowScript(script);
    assert.deepEqual(
      result.diagnostics.map(
        (diagnostic) => diagnostic.line + ':' + diagnostic.column + ' ' + diagnostic.message,
      ),
      [],
    );
    assert.equal(result.ok, true);
  }
});

/** `await import(specifier)`, resolving to undefined when the module is not installed. */
async function importOrUndefined<T>(specifier: string): Promise<T | undefined> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return undefined;
  }
}
