# @zcode/dsh-executor

DeepSeek Harness executor adapter over ACP (agent session client). Engine-agnostic: this package
never imports `@zcode/dynamic-workflow`.

```ts
import { createDshExecutor } from '@zcode/dsh-executor';

const executor = createDshExecutor({ permissionMode: 'danger-full-access' });
await executor.start();
const { sessionId } = await executor.createSession({ cwd: '/abs/worktree' });
const { stopReason, finalText, submission } = await executor.runTask(sessionId, 'do the thing');
await executor.dispose();
```

**[CONTRACT.md](CONTRACT.md) is required reading before using this package**: full API, the confirmed
protocol facts (cancel is a notification, `session/new` settles after its initial updates, the exact
`mcpServers` shape), the invariants (typed errors, secret redaction, framing policy, dispose order)
and the known traps — most importantly that a completed tool call is **not** proof of a side effect
under the default `workspace-write` sandbox, so callers must either assert on the host filesystem or
start workers with `permissionMode: 'danger-full-access'`.

Specs: `specs/projects/40-dsh-executor.md`. Wire evidence: `reports/s3-s4-s5-dsh-acp.md`.

```bash
pnpm --filter @zcode/dsh-executor lint
pnpm --filter @zcode/dsh-executor typecheck
pnpm --filter @zcode/dsh-executor test
DSH_EXECUTOR_LIVE=1 node --import tsx --test tests/live.test.ts   # needs a sourced DEEPSEEK_API_KEY
```
