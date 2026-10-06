/**
 * End-to-end mission demo (M1, headless).
 *
 * Creates a project on a repository, states a mission objective, and drives it to settlement:
 * plan → worktree workers on DeepSeek Harness → per-task commit and integration → independent
 * review → repository-defined validation → completion gate → final result.
 *
 * Usage:
 *   node --import tsx scripts/demo.mts --repo /path/to/repo --data /path/to/data \
 *     --objective "Add a /health endpoint returning {\"status\":\"ok\"} plus tests" [--workers 3] [--model deepseek-v4-flash]
 *
 * The repository is never written to: worktrees live under `<data>/worktrees`, and the mission's
 * mission branch is the only thing that advances.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createDshExecutor } from '@zcode/dsh-executor';
import { ProjectsStore } from '@zcode/projects-store';
// Imported by relative path on purpose: the demo must run straight from source under tsx, without
// depending on a built `dist/` of its own package.
import {
  MissionRunner,
  createRunnerConfig,
  createWorktreePort,
  reconcileMissions,
} from '../src/index.js';

interface Args {
  repo: string;
  data: string;
  objective: string;
  workers: number;
  model?: string;
  projectName: string;
}

function parseArgs(argv: string[]): Args {  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const repo = get('repo');
  const objective = get('objective');
  if (repo === undefined || objective === undefined) {
    throw new Error('usage: demo.mts --repo <path> --data <dir> --objective "<text>" [--workers 3] [--model id]');
  }
  const model = get('model');
  return {
    repo,
    data: get('data') ?? join(repo, '..', '.zcode-projects'),
    objective,
    workers: Number(get('workers') ?? '3'),
    ...(model === undefined ? {} : { model }),
    projectName: get('project') ?? 'demo',
  };
}

/** Collect every value of a repeatable `--flag value` pair. */
function collectFlag(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === `--${name}`) {
      const value = argv[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = join(args.data);
  mkdirSync(dataDir, { recursive: true });

  const store = new ProjectsStore({ file: join(dataDir, 'projects.db') });
  // The executor builds the child environment explicitly (no ambient secrets), so the provider key
  // is forwarded by name and never inherited wholesale.
  const apiKey = process.env['DEEPSEEK_API_KEY'];
  const adapter = createDshExecutor({
    profile: 'acp',
    ...(apiKey === undefined || apiKey === '' ? {} : { env: { DEEPSEEK_API_KEY: apiKey } }),
  });
  const overrides = collectFlag(process.argv.slice(2), 'validation');
  const config = createRunnerConfig({
    maxWorkers: args.workers,
    worktreeRoot: join(dataDir, 'worktrees'),
    ...(overrides.length === 0 ? {} : { validationCommands: overrides }),
    ...(args.model === undefined ? {} : { workerModel: args.model, plannerModel: args.model, reviewerModel: args.model }),
  });

  const runner = new MissionRunner({
    store,
    adapter,
    worktrees: createWorktreePort(),
    config,
    logger: (message) => process.stderr.write(`[mission] ${message}\n`),
  });

  const started = Date.now();
  try {
    await adapter.start();

    const recovery = await reconcileMissions({ store, adapter, now: () => Date.now(), worktreeRoot: config.worktreeRoot });
    if (recovery.length > 0) process.stderr.write(`[mission] recovered ${recovery.length} mission(s)\n`);

    const project = runner.createProject({ name: args.projectName, repositoryPath: args.repo });
    const mission = runner.createMission({ projectId: project.id, objective: args.objective });
    process.stderr.write(`[mission] created ${mission.id} on ${args.repo}\n`);

    const planned = await runner.planMission(mission.id);
    process.stderr.write(`[mission] plan v${planned.plan.version} with ${planned.tasks.length} task(s)\n`);
    for (const task of planned.tasks) {
      process.stderr.write(`[mission]   - ${task.planKey}: ${task.title}\n`);
    }

    const status = await runner.startMission(mission.id);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    const snapshot = {
      missionId: mission.id,
      status: status.mission.status,
      phase: status.mission.phase,
      blockReason: status.mission.blockReason ?? null,
      tasks: status.tasks.map((task) => ({
        key: task.planKey,
        status: task.status,
        attempts: task.attempts,
        files: task.result?.filesChanged ?? [],
        commits: task.result?.commits ?? [],
      })),
      validations: runner.getValidations(mission.id).map((validation) => ({
        command: validation.command,
        exitCode: validation.exitCode,
        result: validation.result,
      })),
      reviews: runner.getReviews(mission.id).map((review) => ({
        round: review.round,
        verdict: review.verdict,
        findings: review.findings.length,
      })),
      result: runner.getResult(mission.id) ?? null,
      events: runner.getEvents(mission.id).map((event) => `${event.type}`),
      elapsedSeconds: Number(elapsed),
    };
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } finally {
    await adapter.dispose().catch(() => undefined);
    store.close();
  }
}

await main();

