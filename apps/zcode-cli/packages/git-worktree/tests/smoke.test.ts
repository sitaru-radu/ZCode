import assert from 'node:assert/strict';
import test from 'node:test';

import { packageName } from '../src/index.js';

test('@zcode/git-worktree scaffold loads', () => {
  assert.equal(packageName, '@zcode/git-worktree');
});
