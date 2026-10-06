import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { MissionConfig } from '../src/runner-config.js';
import {
  DEFAULT_INSTRUCTION_MAX_BYTES,
  RunnerConfigError,
  createRunnerConfig,
  discoverValidationCommands,
  readRepositoryInstructions,
} from '../src/runner-config.js';

/** Real scratch directory under the OS temp dir, removed when the test settles. */
async function scratch(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mission-runner-config-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Write a file inside a scratch repository, creating parent directories as needed. */
async function writeRepoFile(root: string, relativePath: string, content = ''): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// createRunnerConfig
// ---------------------------------------------------------------------------------------------

test('createRunnerConfig returns the spec defaults', () => {
  assert.deepEqual(createRunnerConfig(), {
    maxWorkers: 3,
    maxTaskAttempts: 2,
    maxReviewRounds: 2,
    plannerModel: undefined,
    workerModel: undefined,
    reviewerModel: undefined,
    tokenBudgetPerMission: undefined,
    worktreeRoot: undefined,
    validationCommands: [],
    autoResume: false,
  });
});

test('createRunnerConfig applies every accepted override', () => {
  const worktreeRoot = join(tmpdir(), 'missions', 'mission-1', 'worktrees');
  const config = createRunnerConfig({
    maxWorkers: 5,
    maxTaskAttempts: 4,
    maxReviewRounds: 1,
    plannerModel: 'planner-model',
    workerModel: 'worker-model',
    reviewerModel: 'reviewer-model',
    tokenBudgetPerMission: 250_000,
    worktreeRoot,
    validationCommands: ['pnpm run lint', 'make check'],
    autoResume: true,
  });
  assert.deepEqual(config, {
    maxWorkers: 5,
    maxTaskAttempts: 4,
    maxReviewRounds: 1,
    plannerModel: 'planner-model',
    workerModel: 'worker-model',
    reviewerModel: 'reviewer-model',
    tokenBudgetPerMission: 250_000,
    worktreeRoot,
    validationCommands: ['pnpm run lint', 'make check'],
    autoResume: true,
  });
});

test('createRunnerConfig returns a fresh object on every call', () => {
  const first = createRunnerConfig();
  first.validationCommands.push('pnpm test');
  first.maxWorkers = 99;
  const second = createRunnerConfig();
  assert.deepEqual(second.validationCommands, []);
  assert.equal(second.maxWorkers, 3);
});

test('createRunnerConfig accepts zero attempts and zero review rounds', () => {
  const config = createRunnerConfig({ maxTaskAttempts: 0, maxReviewRounds: 0 });
  assert.equal(config.maxTaskAttempts, 0);
  assert.equal(config.maxReviewRounds, 0);
});

test('createRunnerConfig keeps model ids opaque instead of normalising them', () => {
  assert.equal(createRunnerConfig({ plannerModel: ' vendor/model-1 ' }).plannerModel, ' vendor/model-1 ');
});

const rejectedOverrides: readonly (readonly [string, Partial<MissionConfig>])[] = [
  ['a zero worker count', { maxWorkers: 0 }],
  ['a negative worker count', { maxWorkers: -2 }],
  ['a fractional worker count', { maxWorkers: 1.5 }],
  ['a NaN worker count', { maxWorkers: Number.NaN }],
  ['an infinite worker count', { maxWorkers: Number.POSITIVE_INFINITY }],
  ['a non-numeric worker count', { maxWorkers: '3' as unknown as number }],
  ['an explicitly unset maxWorkers', { maxWorkers: undefined }],
  ['a negative attempt count', { maxTaskAttempts: -1 }],
  ['an explicitly unset attempt count', { maxTaskAttempts: undefined }],
  ['a negative review round count', { maxReviewRounds: -1 }],
  ['a fractional review round count', { maxReviewRounds: 1.5 }],
  ['an explicitly unset autoResume', { autoResume: undefined }],
  ['a non-boolean autoResume', { autoResume: 'yes' as unknown as boolean }],
  ['an explicitly unset validationCommands', { validationCommands: undefined }],
  ['a non-array validationCommands', { validationCommands: 'pnpm test' as unknown as string[] }],
  ['a blank validation command', { validationCommands: ['   '] }],
  ['a non-string validation command', { validationCommands: [7 as unknown as string] }],
  ['a validation command that needs a shell', { validationCommands: ['pnpm lint && pnpm test'] }],
  ['a validation command with a pipe', { validationCommands: ['pnpm test | tee log'] }],
  ['a validation command with a redirection', { validationCommands: ['pnpm test > out.txt'] }],
  ['a validation command with parameter expansion', { validationCommands: ['node $HOME/run.mjs'] }],
  ['a validation command with an unterminated quote', { validationCommands: ['node "scripts/x.mjs'] }],
  ['an empty planner model id', { plannerModel: '' }],
  ['a whitespace-only worker model id', { workerModel: '   ' }],
  ['a non-string reviewer model id', { reviewerModel: 7 as unknown as string }],
  ['a zero token budget', { tokenBudgetPerMission: 0 }],
  ['a negative token budget', { tokenBudgetPerMission: -1 }],
  ['a fractional token budget', { tokenBudgetPerMission: 10.5 }],
  ['an empty worktree root', { worktreeRoot: '' }],
  ['a relative worktree root', { worktreeRoot: 'worktrees' }],
  ['an unknown key', { maxWorker: 2 } as unknown as Partial<MissionConfig>],
];

for (const [label, overrides] of rejectedOverrides) {
  test(`createRunnerConfig rejects ${label}`, () => {
    assert.throws(() => createRunnerConfig(overrides), RunnerConfigError);
  });
}

test('createRunnerConfig rejects a non-object overrides argument', () => {
  assert.throws(() => createRunnerConfig(null as unknown as Partial<MissionConfig>), RunnerConfigError);
  assert.throws(() => createRunnerConfig([] as unknown as Partial<MissionConfig>), RunnerConfigError);
});

// ---------------------------------------------------------------------------------------------
// discoverValidationCommands — step 1: explicit overrides
// ---------------------------------------------------------------------------------------------

test('discovery prefers overrides over package scripts, Makefile and CI', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  await writeRepoFile(root, 'pnpm-lock.yaml', '');
  await writeRepoFile(root, 'Makefile', 'check:\n\tnode --test\n');
  await writeRepoFile(root, '.github/workflows/ci.yml', 'jobs:\n  b:\n    steps:\n      - run: npm test\n');

  const commands = await discoverValidationCommands({
    repositoryPath: root,
    overrides: ['pnpm run lint -- --fix'],
  });
  assert.deepEqual(commands, [
    { command: 'pnpm', args: ['run', 'lint', '--', '--fix'], source: 'override', required: true },
  ]);
});

