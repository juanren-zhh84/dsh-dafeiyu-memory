import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryDatabase } from '../src/storage/database.js';
import { resolveConfig } from '../src/config.js';
import { createTempHome } from './helpers/temp-home.js';
import { eventInput, NOW, DAY } from './fixtures/events.js';
import { apply } from '../src/index.js';
import { createFakeContext } from './helpers/fake-context.js';
import { MemoryRepository } from '../src/memory/repository.js';

async function setup(t, options = {}) {
  assert.equal(typeof MemoryRepository, 'function', 'MemoryRepository must implement persistent event storage');
  const database = await MemoryDatabase.open(join(createTempHome(), 'memory.sqlite'));
  t.after(() => database.close());
  let nextId = 0;
  const time = { value: NOW };
  const repository = new MemoryRepository({
    database, writeQueue: database.writeQueue, config: resolveConfig(),
    clock: { now: () => time.value }, idGenerator: () => `id-${++nextId}`, ...options,
  });
  const rows = (table) => database.read((db) => db.prepare(`SELECT * FROM ${table}`).all());
  return { database, repository, rows, time };
}

async function batch(context, inputs = [eventInput()]) {
  const events = [];
  for (const input of inputs) events.push(await context.repository.insertEvent(input));
  await context.database.write((db) => db.prepare(`INSERT INTO review_jobs
    (id, kind, batch_key, source_ids_json, state, due_at, created_at, updated_at)
    VALUES ('job-1', 'short-term', 'batch-1', ?, 'leased', ?, ?, ?)`)
    .run(JSON.stringify(events.map(({ id }) => id)), NOW, NOW, NOW));
  return { jobId: 'job-1', candidates: events.map(({ id, version }) => ({ id, version })), retain: [], diary: [], discard: [] };
}

function retention(sourceIds, overrides = {}) {
  return { sourceIds, kind: 'preference', subjectKey: 'user-1', subjectName: '测试用户',
    content: '喜欢钓鱼', importance: 0.6, ...overrides };
}

