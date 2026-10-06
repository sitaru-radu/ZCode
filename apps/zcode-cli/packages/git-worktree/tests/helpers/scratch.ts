/**
 * Scratch-repository helper for the real-git integration tests.
 *
 * Every test file gets its own repository under `mkdtemp(path.join(os.tmpdir(), 'zcode-wt-'))` and a
 * worktree root OUTSIDE that repository, mirroring the production layout. Nothing here touches
 * `~/repos`: the only paths used are the temp root and git's own output.
 */

import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { addWorktree as addWorktreeApi, git, gitOrThrow, type GitResult } from '../../src/index.js';

export interface RunOptions {
  readonly cwd?: string;
  readonly acceptCodes?: readonly number[];
  readonly timeoutMs?: number;
}

export interface AddWorktreeOptions {
  readonly baseRef?: string;
  readonly branch?: string;
  readonly detach?: boolean;
  readonly quiet?: boolean;
}

export interface ScratchRepo {
  /** Temp root; removed by {@link ScratchRepo.cleanup}. */
  readonly root: string;
  /** Main repository (main worktree, branch `main`). */
  readonly repo: string;
  /** Worktree root, deliberately outside {@link ScratchRepo.repo}. */
  readonly worktreeRoot: string;
  /** HEAD of the repository after the two seed commits. */
  readonly base: string;
  inRepo(...segments: string[]): string;
  worktreePath(name: string): string;
  run(args: readonly string[], options?: RunOptions): Promise<GitResult>;
  ok(args: readonly string[], cwd?: string): Promise<GitResult>;
  write(relativePath: string, content: string, cwd?: string): Promise<void>;
  read(relativePath: string, cwd?: string): Promise<string>;
  readBytes(relativePath: string, cwd?: string): Promise<Buffer>;
  commitAll(message: string, cwd?: string): Promise<string>;
  revParse(ref: string, cwd?: string): Promise<string>;
  addWorktree(name: string, options?: AddWorktreeOptions): Promise<string>;
  tree(cwd?: string): Promise<string[]>;
  cleanup(): Promise<void>;
}

/** Relative listing of a directory, `.git` excluded: the "source repo is untouched" evidence. */
async function listTree(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const listed: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) listed.push(`${relative}/`, ...(await listTree(root, relative)));
    else listed.push(relative);
  }
  return listed.sort();
}

export async function createScratchRepo(): Promise<ScratchRepo> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'zcode-wt-')));
  const repo = path.join(root, 'repo');
  const worktreeRoot = path.join(root, 'worktrees');
  await mkdir(repo, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });

  const run = (args: readonly string[], options: RunOptions = {}): Promise<GitResult> =>
    git(args, { cwd: options.cwd ?? repo, acceptCodes: options.acceptCodes, timeoutMs: options.timeoutMs });
  const ok = (args: readonly string[], cwd?: string): Promise<GitResult> => gitOrThrow(args, { cwd: cwd ?? repo });

  await ok(['init', '-q', '-b', 'main']);
  // Identity is local to the scratch repo: GIT_CONFIG_NOSYSTEM=1 and no global config is assumed.
  await ok(['config', 'user.email', 'zcode@example.invalid']);
  await ok(['config', 'user.name', 'ZCode Test']);
  await ok(['config', 'commit.gpgsign', 'false']);

  const write = async (relativePath: string, content: string, cwd = repo): Promise<void> => {
    const target = path.join(cwd, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  };
  const read = (relativePath: string, cwd = repo): Promise<string> =>
    readFile(path.join(cwd, relativePath), 'utf8');
  const readBytes = (relativePath: string, cwd = repo): Promise<Buffer> =>
    readFile(path.join(cwd, relativePath));

  const commitAll = async (message: string, cwd = repo): Promise<string> => {
    await ok(['add', '-A'], cwd);
    await ok(['commit', '-q', '--no-gpg-sign', '-m', message], cwd);
    const head = await ok(['rev-parse', 'HEAD'], cwd);
    return head.stdout.trim();
  };
  const revParse = async (ref: string, cwd = repo): Promise<string> =>
    (await ok(['rev-parse', ref], cwd)).stdout.trim();

  await write('a.txt', 'a1\n');
  await write('b.txt', 'b1\n');
  await write('src/one.txt', 'one\n');
  await commitAll('c1: seed');
  await write('a.txt', 'a2\n');
  await commitAll('c2: seed again');
  const base = await revParse('HEAD');

  const worktreePath = (name: string): string => path.join(worktreeRoot, name);

  return {
    root,
    repo,
    worktreeRoot,
    base,
    inRepo: (...segments) => path.join(repo, ...segments),
    worktreePath,
    run,
    ok,
    write,
    read,
    readBytes,
    commitAll,
    revParse,
    addWorktree: async (name, options = {}) => {
      const target = worktreePath(name);
      await addWorktreeApi(repo, {
        path: target,
        ...(options.detach === true ? { detach: true } : { branch: options.branch ?? `zcode/${name}` }),
        baseRef: options.baseRef ?? base,
        quiet: options.quiet ?? true,
      });
      return target;
    },
    tree: (cwd = repo) => listTree(cwd),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