test('discovery keeps quoted override text as a single argv entry', async (t) => {
  const root = await scratch(t);
  const commands = await discoverValidationCommands({
    repositoryPath: root,
    overrides: ['node --test "tests/a b.test.ts"', "pytest -k 'not slow'"],
  });
  assert.deepEqual(commands, [
    { command: 'node', args: ['--test', 'tests/a b.test.ts'], source: 'override', required: true },
    { command: 'pytest', args: ['-k', 'not slow'], source: 'override', required: true },
  ]);
});

test('discovery preserves the configured override order', async (t) => {
  const root = await scratch(t);
  const commands = await discoverValidationCommands({
    repositoryPath: root,
    overrides: ['pnpm run test', 'make check'],
  });
  assert.deepEqual(
    commands.map((entry) => `${entry.command} ${entry.args.join(' ')}`),
    ['pnpm run test', 'make check'],
  );
});

test('discovery treats an empty override list as "discover"', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root, overrides: [] }), [
    { command: 'npm', args: ['run', 'test'], source: 'package-script', required: true },
  ]);
});

test('discovery rejects an override that needs a shell', async (t) => {
  const root = await scratch(t);
  await assert.rejects(
    discoverValidationCommands({ repositoryPath: root, overrides: ['pnpm lint | tee log'] }),
    RunnerConfigError,
  );
  await assert.rejects(
    discoverValidationCommands({ repositoryPath: root, overrides: ['   '] }),
    RunnerConfigError,
  );
});

// ---------------------------------------------------------------------------------------------
// discoverValidationCommands — step 2: package.json scripts and the lockfile
// ---------------------------------------------------------------------------------------------

const lockfileManagers: readonly (readonly [string, string])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

