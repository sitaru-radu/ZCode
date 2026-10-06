import assert from 'node:assert/strict';
import test from 'node:test';

import { packageName } from '../src/index.js';

test('@zcode/projects-core scaffold loads', () => {
  assert.equal(packageName, '@zcode/projects-core');
});
