import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';
import { apply } from '../src/index.js';
import { createFakeContext } from './helpers/fake-context.js';
import { createTempHome } from './helpers/temp-home.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryDatabase } from '../src/storage/database.js';

test('apply registers the dafeiyuMemory service and its fixed public methods', async (t) => {
  const ctx = createFakeContext();
  await apply(ctx, {}, { dshHome: createTempHome() });
  const service = ctx.get('dafeiyuMemory');
  t.after(() => service.dispose());
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
  assert.ok(service.database instanceof MemoryDatabase);
  assert.equal(service.writeQueue, service.database.writeQueue);
});

test('effect disposal rejects all new writes and dispose is idempotent', async () => {
  const ctx = createFakeContext();
  await apply(ctx, {}, { dshHome: createTempHome() });
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
  await apply(ctx, {}, { dshHome: createTempHome() });
  const service = ctx.get('dafeiyuMemory');
  for (const name of [
    'search', 'importExisting',
  ]) {
    const operation = service[name]({});
    assert.ok(operation instanceof Promise, `${name} returns a Promise`);
    await assert.rejects(operation, { code: 'MEMORY_NOT_IMPLEMENTED' });
  }
  assert.equal(service.recall({}), '');
  await service.dispose();
});

test('invalid configuration fails before a service or disposer is registered', async () => {
  const ctx = createFakeContext();
  await assert.rejects(async () => apply(ctx, { diskSoftLimitBytes: 1 }, { dshHome: createTempHome() }), { code: 'MEMORY_INVALID_CONFIG' });
  assert.equal(ctx.get('dafeiyuMemory'), undefined);
  assert.equal(ctx.disposers.length, 0);
});

test('the real Cordis plugin lifecycle registers and closes the service', async (t) => {
  const ctx = new Context();
  const dshHome = createTempHome();
  const fiber = await ctx.plugin((ctx, config) => apply(ctx, config, { dshHome }));
  t.after(() => fiber.dispose());
  const service = ctx.get('dafeiyuMemory');
  assert.ok(service instanceof Service);
  assert.equal(service.recall(), '');
  await fiber.dispose();
  assert.equal(service.status().state, 'disposed');
  await assert.rejects(service.recordEvent({}), { code: 'MEMORY_DISPOSED' });
  await service.dispose();
});

test('service disposal drains accepted database writes and closes the queue and database', async () => {
  const ctx = createFakeContext();
  await apply(ctx, {}, { dshHome: createTempHome() });
  const service = ctx.get('dafeiyuMemory');
  const accepted = service.database.write((db) => db.prepare("INSERT INTO schema_meta VALUES ('lifecycle', 'saved')").run());
  const closing = service.dispose();
  assert.equal(service.status().state, 'disposed');
  await assert.rejects(service.recordEvent({}), { code: 'MEMORY_DISPOSED' });
  await closing;
  await accepted;
  await assert.rejects(service.writeQueue.enqueue(() => {}), { code: 'MEMORY_QUEUE_CLOSED' });
  assert.throws(() => service.database.read(() => {}), { code: 'MEMORY_DATABASE_CLOSED' });
  const reopened = await MemoryDatabase.open(service.paths.database);
  try {
    assert.equal(reopened.read((db) => db.prepare("SELECT value FROM schema_meta WHERE key = 'lifecycle'").get().value), 'saved');
  } finally { await reopened.close(); }
});

test('database initialization failure leaves no registered service or disposer', async () => {
  const ctx = createFakeContext();
  const dshHome = createTempHome();
  writeFileSync(join(dshHome, 'dafeiyu-memory'), 'blocks the database directory');
  await assert.rejects(apply(ctx, {}, { dshHome }), (error) => {
    assert.equal(error.code, 'MEMORY_DATABASE_OPEN_FAILED');
    assert.equal(error.message, 'Memory database could not be opened');
    assert.equal(String(error.stack), 'Error: Memory database could not be opened');
    assert.equal(error.message.includes(dshHome), false);
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ['code', 'message', 'stack']);
    assert.equal(JSON.stringify(error).includes(dshHome), false);
    return true;
  });
  assert.equal(ctx.get('dafeiyuMemory'), undefined);
  assert.equal(ctx.disposers.length, 0);
});