for (const [lockfile, manager] of lockfileManagers) {
  test(`discovery runs package scripts with ${manager} when ${lockfile} is present`, async (t) => {
    const root = await scratch(t);
    await writeRepoFile(root, lockfile, '');
    await writeRepoFile(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), [
      { command: manager, args: ['run', 'test'], source: 'package-script', required: true },
    ]);
  });
}

test('discovery defaults to npm when no lockfile exists', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'package.json', JSON.stringify({ scripts: { lint: 'oxlint' } }));
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), [
    { command: 'npm', args: ['run', 'lint'], source: 'package-script', required: true },
  ]);
});

test('discovery prefers the first lockfile in spec order when several exist', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'package-lock.json', '');
  await writeRepoFile(root, 'yarn.lock', '');
  await writeRepoFile(root, 'pnpm-lock.yaml', '');
  await writeRepoFile(root, 'package.json', JSON.stringify({ scripts: { build: 'tsc -b' } }));
  const [command] = await discoverValidationCommands({ repositoryPath: root });
  assert.equal(command?.command, 'pnpm');
});

test('discovery honours an explicit package manager over the lockfile', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'yarn.lock', '');
  await writeRepoFile(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  const [command] = await discoverValidationCommands({ repositoryPath: root, packageManager: 'pnpm' });
  assert.equal(command?.command, 'pnpm');
});

test('discovery accepts the manifest packageManager form', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  const [command] = await discoverValidationCommands({ repositoryPath: root, packageManager: 'pnpm@10.33.2' });
  assert.equal(command?.command, 'pnpm');
});

test('discovery rejects an unsupported package manager', async (t) => {
  const root = await scratch(t);
  await assert.rejects(
    discoverValidationCommands({ repositoryPath: root, packageManager: 'cargo' }),
    RunnerConfigError,
  );
});

test('discovery returns only existing priority scripts, in priority order', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(
    root,
    'package.json',
    JSON.stringify({
      scripts: {
        start: 'node .',
        build: 'tsc -b',
        test: 'node --test',
        deploy: 'echo no',
        lint: 'oxlint',
        typecheck: 'tsc --noEmit',
      },
    }),
  );
  const commands = await discoverValidationCommands({ repositoryPath: root });
  assert.deepEqual(
    commands.map((entry) => entry.args[1]),
    ['typecheck', 'lint', 'test', 'build'],
  );
  assert.ok(commands.every((entry) => entry.source === 'package-script' && entry.required === true));
});

test('discovery skips priority scripts with an empty body', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'package.json', JSON.stringify({ scripts: { test: '', lint: '   ' } }));
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), []);
});

test('discovery ignores a malformed package.json and falls through to the Makefile', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'package.json', '{ not json');
  await writeRepoFile(root, 'Makefile', 'test:\n\tnode --test\n');
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), [
    { command: 'make', args: ['test'], source: 'makefile', required: true },
  ]);
});

// ---------------------------------------------------------------------------------------------
// discoverValidationCommands — step 3: Makefile
// ---------------------------------------------------------------------------------------------

test('discovery falls back to a Makefile target when no package script matches', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'package.json', JSON.stringify({ scripts: { start: 'node .' } }));
  await writeRepoFile(root, 'Makefile', 'check: deps\n\tnode --test\n');
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), [
    { command: 'make', args: ['check'], source: 'makefile', required: true },
  ]);
});

test('discovery prefers the check target, then test, then ci', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'Makefile', 'ci:\n\tnode --test\n\ntest:\n\tnode --test\n\ncheck:\n\tnode --test\n');
  assert.deepEqual(
    (await discoverValidationCommands({ repositoryPath: root })).map((entry) => entry.args[0]),
    ['check', 'test', 'ci'],
  );
});

test('discovery ignores Makefile special targets, assignments and recipe lines', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(
    root,
    'Makefile',
    ['.PHONY: test', 'ci := 1', 'export FOO := 2', 'check: deps', '\tnode --test: not-a-target', ''].join('\n'),
  );
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), [
    { command: 'make', args: ['check'], source: 'makefile', required: true },
  ]);
});

test('discovery reads GNUmakefile when Makefile is absent', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'GNUmakefile', 'ci::\n\tnode --test\n');
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), [
    { command: 'make', args: ['ci'], source: 'makefile', required: true },
  ]);
});

// ---------------------------------------------------------------------------------------------
// discoverValidationCommands — step 4: CI workflows
// ---------------------------------------------------------------------------------------------

