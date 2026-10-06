import assert from 'node:assert/strict';
import test from 'node:test';

import { packageName } from '../src/index.js';

test('@zcode/projects-store scaffold loads', () => {
  assert.equal(packageName, '@zcode/projects-store');
});
