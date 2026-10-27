import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { resolveConfig } from '../src/config.js';
import { resolveMemoryPaths } from '../src/paths.js';

test('configuration fixes the agreed retention, capacity, recall and review defaults', () => {
  const config = resolveConfig();
  assert.deepEqual(config, {
    shortTermDays: 7,
    longTermDays: 30,
    recycleDays: 7,
    diskSoftLimitBytes: 1024 ** 3,
    diskWarningRatio: 0.8,
    recallQuotas: { shortTerm: 8, longTerm: 6, diary: 3 },
    reviewBatchSize: 40,
    reviewTimeoutMs: 120_000,
    reviewMaxAttempts: 8,
    retryBaseMs: 15 * 60_000,
    retryMaxMs: 24 * 60 * 60_000,
  });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.recallQuotas));
});

test('configuration accepts the 256 MiB capacity safety boundary', () => {
  assert.equal(resolveConfig({ diskSoftLimitBytes: 256 * 1024 ** 2 }).diskSoftLimitBytes, 256 * 1024 ** 2);
  assert.deepEqual(resolveConfig({ recallQuotas: { diary: 2 } }).recallQuotas, { shortTerm: 8, longTerm: 6, diary: 2 });
});

for (const [name, minimum] of [
  ['shortTermDays', 7],
  ['longTermDays', 30],
  ['recycleDays', 7],
]) {
  test(`${name} accepts its minimum retention and higher values`, () => {
    for (const value of [minimum, minimum + 1]) {
      assert.equal(resolveConfig({ [name]: value })[name], value);
    }
  });

  test(`${name} rejects retention below its minimum`, () => {
    for (const value of [1, minimum - 1]) {
      assert.throws(() => resolveConfig({ [name]: value }), { code: 'MEMORY_INVALID_CONFIG' });
    }
  });
}

test('configuration rejects unsafe capacity and invalid retention/review controls', () => {
  for (const overrides of [
    { diskSoftLimitBytes: 256 * 1024 ** 2 - 1 },
    { diskSoftLimitBytes: Infinity },
    { diskSoftLimitBytes: '1073741824' },
    { diskWarningRatio: 0.9 },
    { shortTermDays: 0 },
    { longTermDays: -1 },
    { recycleDays: 1.5 },
    { recallQuotas: { shortTerm: 0 } },
    { reviewBatchSize: NaN },
    { reviewTimeoutMs: -1 },
    { reviewMaxAttempts: 0 },
    { retryBaseMs: 0 },
    { retryBaseMs: 20, retryMaxMs: 10 },
  ]) {
    assert.throws(() => resolveConfig(overrides), { code: 'MEMORY_INVALID_CONFIG' });
  }
});

test('configuration rejects malformed root and recall quota objects', () => {
  for (const overrides of [null, [], 1, 'config', { recallQuotas: null }, { recallQuotas: [] }, { recallQuotas: 'quota' }]) {
    assert.throws(() => resolveConfig(overrides), { code: 'MEMORY_INVALID_CONFIG' });
  }
});

test('all memory paths live in the dedicated directory below an injected DSH_HOME', () => {
  const dshHome = join(tmpdir(), 'dafeiyu-memory-test-home');
  const root = join(dshHome, 'dafeiyu-memory');
  assert.deepEqual(resolveMemoryPaths({ dshHome }), {
    root,
    database: join(root, 'memory.sqlite'),
    backups: join(root, 'backups'),
    spool: join(root, 'spool'),
    reports: join(root, 'reports'),
  });
});

test('default memory paths use the host resolver and reject relative test roots', () => {
  assert.equal(resolveMemoryPaths().root, join(resolveDshHome(), 'dafeiyu-memory'));
  for (const dshHome of ['', 'relative-root', null, 123]) {
    assert.throws(() => resolveMemoryPaths({ dshHome }), { code: 'MEMORY_INVALID_PATH' });
  }
});