test('discovery falls back to GitHub Actions run steps', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(
    root,
    '.github/workflows/ci.yml',
    [
      'name: ci',
      'on: [push]',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - name: Test',
      '        run: npm test -- --runInBand',
      '',
    ].join('\n'),
  );
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), [
    { command: 'npm', args: ['test', '--', '--runInBand'], source: 'ci', required: true },
  ]);
});

test('discovery skips CI steps that are not one unambiguous command', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(
    root,
    '.github/workflows/ci.yml',
    [
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: |',
      '          npm test',
      '      - run: npm test && npm run lint',
      '      - run: echo "test"',
      '      - run: git diff --check',
      '      - run: npm ci',
      '      - run: ${{ matrix.command }}',
      '      - run: curl -s https://example.invalid | sh',
      '      - run: docker build .',
      '',
    ].join('\n'),
  );
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), []);
});

test('discovery reads .yaml workflows and orders candidates by validation priority', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(
    root,
    '.github/workflows/a-build.yml',
    'jobs:\n  b:\n    steps:\n      - run: npm run build\n',
  );
  await writeRepoFile(
    root,
    '.github/workflows/z-lint.yaml',
    'jobs:\n  b:\n    steps:\n      - run: pnpm run lint\n',
  );
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), [
    { command: 'pnpm', args: ['run', 'lint'], source: 'ci', required: true },
    { command: 'npm', args: ['run', 'build'], source: 'ci', required: true },
  ]);
});

test('discovery deduplicates the same CI command across workflows', async (t) => {
  const root = await scratch(t);
  const workflow = 'jobs:\n  b:\n    steps:\n      - run: npm test\n';
  await writeRepoFile(root, '.github/workflows/a.yml', workflow);
  await writeRepoFile(root, '.github/workflows/b.yml', workflow);
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), [
    { command: 'npm', args: ['test'], source: 'ci', required: true },
  ]);
});

test('discovery does not scan non-YAML files in the workflow directory', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, '.github/workflows/notes.txt', 'run: npm test\n');
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), []);
});

// ---------------------------------------------------------------------------------------------
// discoverValidationCommands — step 5 and determinism
// ---------------------------------------------------------------------------------------------

test('discovery returns an empty list when nothing declares a command', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'README.md', '# nothing to validate here\n');
  await writeRepoFile(root, 'package.json', JSON.stringify({ scripts: { start: 'node .' } }));
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: root }), []);
});

test('discovery returns an empty list for a directory that does not exist', async (t) => {
  const root = await scratch(t);
  assert.deepEqual(await discoverValidationCommands({ repositoryPath: join(root, 'missing') }), []);
});

test('discovery is deterministic across repeated runs', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(
    root,
    'package.json',
    JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit', build: 'tsc -b' } }),
  );
  await writeRepoFile(root, 'pnpm-lock.yaml', '');
  const first = await discoverValidationCommands({ repositoryPath: root });
  const second = await discoverValidationCommands({ repositoryPath: root });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((entry) => entry.args[1]),
    ['typecheck', 'test', 'build'],
  );
});

test('discovery rejects a relative repository path', async () => {
  await assert.rejects(discoverValidationCommands({ repositoryPath: 'relative/repo' }), RunnerConfigError);
  await assert.rejects(discoverValidationCommands({ repositoryPath: '' }), RunnerConfigError);
});

// ---------------------------------------------------------------------------------------------
// readRepositoryInstructions
// ---------------------------------------------------------------------------------------------

test('readRepositoryInstructions follows the preference order', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'README.md', 'readme\n');
  await writeRepoFile(root, 'CONTRIBUTING', 'contributing without extension\n');
  await writeRepoFile(root, 'CONTRIBUTING.md', 'contributing\n');
  await writeRepoFile(root, 'AGENTS.md', 'agents\n');

  const files = await readRepositoryInstructions({ repositoryPath: root });
  assert.deepEqual(
    files.map((file) => file.path),
    ['AGENTS.md', 'CONTRIBUTING.md', 'CONTRIBUTING', 'README.md'],
  );
  assert.equal(files[0]?.text, 'agents\n');
  assert.equal(files[3]?.text, 'readme\n');
});

test('readRepositoryInstructions returns only the files that exist', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'README.md', 'readme\n');
  assert.deepEqual(await readRepositoryInstructions({ repositoryPath: root }), [
    { path: 'README.md', text: 'readme\n' },
  ]);
});

