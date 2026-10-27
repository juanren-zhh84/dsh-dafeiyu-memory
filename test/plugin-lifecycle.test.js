import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';
import { apply } from '../src/index.js';
import { createFakeContext } from './helpers/fake-context.js';

test('apply registers the dafeiyuMemory service and its fixed public methods', () => {
  const ctx = createFakeContext();
  apply(ctx, {}, { dshHome: process.cwd() });
  const service = ctx.get('dafeiyuMemory');
  assert.ok(service);
  assert.ok(service instanceof Service);
  for (const name of [
    'recordEvent', 'recall', 'status', 'search', 'importExisting',
    'runDueReviews', 'backup', 'restoreRecycleItem', 'purgeRecycleItem',
    'promoteToDiary', 'dispose',
  ]) {
    assert.equal(typeof service[name], 'function', `${name} is public`);
  }
  assert.equal(ctx.disposers.length, 1);
  assert.equal(typeof service.recall({}), 'string');
  assert.equal(service.status().state, 'ready');
});

test('effect disposal rejects all new writes and dispose is idempotent', async () => {
  const ctx = createFakeContext();
  apply(ctx, {}, { dshHome: process.cwd() });
  const service = ctx.get('dafeiyuMemory');
  await ctx.disposers[0]();
  for (const name of [
    'recordEvent', 'search', 'importExisting', 'runDueReviews', 'backup',
    'restoreRecycleItem', 'purgeRecycleItem', 'promoteToDiary',
  ]) {
    const operation = service[name]({});
    assert.ok(operation instanceof Promise, `${name} returns a Promise`);
    await assert.rejects(operation, { code: 'MEMORY_DISPOSED' });
  }
  await service.dispose();
  await ctx.disposers[0]();
  assert.throws(() => service.recall({}), { code: 'MEMORY_DISPOSED' });
  assert.equal(service.status().state, 'disposed');
});

test('unimplemented asynchronous operations fail explicitly instead of reporting success', async () => {
  const ctx = createFakeContext();
  apply(ctx, {}, { dshHome: process.cwd() });
  const service = ctx.get('dafeiyuMemory');
  for (const name of [
    'recordEvent', 'search', 'importExisting', 'runDueReviews', 'backup',
    'restoreRecycleItem', 'purgeRecycleItem', 'promoteToDiary',
  ]) {
    const operation = service[name]({});
    assert.ok(operation instanceof Promise, `${name} returns a Promise`);
    await assert.rejects(operation, { code: 'MEMORY_NOT_IMPLEMENTED' });
  }
  assert.equal(service.recall({}), '');
  await service.dispose();
});

test('invalid configuration fails before a service or disposer is registered', () => {
  const ctx = createFakeContext();
  assert.throws(() => apply(ctx, { diskSoftLimitBytes: 1 }), { code: 'MEMORY_INVALID_CONFIG' });
  assert.equal(ctx.get('dafeiyuMemory'), undefined);
  assert.equal(ctx.disposers.length, 0);
});

test('the real Cordis plugin lifecycle registers and closes the service', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(apply);
  const service = ctx.get('dafeiyuMemory');
  assert.ok(service instanceof Service);
  assert.equal(service.recall(), '');
  await fiber.dispose();
  assert.equal(service.status().state, 'disposed');
  await assert.rejects(service.recordEvent({}), { code: 'MEMORY_DISPOSED' });
  await service.dispose();
});