test('repeated source keys return the original event without inserting another row', async (t) => {
  const { repository, rows } = await setup(t);
  const [first, second] = await Promise.all([
    repository.insertEvent(eventInput()), repository.insertEvent(eventInput({ contentText: '重复发送' })),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(rows('memory_events').length, 1);
  assert.equal(first.contentText, '我喜欢钓鱼');
  assert.equal(first.reviewDueAt, NOW + 7 * DAY);
  assert.equal(first.version, 1);
});

test('event insertion checks purge ledger inside its queued transaction before generating an ID or writing a body', async (t) => {
  const { database, repository, rows } = await setup(t, { idGenerator: () => { throw new Error('must not create a purged event'); } });
  const sourceHash = createHash('sha256').update(`event\0${JSON.stringify(['qq', 'message-1'])}`).digest('hex');
  const ledgerWrite = database.write((db) => db.prepare('INSERT INTO purge_ledger VALUES (?, ?, ?)').run(sourceHash, 'event', NOW));
  const result = repository.insertEvent(eventInput());
  await ledgerWrite;
  assert.deepEqual(await result, { inserted: false, deduplicated: true, purged: true, id: null });
  assert.equal(rows('memory_events').length, 0);
  assert.equal(rows('purge_ledger').length, 1);
});

test('missing source keys use a deterministic normalized SHA-256 content fingerprint', async (t) => {
  const { repository, rows } = await setup(t);
  const first = await repository.insertEvent(eventInput({ sourceKey: undefined, contentText: ' Ａ\n  fishing ' }));
  const second = await repository.insertEvent(eventInput({ sourceKey: undefined, contentText: 'A fishing' }));
  const fingerprint = createHash('sha256').update(JSON.stringify(['qq', 'qq:user-1', 'incoming', NOW, 'A fishing'])).digest('hex');
  assert.equal(first.sourceKey, fingerprint);
  assert.equal(first.id, second.id);
  assert.equal(rows('memory_events').length, 1);
});

test('media persists only a text placeholder containing a stable reference', async (t) => {
  const { repository, rows } = await setup(t);
  const event = await repository.insertEvent(eventInput({ contentText: '', mediaRefs: ['qq:media:photo-1'] }));
  assert.equal(event.contentText, '[media:qq:media:photo-1]');
  assert.equal(rows('memory_events')[0].content_text, event.contentText);
  for (const mediaRefs of [[Buffer.from('secret')], [{ url: 'secret' }], [new Uint8Array([1])], ['x'.repeat(2049)], Array(21).fill('x'),
    ['data:image/png;base64,secret'], ['blob:secret'], ['base64:secret'], ['bad\0ref']]) {
    await assert.rejects(repository.insertEvent(eventInput({ mediaRefs })), { code: 'MEMORY_INVALID_INPUT' });
  }
});

test('media stable IDs are not guessed to be binary from their spelling', async (t) => {
  const { repository } = await setup(t);
  const event = await repository.insertEvent(eventInput({ mediaRefs: ['aGVsbG8=', 'iVBORw0KGgoAAA'] }));
  assert.match(event.contentText, /\[media:aGVsbG8=\]/);
});

test('invalid event lengths, enum values and unsafe times reject without persisting data', async (t) => {
  const { repository, rows } = await setup(t);
  for (const change of [
    { contentText: 'x'.repeat(16001) }, { sourceKey: 'x'.repeat(513) }, { actorName: 'x'.repeat(201) },
    { source: 'unknown' }, { direction: 'sideways' }, { conversationKind: 'unknown' },
    { visibility: 'everyone' }, { occurredAt: 1.5 }, { occurredAt: Number.MAX_SAFE_INTEGER + 1 },
    { occurredAt: Number.MAX_SAFE_INTEGER }, { occurredAt: 'now' },
  ]) await assert.rejects(repository.insertEvent(eventInput(change)), { code: 'MEMORY_INVALID_INPUT' });
  assert.equal(rows('memory_events').length, 0);
});

test('event validation reads only plain object own data fields', async (t) => {
  const { repository, rows } = await setup(t);
  let getterCalls = 0;
  const accessor = eventInput();
  Object.defineProperty(accessor, 'contentText', { get() { getterCalls++; throw new Error('account-secret'); } });
  for (const input of [[], Object.create(eventInput()), accessor, { ...eventInput(), media: Buffer.from('secret') }]) {
    await assert.rejects(repository.insertEvent(input), { code: 'MEMORY_INVALID_INPUT' });
  }
  assert.equal(getterCalls, 0);
  assert.equal(rows('memory_events').length, 0);
});

test('repository failures expose a stable code without payloads, paths or native error fields', async (t) => {
  const { repository } = await setup(t, { idGenerator: () => { throw new Error('C:\\private\\account-secret'); } });
  await assert.rejects(repository.insertEvent(eventInput({ contentText: 'body-secret' })), (error) => {
    assert.equal(error.code, 'MEMORY_STORAGE_FAILED');
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ['code', 'message', 'stack']);
    assert.equal(error.stack, `Error: ${error.message}`);
    assert.doesNotMatch(JSON.stringify(error), /private|account-secret|body-secret/);
    return true;
  });
});

test('promotion atomically retains memories for 30 days, recycles all sources and completes the job', async (t) => {
  const context = await setup(t);
  const plan = await batch(context, [eventInput(), eventInput({ sourceKey: 'message-2', visibility: 'public' }), eventInput({ sourceKey: 'message-3' })]);
  const ids = plan.candidates.map(({ id }) => id);
  plan.retain = [retention([ids[0], ids[1]])];
  plan.discard = [ids[2]];
  context.time.value = NOW + 7 * DAY;
  const result = await context.repository.promoteEvents(plan);
  assert.equal(result.items.length, 1);
  assert.equal(result.diary.length, 0);
  const item = result.items[0];
  assert.equal(item.promotedAt, context.time.value);
  assert.equal(item.expiresAt, item.promotedAt + 30 * DAY);
  assert.equal(item.visibility, 'owner-private');
  assert.equal(item.confidence, 1);
  assert.deepEqual(item.sourceRefs, ids.slice(0, 2));
  assert.ok(context.rows('memory_events').every((row) => row.state === 'recycle' && row.version === 2 && row.purge_due_at === context.time.value + 7 * DAY));
  assert.equal(context.rows('review_jobs')[0].state, 'completed');
});

test('promotion diaries derive visibility and preserve exact source references', async (t) => {
  const context = await setup(t);
  const plan = await batch(context);
  plan.diary = [{ sourceIds: [plan.candidates[0].id], title: '钓鱼', body: '今天聊到了钓鱼。' }];
  const result = await context.repository.promoteEvents(plan);
  assert.equal(result.diary[0].visibility, 'owner-private');
  assert.deepEqual(result.diary[0].sourceRefs, [plan.candidates[0].id]);
  assert.equal(context.rows('diary_entries').length, 1);
});

test('promotion rejects missing, duplicated, overlapping and out-of-batch references without changing state', async (t) => {
  const context = await setup(t);
  const plan = await batch(context);
  const id = plan.candidates[0].id;
  for (const overrides of [
    {}, { discard: ['missing'] }, { discard: [id, id] },
    { retain: [retention([id])], discard: [id] },
    { retain: [retention([id, id])] }, { retain: [retention(['missing'])] },
    { retain: [retention([id], { visibility: 'public' })] },
    { retain: [retention([id], { content: 'x'.repeat(4001) })] },
    { retain: [retention([id], { importance: 2 })] },
    { retain: [retention([id], { confidence: NaN })] },
  ]) await assert.rejects(context.repository.promoteEvents({ ...plan, ...overrides }), { code: 'MEMORY_INVALID_INPUT' });
  assert.equal(context.rows('memory_items').length, 0);
  assert.equal(context.rows('memory_events')[0].state, 'active');
  assert.equal(context.rows('review_jobs')[0].state, 'leased');
});

test('promotion checks job existence, exact job membership, candidate versions and active state', async (t) => {
  const context = await setup(t);
  const plan = await batch(context);
  plan.discard = [plan.candidates[0].id];
  await assert.rejects(context.repository.promoteEvents({ ...plan, jobId: 'missing' }), { code: 'MEMORY_REFERENCE_NOT_FOUND' });
  await assert.rejects(context.repository.promoteEvents({ ...plan, candidates: [{ id: 'missing', version: 1 }], discard: ['missing'] }), { code: 'MEMORY_CONFLICT' });
  await assert.rejects(context.repository.promoteEvents({ ...plan, candidates: [{ ...plan.candidates[0], version: 2 }] }), { code: 'MEMORY_CONFLICT' });
  await context.database.write((db) => db.prepare("UPDATE memory_events SET state = 'recycle' WHERE id = ?").run(plan.candidates[0].id));
  await assert.rejects(context.repository.promoteEvents(plan), { code: 'MEMORY_CONFLICT' });
  assert.equal(context.rows('review_jobs')[0].state, 'leased');
});

test('a write failure rolls back earlier retained items, source moves and job completion', async (t) => {
  const context = await setup(t);
  const plan = await batch(context, [eventInput(), eventInput({ sourceKey: 'message-2' })]);
  plan.retain = plan.candidates.map(({ id }) => retention([id]));
  context.repository.idGenerator = () => 'duplicate';
  await assert.rejects(context.repository.promoteEvents(plan), { code: 'MEMORY_STORAGE_FAILED' });
  assert.equal(context.rows('memory_items').length, 0);
  assert.ok(context.rows('memory_events').every((row) => row.state === 'active' && row.version === 1));
  assert.equal(context.rows('review_jobs')[0].state, 'leased');
});

test('diary corrections append a new row with a valid supersedes reference', async (t) => {
  const { repository, rows } = await setup(t);
  const original = await repository.appendDiary({ title: '原记', body: '原始内容', visibility: 'owner-private' });
  const correction = await repository.appendDiary({ title: '修正', body: '更正内容', visibility: 'owner-private', supersedesId: original.id });
  assert.equal(correction.supersedesId, original.id);
  assert.equal(rows('diary_entries').length, 2);
  assert.equal(rows('diary_entries')[0].body, '原始内容');
  await assert.rejects(repository.appendDiary({ title: '错', body: '错', visibility: 'owner-private', supersedesId: 'missing' }), { code: 'MEMORY_REFERENCE_NOT_FOUND' });
  assert.equal(rows('diary_entries').length, 2);
});

test('standalone diary input bounds references, title/body and source visibility', async (t) => {
  const { repository, rows } = await setup(t);
  const event = await repository.insertEvent(eventInput());
  const valid = { title: '日记', body: '内容', sourceRefs: [event.id] };
  for (const overrides of [
    { title: 'x'.repeat(201) }, { body: 'x'.repeat(16001) }, { visibility: 'public' },
    { sourceRefs: Array(101).fill(event.id) }, { sourceRefs: ['x'.repeat(513)] },
    { sourceRefs: [Object.create({ id: event.id })] }, { sourceRefs: ['missing'] },
  ]) await assert.rejects(repository.appendDiary({ ...valid, ...overrides }));
  const diary = await repository.appendDiary(valid);
  assert.deepEqual(diary.sourceRefs, [event.id]);
  assert.equal(diary.visibility, 'owner-private');
  assert.equal(rows('diary_entries').length, 1);
});

test('moving and restoring events enforce current state and clear purge deadlines', async (t) => {
  const { repository, rows, time } = await setup(t);
  const event = await repository.insertEvent(eventInput());
  const recycled = await repository.moveToRecycle({ kind: 'event', id: event.id, version: 1 });
  assert.equal(recycled.state, 'recycle');
  assert.equal(recycled.purgeDueAt, NOW + 7 * DAY);
  assert.equal(recycled.version, 2);
  await assert.rejects(repository.moveToRecycle({ kind: 'event', id: event.id }), { code: 'MEMORY_CONFLICT' });
  await assert.rejects(repository.restoreRecycle({ kind: 'event', id: event.id, version: 1 }), { code: 'MEMORY_CONFLICT' });
  time.value += DAY;
  const restored = await repository.restoreRecycle({ kind: 'event', id: event.id, version: 2 });
  assert.equal(restored.state, 'active');
  assert.equal(restored.version, 3);
  assert.equal(restored.purgeDueAt, null);
  assert.equal(restored.reviewDueAt, event.reviewDueAt);
  await assert.rejects(repository.restoreRecycle({ kind: 'event', id: event.id }), { code: 'MEMORY_CONFLICT' });
  await assert.rejects(repository.moveToRecycle({ kind: 'diary', id: event.id }), { code: 'MEMORY_INVALID_INPUT' });
  await assert.rejects(repository.moveToRecycle({ kind: 'item', id: 'missing' }), { code: 'MEMORY_REFERENCE_NOT_FOUND' });
  assert.equal(rows('diary_entries').length, 0);
});

test('restoring long-term memory preserves its original expiration', async (t) => {
  const context = await setup(t);
  const plan = await batch(context);
  plan.retain = [retention([plan.candidates[0].id])];
  const { items: [item] } = await context.repository.promoteEvents(plan);
  await context.repository.moveToRecycle({ kind: 'item', id: item.id });
  context.time.value += 40 * DAY;
  const restored = await context.repository.restoreRecycle({ kind: 'item', id: item.id });
  assert.equal(restored.expiresAt, item.expiresAt);
  assert.equal(restored.promotedAt, item.promotedAt);
  assert.equal(restored.purgeDueAt, null);
  assert.equal(restored.state, 'active');
});

test('due queries are synchronous, ordered, bounded and exclude recycled records', async (t) => {
  const { repository, time } = await setup(t);
  const late = await repository.insertEvent(eventInput({ sourceKey: 'late', occurredAt: NOW + DAY }));
  const early = await repository.insertEvent(eventInput({ sourceKey: 'early', occurredAt: NOW - DAY }));
  const recycled = await repository.insertEvent(eventInput({ sourceKey: 'recycled', occurredAt: NOW - 2 * DAY }));
  await repository.moveToRecycle({ kind: 'event', id: recycled.id });
  assert.deepEqual(repository.findDueEvents(), []);
  time.value = NOW + 8 * DAY;
  assert.deepEqual(repository.findDueEvents().map(({ id }) => id), [early.id, late.id]);
  assert.deepEqual(repository.findDueEvents({ limit: 1 }).map(({ id }) => id), [early.id]);
  assert.deepEqual(repository.findDueEvents({ now: NOW + 6 * DAY }).map(({ id }) => id), [early.id]);
  assert.deepEqual(repository.findDueItems(), []);
  for (const options of [{ limit: 0 }, { limit: 41 }, { limit: 1.5 }, { now: Infinity }, []]) {
    assert.throws(() => repository.findDueEvents(options), { code: 'MEMORY_INVALID_INPUT' });
    assert.throws(() => repository.findDueItems(options), { code: 'MEMORY_INVALID_INPUT' });
  }
});

test('reading due memories and status counts never extends their expiration', async (t) => {
  const context = await setup(t);
  const plan = await batch(context);
  plan.retain = [retention([plan.candidates[0].id])];
  const { items: [item] } = await context.repository.promoteEvents(plan);
  await context.repository.appendDiary({ title: '手记', body: '内容' });
  assert.deepEqual(context.repository.findDueItems(), []);
  context.time.value += 30 * DAY;
  assert.equal(context.repository.findDueItems()[0].expiresAt, item.expiresAt);
  assert.deepEqual(context.repository.getStatusCounts(), {
    events: { active: 0, reviewPending: 0, recycle: 1 }, items: { active: 1, recycle: 0 }, diary: 1,
  });
  assert.equal(context.rows('memory_items')[0].expires_at, item.expiresAt);
});

test('service delegates recording, diary append, recycle restore and counts while recall leaves expiration unchanged', async (t) => {
  const ctx = createFakeContext();
  await apply(ctx, {}, { dshHome: createTempHome() });
  const service = ctx.get('dafeiyuMemory');
  t.after(() => service.dispose());
  const event = await service.recordEvent(eventInput());
  assert.equal(service.status().events.active, 1);
  await service.repository.moveToRecycle({ kind: 'event', id: event.id });
  const restored = await service.restoreRecycleItem({ kind: 'event', id: event.id });
  assert.equal(restored.purgeDueAt, null);
  const diary = await service.promoteToDiary({ title: '手记', body: '内容' });
  assert.equal(diary.visibility, 'owner-private');
  const plan = await batch({ repository: service.repository, database: service.database });
  plan.retain = [retention([plan.candidates[0].id])];
  const { items: [item] } = await service.repository.promoteEvents(plan);
  assert.equal(service.recall(), '');
  assert.equal(service.database.read((db) => db.prepare('SELECT expires_at FROM memory_items WHERE id = ?').get(item.id).expires_at), item.expiresAt);
  assert.equal(service.status().diary, 1);
  await assert.rejects(service.purgeRecycleItem({}), { code: 'MEMORY_INVALID_INPUT' });
});

test('explicit null diary fields are rejected instead of being treated as omitted defaults', async (t) => {
  const { repository } = await setup(t);
  for (const extra of [{ sourceRefs: null }, { visibility: null }]) {
    await assert.rejects(repository.appendDiary({ title: '日记', body: '正文', ...extra }), { code: 'MEMORY_INVALID_INPUT' });
  }
});

test('thrown accessor errors are sanitized without evaluating their code property', async (t) => {
  let codeReads = 0;
  const { repository } = await setup(t, { idGenerator: () => {
    throw Object.defineProperty({}, 'code', { get() { codeReads++; throw new Error('account-secret'); } });
  } });
  await assert.rejects(repository.insertEvent(eventInput()), (error) => {
    assert.equal(error.code, 'MEMORY_STORAGE_FAILED');
    assert.equal(error.stack, `Error: ${error.message}`);
    return true;
  });
  assert.equal(codeReads, 0);
});

test('service disposal errors do not expose runtime paths in their stack', async () => {
  const ctx = createFakeContext();
  await apply(ctx, {}, { dshHome: createTempHome() });
  const service = ctx.get('dafeiyuMemory');
  await service.dispose();
  await assert.rejects(service.recordEvent(eventInput()), (error) => {
    assert.equal(error.stack, 'Error: Memory service is disposed');
    return true;
  });
});

test('queued writes capture caller data before waiting and check versions when executed', async (t) => {
  const context = await setup(t);
  const input = eventInput();
  const queuedEvent = context.repository.insertEvent(input);
  input.contentText = 'caller changed';
  const event = await queuedEvent;
  assert.equal(event.contentText, '我喜欢钓鱼');
  const plan = await batch(context);
  plan.discard = [event.id];
  const versionChange = context.database.write((db) => db.prepare('UPDATE memory_events SET version = version + 1 WHERE id = ?').run(event.id));
  const promotion = context.repository.promoteEvents(plan);
  await versionChange;
  await assert.rejects(promotion, { code: 'MEMORY_CONFLICT' });
  assert.equal(context.rows('review_jobs')[0].state, 'leased');
});

test('array accessors, holes and inherited members never enter repository DTOs', async (t) => {
  const { repository } = await setup(t);
  let reads = 0;
  const accessor = [];
  Object.defineProperty(accessor, 0, { get() { reads++; return 'qq:photo'; } });
  const inherited = Object.setPrototypeOf(['qq:photo'], Object.create(Array.prototype));
  for (const mediaRefs of [accessor, new Array(1), inherited]) {
    await assert.rejects(repository.insertEvent(eventInput({ mediaRefs })), { code: 'MEMORY_INVALID_INPUT' });
  }
  assert.equal(reads, 0);
});

test('media placeholders must fit the final stored body limit', async (t) => {
  const { repository, rows } = await setup(t);
  await assert.rejects(repository.insertEvent(eventInput({ contentText: 'x'.repeat(16000), mediaRefs: ['qq:photo'] })), { code: 'MEMORY_INVALID_INPUT' });
  assert.equal(rows('memory_events').length, 0);
});

test('review-pending events and queued jobs can complete once, with failed correction writes rolled back', async (t) => {
  const context = await setup(t);
  const plan = await batch(context, [eventInput(), eventInput({ sourceKey: 'second' })]);
  const [first, second] = plan.candidates.map(({ id }) => id);
  plan.retain = [retention([first])];
  plan.diary = [{ sourceIds: [second], title: '修正', body: '内容', supersedesId: 'missing' }];
  await context.database.write((db) => {
    db.prepare("UPDATE memory_events SET state = 'review-pending'").run();
    db.prepare("UPDATE review_jobs SET state = 'queued'").run();
  });
  await assert.rejects(context.repository.promoteEvents(plan), { code: 'MEMORY_REFERENCE_NOT_FOUND' });
  assert.equal(context.rows('memory_items').length, 0);
  assert.ok(context.rows('memory_events').every(({ state }) => state === 'review-pending'));
  delete plan.diary[0].supersedesId;
  await context.repository.promoteEvents(plan);
  await assert.rejects(context.repository.promoteEvents(plan), { code: 'MEMORY_CONFLICT' });
  assert.equal(context.rows('memory_items').length, 1);
  assert.equal(context.rows('diary_entries').length, 1);
});

test('review batches and due reads have a hard ceiling of 40 even with a larger configured size', async (t) => {
  const context = await setup(t, { config: resolveConfig({ reviewBatchSize: 100 }) });
  for (let index = 0; index < 41; index++) {
    await context.repository.insertEvent(eventInput({ sourceKey: `message-${index}`, occurredAt: NOW - 8 * DAY }));
  }
  assert.equal(context.repository.findDueEvents().length, 40);
  assert.throws(() => context.repository.findDueEvents({ limit: 41 }), { code: 'MEMORY_INVALID_INPUT' });
  const ids = context.rows('memory_events').map(({ id }) => id);
  await assert.rejects(context.repository.promoteEvents({ jobId: 'unused',
    candidates: ids.map((id) => ({ id, version: 1 })), retain: [], diary: [], discard: ids,
  }), { code: 'MEMORY_INVALID_INPUT' });
});

test('short-term events preserve original text while only the fingerprint uses normalization', async (t) => {
  const { repository } = await setup(t);
  const original = ' Ａ\n  fishing\t ';
  const first = await repository.insertEvent(eventInput({ sourceKey: 'formatted', contentText: original }));
  const second = await repository.insertEvent(eventInput({ sourceKey: 'unformatted', contentText: 'A fishing' }));
  assert.equal(first.contentText, original);
  assert.equal(second.contentText, 'A fishing');
  assert.notEqual(first.id, second.id);
  const expansion = '\ufdfa'.repeat(1000);
  assert.equal((await repository.insertEvent(eventInput({ sourceKey: 'nfkc-expansion', contentText: expansion }))).contentText, expansion);
  const withMedia = await repository.insertEvent(eventInput({ sourceKey: 'media-format', contentText: original, mediaRefs: ['qq:photo'] }));
  assert.equal(withMedia.contentText, `${original}\n[media:qq:photo]`);
  await assert.rejects(repository.insertEvent(eventInput({ contentText: 'bad\x1bcontrol' })), { code: 'MEMORY_INVALID_INPUT' });
});
