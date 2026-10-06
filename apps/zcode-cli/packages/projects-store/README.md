# @zcode/projects-store

SQLite persistence for projects, missions, plans, tasks, workers, mission events, validations and
reviews. Owns its own database file (`projects.db`, decision D5) — the core ZCode database is never
opened or migrated here.

```ts
import { ProjectsStore } from '@zcode/projects-store';

const store = new ProjectsStore({ file: '/path/to/zcode-data/projects.db' });
store.createProject(project);
const plan = store.getLatestPlan(missionId);
store.appendEvent(missionId, 'task.dispatched', { taskId }, runSeq);
store.close();
```

Synchronous API (`node:sqlite` `DatabaseSync`), checksummed migrations, WAL + `foreign_keys = ON`,
idempotent task materialization and store-allocated monotonic event sequences.

- Spec: `specs/projects/20-store.md` (repository root)
- Domain types: `@zcode/projects-core` (type-only dependency)
- Verify: `pnpm --filter @zcode/projects-store lint|typecheck|test`
