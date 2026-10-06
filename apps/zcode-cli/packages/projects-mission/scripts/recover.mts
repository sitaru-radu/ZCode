/**
 * Restart recovery check (criterion 16).
 *
 * Opens an existing mission data directory in a fresh process, prints what survived, and reconciles
 * every non-terminal mission against the executor. A mission whose executor sessions are gone is
 * reported as `interrupted` and stays blocked — it is never silently completed.
 *
 * Usage:
 *   node --import tsx scripts/recover.mts --data /path/to/data [--worktrees /path/to/worktrees]
 */
import { join } from 'node:path';

import { createDshExecutor } from '@zcode/dsh-executor';
import { ProjectsStore } from '@zcode/projects-store';

import { reconcileMissions } from '../src/index.js';

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

const argv = process.argv.slice(2);
const dataDir = flag(argv, 'data');
if (dataDir === undefined) throw new Error('usage: recover.mts --data <dir> [--worktrees <dir>]');
const worktreeRoot = flag(argv, 'worktrees') ?? join(dataDir, 'worktrees');

const store = new ProjectsStore({ file: join(dataDir, 'projects.db') });
const apiKey = process.env['DEEPSEEK_API_KEY'];
const adapter = createDshExecutor({
  profile: 'acp',
  ...(apiKey === undefined || apiKey === '' ? {} : { env: { DEEPSEEK_API_KEY: apiKey } }),
});

try {
  const before = store
    .listProjects()
    .flatMap((project) => store.listMissionsByProject(project.id))
    .map((mission) => ({ id: mission.id, status: mission.status, summary: mission.summary ?? null }));

  const reports = await reconcileMissions({
    store,
    adapter,
    now: () => Date.now(),
    worktreeRoot,
    logger: (message) => process.stderr.write(`[recover] ${message}\n`),
  });

  const after = before.map((entry) => {
    const mission = store.getMission(entry.id);
    return { id: entry.id, statusBefore: entry.status, statusAfter: mission?.status ?? 'missing', summary: mission?.summary ?? null };
  });

  process.stdout.write(`${JSON.stringify({ timeTravel: { before, after }, reconciliation: reports }, null, 2)}\n`);
} finally {
  await adapter.dispose().catch(() => undefined);
  store.close();
}
