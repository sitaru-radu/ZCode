/**
 * Invocation-core tests: pinned arguments, pinned environment, exit-code capture, typed errors and
 * the timeout kill. These are the properties every other function in the package relies on.
 */

import assert from 'node:assert/strict';
import { chmod, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  buildGitArgv,
  buildGitEnv,
  git,
  gitOrThrow,
  isGitError,
} from '../src/index.js';
import { createScratchRepo, type ScratchRepo } from './helpers/scratch.js';

let scratch: ScratchRepo;

before(async () => {
  scratch = await createScratchRepo();
});

after(async () => {
  await scratch.cleanup();
});

const isPosix = process.platform !== 'win32';

test('buildGitArgv pins config, uses -C and never --git-dir', () => {
  const argv = buildGitArgv(['status', '--porcelain'], '/tmp/zcode-target');
  assert.deepEqual(argv, [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.pager=cat',
    '-C',
    '/tmp/zcode-target',
    'status',
    '--porcelain',
  ]);
  assert.equal(argv.includes('--git-dir'), false);
  assert.equal(argv.includes('--work-tree'), false);
});

test('buildGitEnv pins the mandated environment and scrubs GIT_DIR', () => {
  const env = buildGitEnv();
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.LC_ALL, 'C');
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_WORK_TREE, undefined);
  assert.equal(buildGitEnv({ LC_ALL: 'en_US.UTF-8' }).LC_ALL, 'en_US.UTF-8');
});

test('git captures stdout and stderr separately and does not throw on exit 1', async () => {
  const result = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: scratch.repo });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.timedOut, false);
  assert.ok(result.argv.includes('-C'));
});

test('a successful worktree add writes progress to stderr (stderr is not failure, G14)', async () => {
  const target = scratch.worktreePath('runner-progress');
  const loud = await git(['worktree', 'add', '-b', 'zcode/runner-progress', target, scratch.base], {
    cwd: scratch.repo,
  });
  assert.equal(loud.exitCode, 0);
  assert.match(loud.stderr, /Preparing worktree \(new branch 'zcode\/runner-progress'\)/);
  assert.match(loud.stdout, /HEAD is now at/);

  const quiet = await git(
    ['worktree', 'add', '-q', '-b', 'zcode/runner-quiet', scratch.worktreePath('runner-quiet'), scratch.base],
    { cwd: scratch.repo },
  );
  assert.equal(quiet.exitCode, 0);
  assert.equal(quiet.stdout, '');
  assert.equal(quiet.stderr, '');
});

test('repository hooks are disabled by the pinned core.hooksPath', async () => {
  const hook = path.join(scratch.repo, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\necho "hook must not run" >&2\nexit 1\n', 'utf8');
  await chmod(hook, 0o755);
  try {
    const committed = await gitOrThrow(['commit', '-q', '--allow-empty', '-m', 'no hooks'], {
      cwd: scratch.repo,
    });
    assert.equal(committed.exitCode, 0);
  } finally {
    await writeFile(hook, '#!/bin/sh\nexit 0\n', 'utf8');
  }
});

test('gitOrThrow throws a GitError carrying exitCode, stdout and stderr', async () => {
  let captured: unknown;
  await assert.rejects(
    // Without `-q`, `--verify` on a missing ref is a hard 128 rather than the normal 1.
    () => gitOrThrow(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: scratch.repo }),
    (thrown: unknown) => {
      captured = thrown;
      return true;
    },
  );
  assert.ok(isGitError(captured), 'expected a GitError');
  assert.equal(captured.exitCode, 128);
  assert.match(captured.stderr, /Needed a single revision/);
  assert.equal(captured.cwd, scratch.repo);
  assert.ok(captured.args.includes('-C'));
  assert.ok(captured.message.includes('exit'));
});

test('a missing -C directory is git exit 128, classified no-such-directory', async () => {
  const missing = path.join(scratch.root, 'not-created');
  const result = await git(['status', '--porcelain'], { cwd: missing });
  assert.equal(result.exitCode, 128);
  assert.match(result.stderr, /cannot change to '.*not-created': No such file or directory/);

  await assert.rejects(
    () => gitOrThrow(['status', '--porcelain'], { cwd: missing }),
    (thrown: unknown) => {
      assert.ok(isGitError(thrown));
      assert.equal(thrown.exitCode, 128);
      assert.equal(thrown.kind, 'no-such-directory');
      return true;
    },
  );
});

test('a -C path that is a file is exit 128, classified not-a-directory', async () => {
  const result = await git(['rev-parse', 'HEAD'], { cwd: path.join(scratch.repo, 'a.txt') });
  assert.equal(result.exitCode, 128);
  assert.match(result.stderr, /Not a directory/);
});

test('GIT_DIR in the host environment cannot redirect git (G3)', async () => {
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(scratch.root, 'bogus-git-dir');
  try {
    const status = await gitOrThrow(['status', '--porcelain'], { cwd: scratch.repo });
    assert.equal(status.stdout, '');
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

test('the child environment reaches git exactly as pinned', { skip: !isPosix }, async () => {
  const result = await git(
    [
      '-c',
      'alias.zcodeenv=!printf "%s|%s|%s|%s" "$GIT_TERMINAL_PROMPT" "$GIT_CONFIG_NOSYSTEM" "$LC_ALL" "$GIT_DIR"',
      'zcodeenv',
    ],
    { cwd: scratch.repo },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '0|1|C|');
});

test('a hung git is killed with its whole process group', { skip: !isPosix }, async () => {
  const startedAt = Date.now();
  const result = await git(['-c', 'alias.zcodehang=!sleep 30', 'zcodehang'], {
    cwd: scratch.repo,
    timeoutMs: 700,
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(elapsed < 8000, `the kill must not wait for the grandchild (took ${elapsed}ms)`);

  await assert.rejects(
    () => gitOrThrow(['-c', 'alias.zcodehang=!sleep 30', 'zcodehang'], { cwd: scratch.repo, timeoutMs: 300 }),
    (thrown: unknown) => {
      assert.ok(isGitError(thrown));
      assert.equal(thrown.kind, 'timeout');
      assert.equal(thrown.exitCode, null);
      return true;
    },
  );
});

test('an AbortSignal kills a running git', { skip: !isPosix }, async () => {
  const controller = new AbortController();
  const pending = git(['-c', 'alias.zcodeabort=!sleep 30', 'zcodeabort'], {
    cwd: scratch.repo,
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 200);
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, null);
});

test('scratch worktree root survived the runner tests', async () => {
  const stats = await stat(scratch.worktreeRoot);
  assert.equal(stats.isDirectory(), true);
});