test('readRepositoryInstructions returns an empty list when no instruction file exists', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'src/index.ts', 'export {};\n');
  assert.deepEqual(await readRepositoryInstructions({ repositoryPath: root }), []);
});

test('readRepositoryInstructions returns an empty list for a missing directory', async (t) => {
  const root = await scratch(t);
  assert.deepEqual(await readRepositoryInstructions({ repositoryPath: join(root, 'missing') }), []);
});

test('readRepositoryInstructions never reads dotfiles', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, '.env', 'SECRET=1\n');
  assert.deepEqual(await readRepositoryInstructions({ repositoryPath: root }), []);
});

test('readRepositoryInstructions truncates to maxBytes and records the truncation', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'AGENTS.md', 'x'.repeat(200));
  const [file] = await readRepositoryInstructions({ repositoryPath: root, maxBytes: 50 });
  assert.equal(file?.text.startsWith('x'.repeat(50)), true);
  assert.match(file?.text ?? '', /\[truncated: showing the first 50 of 200 bytes\]/);
});

test('readRepositoryInstructions leaves a file of exactly maxBytes untouched', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'AGENTS.md', 'x'.repeat(50));
  const [file] = await readRepositoryInstructions({ repositoryPath: root, maxBytes: 50 });
  assert.equal(file?.text, 'x'.repeat(50));
});

test('readRepositoryInstructions never splits a multi-byte character', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'AGENTS.md', 'é'.repeat(10));
  const [file] = await readRepositoryInstructions({ repositoryPath: root, maxBytes: 5 });
  assert.equal(file?.text.startsWith('éé'), true);
  assert.equal((file?.text ?? '').includes('\uFFFD'), false);
  assert.match(file?.text ?? '', /showing the first 4 of 20 bytes/);
});

test('readRepositoryInstructions caps at the default byte budget', async (t) => {
  const root = await scratch(t);
  const size = DEFAULT_INSTRUCTION_MAX_BYTES + 100;
  await writeRepoFile(root, 'AGENTS.md', 'a'.repeat(size));
  const [file] = await readRepositoryInstructions({ repositoryPath: root });
  assert.match(file?.text ?? '', new RegExp(`showing the first ${DEFAULT_INSTRUCTION_MAX_BYTES} of ${size} bytes`));
});

test('readRepositoryInstructions skips a symlink that leaves the repository', async (t) => {
  const outside = await scratch(t);
  const root = await scratch(t);
  await writeRepoFile(outside, 'secret.md', 'outside content\n');
  try {
    await symlink(join(outside, 'secret.md'), join(root, 'AGENTS.md'), 'file');
  } catch {
    t.skip('symlinks are unavailable on this platform');
    return;
  }
  assert.deepEqual(await readRepositoryInstructions({ repositoryPath: root }), []);
});

test('readRepositoryInstructions follows a symlink that stays inside the repository', async (t) => {
  const root = await scratch(t);
  await writeRepoFile(root, 'docs/agents.md', 'inside content\n');
  try {
    await symlink(join(root, 'docs', 'agents.md'), join(root, 'AGENTS.md'), 'file');
  } catch {
    t.skip('symlinks are unavailable on this platform');
    return;
  }
  assert.deepEqual(await readRepositoryInstructions({ repositoryPath: root }), [
    { path: 'AGENTS.md', text: 'inside content\n' },
  ]);
});

test('readRepositoryInstructions skips a directory named like an instruction file', async (t) => {
  const root = await scratch(t);
  await mkdir(join(root, 'CONTRIBUTING'), { recursive: true });
  await writeRepoFile(root, 'README.md', 'readme\n');
  assert.deepEqual(
    (await readRepositoryInstructions({ repositoryPath: root })).map((file) => file.path),
    ['README.md'],
  );
});

test('readRepositoryInstructions rejects a non-positive maxBytes or relative path', async (t) => {
  const root = await scratch(t);
  await assert.rejects(readRepositoryInstructions({ repositoryPath: root, maxBytes: 0 }), RunnerConfigError);
  await assert.rejects(readRepositoryInstructions({ repositoryPath: root, maxBytes: -1 }), RunnerConfigError);
  await assert.rejects(readRepositoryInstructions({ repositoryPath: './repo' }), RunnerConfigError);
});
