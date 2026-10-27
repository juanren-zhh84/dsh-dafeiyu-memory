import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { MemoryDatabase } from '../src/storage/database.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { resolveConfig } from '../src/config.js';
import { createTempHome } from './helpers/temp-home.js';
import { createFakeContext } from './helpers/fake-context.js';
import { eventInput, NOW, DAY } from './fixtures/events.js';
import { apply } from '../src/index.js';
import { ReviewLifecycle } from '../src/review/lifecycle.js';
import { ReviewScheduler } from '../src/review/scheduler.js';

const discardAll = async ({ mode, candidates }) => ({ ...(mode === 'short-term' ? { retain: [] } : {}),
  diary: [], discard: candidates.map(({ id }) => id) });
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

async function setup(t, overrides = {}) {
  const database = await MemoryDatabase.open(join(createTempHome(), 'memory.sqlite'));
  const time = { value: NOW };
  const clock = { now: () => time.value };
  const config = resolveConfig(overrides.config);
  let id = 0;
  const repository = new MemoryRepository({ database, config, clock, idGenerator: () => `memory-${++id}` });
  const calls = [];
  const reviewModel = { review: async (input, options) => { calls.push(input); return (overrides.review ?? discardAll)(input, options); } };
  const options = { database, repository, config, clock, reviewModel };
  const lifecycle = new ReviewLifecycle(options);
  t.after(async () => { await lifecycle.dispose(); await database.close(); });
  const rows = (table) => database.read((db) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  return { database, repository, time, clock, config, calls, lifecycle, rows, options };
}

test('review scan and lease defaults validate positive safe integers', () => {
  assert.equal(resolveConfig().reviewScanIntervalMs, 600_000);
  assert.equal(resolveConfig().reviewLeaseMs, 300_000);
  for (const name of ['reviewScanIntervalMs', 'reviewLeaseMs']) {
    for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => resolveConfig({ [name]: value }), { code: 'MEMORY_INVALID_CONFIG' });
    }
  }
});

test('short-term review starts at exactly seven days and recycles for seven full days', async (t) => {
  const s = await setup(t);
  const event = await s.repository.insertEvent(eventInput());
  s.time.value = NOW + 7 * DAY - 1;
  assert.deepEqual(await s.lifecycle.runDueReviews(), { queued: 0, completed: 0, retried: 0, failed: 0 });
  s.time.value++;
  assert.deepEqual(await s.lifecycle.runDueReviews(), { queued: 1, completed: 1, retried: 0, failed: 0 });
  assert.equal(s.calls[0].mode, 'short-term');
  assert.deepEqual(Object.keys(s.calls[0].candidates[0]).sort(), ['content', 'id', 'version', 'visibility']);
  assert.equal(s.rows('memory_events')[0].id, event.id);
  assert.equal(s.rows('memory_events')[0].purge_due_at, NOW + 14 * DAY);
  assert.equal(s.rows('review_jobs')[0].state, 'completed');
  assert.equal((await s.lifecycle.runDueReviews()).queued, 0);
});

test('scan groups by kind and conversation, stable time/id batches of at most forty and atomically marks pending', async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 83; i++) await s.repository.insertEvent(eventInput({ sourceKey: `s${i}`,
    occurredAt: NOW - (i % 3), conversationKind: i === 82 ? 'group' : 'private',
    conversationKey: i === 81 ? 'other' : 'same' }));
  s.time.value += 7 * DAY;
  assert.equal((await s.lifecycle.scan()).queued, 5);
  assert.equal((await s.lifecycle.scan()).queued, 0);
  const jobs = s.rows('review_jobs');
  assert.deepEqual(jobs.map((j) => JSON.parse(j.source_ids_json).length).sort((a, b) => a - b), [1, 1, 1, 40, 40]);
  assert.ok(s.rows('memory_events').every((e) => e.state === 'review-pending'));
  for (const job of jobs) {
    const events = JSON.parse(job.source_ids_json).map((id) => s.rows('memory_events').find((e) => e.id === id));
    assert.equal(new Set(events.map((e) => `${e.conversation_kind}:${e.conversation_key}`)).size, 1);
    assert.deepEqual(events.map((e) => e.id), [...events].sort((a, b) => a.occurred_at - b.occurred_at || a.id.localeCompare(b.id, 'en')).map((e) => e.id));
  }
});

for (const conversationKind of ['private', 'group']) test(`retained ${conversationKind} memories use the conversation key and a safe name`, async (t) => {
  const s = await setup(t, { review: async ({ candidates }) => ({ retain: [{ sourceIds: candidates.map((c) => c.id), kind: 'fact',
    content: '长期事实', importance: 0.5 }], diary: [], discard: [] }) });
  await s.repository.insertEvent(eventInput({ conversationKind, conversationKey: 'qq:account-secret', actorName: 'account-secret' }));
  s.time.value += 7 * DAY;
  await s.lifecycle.runDueReviews();
  const item = s.rows('memory_items')[0];
  assert.equal(item.subject_key, 'qq:account-secret');
  assert.doesNotMatch(item.subject_name, /account-secret/);
  assert.equal(item.promoted_at, s.time.value);
  assert.equal(item.expires_at, s.time.value + 30 * DAY);
  assert.doesNotMatch(JSON.stringify(s.calls), /account-secret/);
});

async function retained(s) {
  const event = await s.repository.insertEvent(eventInput());
  await s.database.write((db) => db.prepare(`INSERT INTO review_jobs
    (id, kind, batch_key, source_ids_json, state, due_at, created_at, updated_at)
    VALUES ('seed-job','short-term','seed',?,'queued',?,?,?)`).run(JSON.stringify([event.id]), NOW, NOW, NOW));
  return (await s.repository.promoteEvents({ jobId: 'seed-job', candidates: [{ id: event.id, version: event.version }],
    retain: [{ sourceIds: [event.id], kind: 'fact', subjectKey: 'subject', subjectName: '', content: '长期内容', importance: 0.6 }],
    diary: [], discard: [] })).items[0];
}

test('long-term final review is due thirty days from promotion and diary visibility derives from the item', async (t) => {
  const s = await setup(t, { review: async ({ candidates }) => ({ diary: [{ sourceIds: candidates.map((c) => c.id), title: '日记', body: '永久记录' }], discard: [] }) });
  const item = await retained(s);
  s.time.value = item.promotedAt + 30 * DAY - 1;
  assert.equal((await s.lifecycle.runDueReviews()).queued, 0);
  s.time.value++;
  assert.deepEqual(await s.lifecycle.runDueReviews(), { queued: 1, completed: 1, retried: 0, failed: 0 });
  assert.equal(s.calls[0].mode, 'long-term');
  assert.equal(s.rows('diary_entries')[0].visibility, 'owner-private');
  assert.equal(s.rows('memory_items')[0].state, 'recycle');
  assert.equal(s.rows('memory_items')[0].purge_due_at, s.time.value + 7 * DAY);
  assert.match(s.rows('review_jobs').find((j) => j.kind === 'long-term').batch_key, /^long-term:[a-f0-9]{64}$/);
});

test('long-term scan creates one non-overlapping job per item even while queued, failed or completed', async (t) => {
  const s = await setup(t);
  await retained(s);
  s.time.value += 30 * DAY;
  assert.equal((await s.lifecycle.scan()).queued, 1);
  for (const state of ['queued', 'leased', 'failed', 'completed']) {
    await s.database.write((db) => db.prepare("UPDATE review_jobs SET state=? WHERE kind='long-term'").run(state));
    assert.equal((await s.lifecycle.scan()).queued, 0);
  }
});

for (const kind of ['short-term', 'long-term']) test(`${kind} restored after completion creates a new versioned job and can complete again`, async (t) => {
  const s = await setup(t);
  const original = kind === 'short-term' ? await s.repository.insertEvent(eventInput()) : await retained(s);
  const table = kind === 'short-term' ? 'memory_events' : 'memory_items';
  const dueColumn = kind === 'short-term' ? 'review_due_at' : 'expires_at';
  const originalDue = s.rows(table)[0][dueColumn];
  s.time.value = originalDue;
  assert.equal((await s.lifecycle.runDueReviews()).completed, 1);
  const oldJob = s.rows('review_jobs').find((j) => j.kind === kind);
  assert.equal(oldJob.state, 'completed');
  const recycled = s.rows(table)[0];
  const restored = await s.repository.restoreRecycle({ kind: kind === 'short-term' ? 'event' : 'item', id: original.id, version: recycled.version });
  assert.equal(restored.version, recycled.version + 1);
  assert.equal(s.rows(table)[0][dueColumn], originalDue);
  assert.deepEqual(await s.lifecycle.scan(), { queued: 1 });
  assert.deepEqual(await s.lifecycle.scan(), { queued: 0 });
  const jobs = s.rows('review_jobs').filter((j) => j.kind === kind);
  assert.equal(jobs.length, 2);
  const newJob = jobs.find((j) => j.id !== oldJob.id);
  assert.notEqual(newJob.batch_key, oldJob.batch_key);
  assert.match(newJob.batch_key, new RegExp(`^${kind}:[a-f0-9]{64}$`));
  assert.deepEqual(JSON.parse(newJob.source_ids_json), [original.id]);
  assert.deepEqual(await s.lifecycle.runDueReviews(), { queued: 0, completed: 1, retried: 0, failed: 0 });
  assert.equal(s.rows(table)[0].state, 'recycle');
  assert.equal(s.rows(table)[0].version, restored.version + 1);
  assert.equal(s.rows(table)[0][dueColumn], originalDue);
  assert.equal(s.rows(table)[0].purge_due_at, s.time.value + 7 * DAY);
  assert.ok(s.rows('review_jobs').filter((j) => j.kind === kind).every((j) => j.state === 'completed'));
  assert.equal(s.calls.length, 2);
});

for (const kind of ['short-term', 'long-term']) test(`${kind} scan hashes external IDs and deduplicates the same version in every job state`, async (t) => {
  const s = await setup(t);
  if (kind === 'short-term') await s.repository.insertEvent(eventInput()); else await retained(s);
  const table = kind === 'short-term' ? 'memory_events' : 'memory_items';
  await s.database.write((db) => db.prepare(`UPDATE ${table} SET id=?`).run('qq:account-secret/path?query=1'));
  s.time.value += (kind === 'short-term' ? 7 : 30) * DAY;
  const other = new ReviewLifecycle(s.options); t.after(() => other.dispose());
  const summaries = await Promise.all([s.lifecycle.scan(), other.scan()]);
  assert.equal(summaries.reduce((total, s) => total + s.queued, 0), 1);
  const job = s.rows('review_jobs').find((j) => j.kind === kind);
  assert.match(job.batch_key, new RegExp(`^${kind}:[a-f0-9]{64}$`));
  assert.doesNotMatch(job.batch_key, /account-secret|path|query/);
  for (const state of ['queued', 'leased', 'failed', 'completed']) {
    await s.database.write((db) => {
      db.prepare('UPDATE review_jobs SET state=? WHERE id=?').run(state, job.id);
      db.prepare(`UPDATE ${table} SET state='active'`).run();
    });
    assert.equal((await s.lifecycle.scan()).queued, 0);
    assert.equal(s.rows('review_jobs').filter((j) => j.kind === kind).length, 1);
  }
});

for (const state of ['queued', 'leased', 'failed']) test(`long-term old-version ${state} task ${state === 'failed' ? 'allows' : 'blocks'} a new-version job`, async (t) => {
  const s = await setup(t);
  await retained(s); s.time.value += 30 * DAY;
  assert.equal((await s.lifecycle.scan()).queued, 1);
  const oldJob = s.rows('review_jobs').find((j) => j.kind === 'long-term');
  await s.database.write((db) => {
    db.prepare('UPDATE review_jobs SET state=? WHERE id=?').run(state, oldJob.id);
    db.prepare('UPDATE memory_items SET version=version+1').run();
  });
  assert.equal((await s.lifecycle.scan()).queued, state === 'failed' ? 1 : 0);
  assert.equal((await s.lifecycle.scan()).queued, 0);
  const jobs = s.rows('review_jobs').filter((j) => j.kind === 'long-term');
  assert.equal(jobs.length, state === 'failed' ? 2 : 1);
  assert.equal(jobs.find((j) => j.id === oldJob.id).state, state);
});

for (const state of ['queued', 'leased']) test(`short-term old ${state} job excludes restored events and reloads active latest versions without worker overlap`, async (t) => {
  const entered = deferred(); const unblock = deferred();
  const s = await setup(t, { review: async (input) => { entered.resolve(); await unblock.promise; return discardAll(input); } });
  const other = new ReviewLifecycle(s.options);
  t.after(async () => { unblock.resolve(); await other.dispose(); });
  const event = await s.repository.insertEvent(eventInput()); s.time.value += 7 * DAY;
  await s.lifecycle.scan(); const oldJob = s.rows('review_jobs')[0];
  if (state === 'leased') await s.database.write((db) => db.prepare("UPDATE review_jobs SET state='leased',attempts=1,lease_until=? WHERE id=?")
    .run(s.time.value + s.config.reviewLeaseMs, oldJob.id));
  await s.repository.moveToRecycle({ kind: 'event', id: event.id, version: event.version });
  const restored = await s.repository.restoreRecycle({ kind: 'event', id: event.id, version: event.version + 1 });
  assert.equal(restored.version, 3); assert.equal(restored.state, 'active');
  const scans = await Promise.all([s.lifecycle.scan(), other.scan()]);
  assert.deepEqual(scans, [{ queued: 0 }, { queued: 0 }]);
  assert.equal(s.rows('review_jobs').length, 1);
  if (state === 'leased') {
    assert.deepEqual(await other.runDueReviews(), { queued: 0, completed: 0, retried: 0, failed: 0 });
    assert.equal(s.calls.length, 0); s.time.value += s.config.reviewLeaseMs;
  }
  const running = s.lifecycle.runDueReviews();
  await Promise.race([entered.promise, running.then(() => assert.fail('the old job must load the restored active event'))]);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].candidates[0].version, restored.version);
  assert.equal(s.rows('memory_events')[0].state, 'active');
  assert.deepEqual(await other.runDueReviews(), { queued: 0, completed: 0, retried: 0, failed: 0 });
  assert.equal(s.calls.length, 1); assert.equal(s.rows('review_jobs').length, 1);
  unblock.resolve();
  assert.deepEqual(await running, { queued: 0, completed: 1, retried: 0, failed: 0 });
  assert.equal(s.rows('review_jobs')[0].id, oldJob.id);
  assert.equal(s.rows('review_jobs')[0].state, 'completed');
  assert.equal(s.rows('memory_events')[0].state, 'recycle');
  assert.equal(s.rows('memory_events')[0].version, restored.version + 1);
});

test('short-term old failed job permits a restored new version while retaining the failed audit row', async (t) => {
  const s = await setup(t);
  const event = await s.repository.insertEvent(eventInput()); s.time.value += 7 * DAY;
  await s.lifecycle.scan(); const oldJob = s.rows('review_jobs')[0];
  await s.database.write((db) => db.prepare("UPDATE review_jobs SET state='failed' WHERE id=?").run(oldJob.id));
  await s.repository.moveToRecycle({ kind: 'event', id: event.id, version: event.version });
  await s.repository.restoreRecycle({ kind: 'event', id: event.id, version: event.version + 1 });
  assert.deepEqual(await s.lifecycle.scan(), { queued: 1 });
  assert.deepEqual(await s.lifecycle.scan(), { queued: 0 });
  assert.deepEqual(await s.lifecycle.runDueReviews(), { queued: 0, completed: 1, retried: 0, failed: 0 });
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].candidates[0].version, 3);
  assert.equal(s.rows('review_jobs').find((j) => j.id === oldJob.id).state, 'failed');
  assert.equal(s.rows('review_jobs').length, 2);
});

test('restoring during a leased model call rejects its old snapshot and retries the active latest version in the same job', async (t) => {
  const entered = deferred(); const unblock = deferred();
  const s = await setup(t, { review: async (input) => {
    if (s.calls.length === 1) { entered.resolve(); await unblock.promise; }
    return discardAll(input);
  } });
  const other = new ReviewLifecycle(s.options);
  t.after(async () => { unblock.resolve(); await other.dispose(); });
  const event = await s.repository.insertEvent(eventInput()); s.time.value += 7 * DAY;
  const running = s.lifecycle.runDueReviews(); await entered.promise;
  const oldJob = s.rows('review_jobs')[0];
  await s.repository.moveToRecycle({ kind: 'event', id: event.id, version: 1 });
  await s.repository.restoreRecycle({ kind: 'event', id: event.id, version: 2 });
  assert.deepEqual(await other.runDueReviews(), { queued: 0, completed: 0, retried: 0, failed: 0 });
  assert.equal(s.calls.length, 1);
  unblock.resolve();
  assert.deepEqual(await running, { queued: 1, completed: 0, retried: 1, failed: 0 });
  assert.equal(s.rows('memory_events')[0].state, 'active');
  assert.equal(s.rows('memory_events')[0].version, 3);
  assert.equal(s.rows('review_jobs')[0].last_error_code, 'MEMORY_CONFLICT');
  s.time.value = s.rows('review_jobs')[0].next_attempt_at;
  assert.deepEqual(await other.runDueReviews(), { queued: 0, completed: 1, retried: 0, failed: 0 });
  assert.equal(s.calls.length, 2); assert.equal(s.calls[1].candidates[0].version, 3);
  assert.equal(s.rows('review_jobs').length, 1); assert.equal(s.rows('review_jobs')[0].id, oldJob.id);
  assert.equal(s.rows('memory_events')[0].state, 'recycle');
});

for (const failure of ['model', 'protocol', 'transaction', 'version']) test(`${failure} failure changes only job retry state and reloads candidates on retry`, async (t) => {
  let first = true;
  let s;
  s = await setup(t, { review: async (input) => {
    if (first) {
      first = false;
      if (failure === 'model') throw new Error('body-secret account-secret C:\\secret');
      if (failure === 'protocol') return { retain: [], diary: [], discard: ['foreign'] };
      if (failure === 'version') await s.database.write((db) => db.prepare('UPDATE memory_events SET version=version+1').run());
      if (failure === 'transaction') await s.database.write((db) => db.exec("CREATE TRIGGER deny_recycle BEFORE UPDATE ON memory_events WHEN NEW.state='recycle' BEGIN SELECT RAISE(ABORT,'secret'); END"));
    }
    return discardAll(input);
  } });
  await s.repository.insertEvent(eventInput());
  s.time.value += 7 * DAY;
  assert.deepEqual(await s.lifecycle.runDueReviews(), { queued: 1, completed: 0, retried: 1, failed: 0 });
  const job = s.rows('review_jobs')[0];
  assert.equal(job.attempts, 1);
  assert.equal(job.state, 'queued');
  assert.equal(job.next_attempt_at, s.time.value + 15 * 60_000);
  assert.doesNotMatch(JSON.stringify(job), /secret/);
  assert.equal(s.rows('memory_events')[0].state, 'review-pending');
  assert.equal(s.rows('memory_events')[0].purge_due_at, null);
  assert.equal(s.rows('memory_items').length, 0);
  assert.equal(s.rows('diary_entries').length, 0);
  assert.equal((await s.lifecycle.runDueReviews()).completed, 0);
  if (failure === 'transaction') await s.database.write((db) => db.exec('DROP TRIGGER deny_recycle'));
  s.time.value = job.next_attempt_at;
  assert.equal((await s.lifecycle.runDueReviews()).completed, 1);
  if (failure === 'version') assert.equal(s.calls[1].candidates[0].version, 2);
});

test('retry is exponential and capped; eighth failure leaves data valid and failed job available for manual retry', async (t) => {
  const s = await setup(t, { config: { retryBaseMs: 10, retryMaxMs: 25 }, review: async () => { throw new Error('secret'); } });
  await s.repository.insertEvent(eventInput());
  s.time.value += 7 * DAY;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const now = s.time.value;
    const summary = await s.lifecycle.runDueReviews();
    const job = s.rows('review_jobs')[0];
    assert.equal(job.attempts, attempt);
    assert.equal(job.state, attempt === 8 ? 'failed' : 'queued');
    assert.equal(summary.failed, attempt === 8 ? 1 : 0);
    if (attempt < 8) { assert.equal(job.next_attempt_at - now, Math.min(10 * 2 ** (attempt - 1), 25)); s.time.value = job.next_attempt_at; }
  }
  s.time.value += DAY;
  assert.equal((await s.lifecycle.runDueReviews()).failed, 0);
  assert.equal(s.rows('memory_events')[0].state, 'review-pending');
  assert.equal(s.rows('memory_events')[0].content_text, '我喜欢钓鱼');
});

test('two ticks and two workers cannot concurrently claim a live lease', async (t) => {
  const entered = deferred(); const unblock = deferred();
  const s = await setup(t, { review: async (input) => { entered.resolve(); await unblock.promise; return discardAll(input); } });
  const other = new ReviewLifecycle(s.options);
  t.after(() => other.dispose());
  await s.repository.insertEvent(eventInput()); s.time.value += 7 * DAY;
  const first = s.lifecycle.runDueReviews(); await entered.promise;
  const second = s.lifecycle.runDueReviews();
  assert.equal((await other.runDueReviews()).completed, 0);
  assert.equal(s.calls.length, 1);
  unblock.resolve(); await Promise.all([first, second]);
  assert.equal(s.calls.length, 1);
  assert.equal(s.rows('review_jobs')[0].attempts, 1);
});

test('expired lease can be recovered and old results cannot mutate a still-running new lease', async (t) => {
  const entered = deferred(); const unblock = deferred(); const secondEntered = deferred(); const secondUnblock = deferred();
  const s = await setup(t, { review: async (input) => {
    if (s.calls.length === 1) { entered.resolve(); await unblock.promise; }
    else { secondEntered.resolve(); await secondUnblock.promise; }
    return discardAll(input);
  } });
  const other = new ReviewLifecycle(s.options); t.after(() => other.dispose());
  await s.repository.insertEvent(eventInput()); s.time.value += 7 * DAY;
  const first = s.lifecycle.runDueReviews(); await entered.promise;
  s.time.value += s.config.reviewLeaseMs;
  const second = other.runDueReviews(); await secondEntered.promise;
  unblock.resolve(); await first;
  assert.equal(s.rows('review_jobs')[0].state, 'leased');
  assert.equal(s.rows('memory_events')[0].state, 'review-pending');
  assert.equal(s.rows('memory_events')[0].version, 1);
  secondUnblock.resolve(); assert.equal((await second).completed, 1);
  assert.equal(s.rows('review_jobs')[0].attempts, 2);
  assert.equal(s.rows('review_jobs')[0].state, 'completed');
  assert.equal(s.rows('memory_events')[0].version, 2);
});

test('long-term transaction rollback retains active item, no diary, and retry reloads updated version', async (t) => {
  const s = await setup(t, { review: async ({ candidates }) => ({ diary: [{ sourceIds: candidates.map((c) => c.id), title: '日记', body: '内容' }], discard: [] }) });
  await retained(s); s.time.value += 30 * DAY;
  await s.database.write((db) => db.exec("CREATE TRIGGER deny_item BEFORE UPDATE ON memory_items BEGIN SELECT RAISE(ABORT,'secret'); END"));
  assert.equal((await s.lifecycle.runDueReviews()).retried, 1);
  assert.equal(s.rows('memory_items')[0].state, 'active'); assert.equal(s.rows('diary_entries').length, 0);
  await s.database.write((db) => { db.exec('DROP TRIGGER deny_item'); db.exec('UPDATE memory_items SET version=version+1'); });
  s.time.value = s.rows('review_jobs').find((j) => j.kind === 'long-term').next_attempt_at;
  assert.deepEqual(await s.lifecycle.runDueReviews(), { queued: 0, completed: 1, retried: 0, failed: 0 });
  assert.equal(s.calls[1].candidates[0].version, 2);
});

test('scan rolls back both a new job and pending transitions when the transaction fails', async (t) => {
  const s = await setup(t);
  await s.repository.insertEvent(eventInput()); s.time.value += 7 * DAY;
  await s.database.write((db) => db.exec("CREATE TRIGGER deny_pending BEFORE UPDATE ON memory_events BEGIN SELECT RAISE(ABORT,'body-secret'); END"));
  await assert.rejects(s.lifecycle.scan(), (error) => {
    assert.equal(error.code, 'MEMORY_STORAGE_FAILED');
    assert.doesNotMatch(JSON.stringify(error), /body-secret/); return true;
  });
  assert.equal(s.rows('review_jobs').length, 0);
  assert.equal(s.rows('memory_events')[0].state, 'active');
});

for (const failure of ['model', 'protocol', 'version', 'expiry']) test(`long-term ${failure} failure leaves item active and no diary`, async (t) => {
  let s;
  s = await setup(t, { review: async (input) => {
    if (failure === 'model') throw new Error('body-secret');
    if (failure === 'protocol') return { diary: [], discard: ['foreign'] };
    await s.database.write((db) => db.exec(failure === 'version'
      ? 'UPDATE memory_items SET version=version+1' : `UPDATE memory_items SET expires_at=${s.time.value + 1}`));
    return { diary: [{ sourceIds: input.candidates.map((c) => c.id), title: '日记', body: '内容' }], discard: [] };
  } });
  await retained(s); s.time.value += 30 * DAY;
  assert.equal((await s.lifecycle.runDueReviews()).retried, 1);
  assert.equal(s.rows('memory_items')[0].state, 'active');
  assert.equal(s.rows('memory_items')[0].purge_due_at, null);
  assert.equal(s.rows('diary_entries').length, 0);
});

test('fencing rejects an obsolete attempt even if leaseUntil is unchanged', async (t) => {
  const s = await setup(t);
  const event = await s.repository.insertEvent(eventInput()); s.time.value += 7 * DAY;
  await s.lifecycle.scan();
  const job = s.rows('review_jobs')[0]; const leaseUntil = s.time.value + 1000;
  await s.database.write((db) => db.prepare("UPDATE review_jobs SET state='leased',attempts=2,lease_until=?").run(leaseUntil));
  await assert.rejects(s.repository.promoteEvents({ jobId: job.id, candidates: [{ id: event.id, version: 1 }],
    retain: [], diary: [], discard: [event.id], lease: { attempts: 1, leaseUntil } }), { code: 'MEMORY_CONFLICT' });
  assert.equal(s.rows('review_jobs')[0].state, 'leased');
  assert.equal(s.rows('memory_events')[0].state, 'review-pending');
});

test('expired eighth lease becomes failed without a ninth model call', async (t) => {
  const s = await setup(t);
  await s.repository.insertEvent(eventInput()); s.time.value += 7 * DAY;
  await s.lifecycle.scan();
  await s.database.write((db) => db.prepare("UPDATE review_jobs SET state='leased',attempts=8,lease_until=?").run(s.time.value));
  assert.equal((await s.lifecycle.runDueReviews()).failed, 1);
  assert.equal(s.calls.length, 0);
  assert.equal(s.rows('review_jobs')[0].attempts, 8);
  assert.equal(s.rows('memory_events')[0].state, 'review-pending');
});

test('separate database connections share the same claim fence during hot reload', async (t) => {
  const path = join(createTempHome(), 'shared.sqlite');
  const a = await MemoryDatabase.open(path); const b = await MemoryDatabase.open(path);
  const time = { value: NOW }; const clock = { now: () => time.value }; const config = resolveConfig();
  const entered = deferred(); const unblock = deferred(); let calls = 0;
  const reviewModel = { review: async (input) => { calls++; entered.resolve(); await unblock.promise; return discardAll(input); } };
  const repository = new MemoryRepository({ database: a, config, clock });
  const first = new ReviewLifecycle({ database: a, repository, config, clock, reviewModel });
  const second = new ReviewLifecycle({ database: b, repository: new MemoryRepository({ database: b, config, clock }), config, clock, reviewModel });
  t.after(async () => { unblock.resolve(); await Promise.all([first.dispose(), second.dispose()]); await Promise.all([a.close(), b.close()]); });
  await repository.insertEvent(eventInput()); time.value += 7 * DAY;
  const running = first.runDueReviews(); await entered.promise;
  assert.equal((await second.runDueReviews()).completed, 0); assert.equal(calls, 1);
  unblock.resolve(); assert.equal((await running).completed, 1);
});

test('scheduler performs immediate catch-up, uses one recursive timer and clears it on dispose', async () => {
  let runs = 0; let handle = 0; const timers = new Map(); let disposed = false;
  const scheduler = new ReviewScheduler({ lifecycle: { runDueReviews: async () => { runs++; }, dispose: async () => { disposed = true; } },
    intervalMs: 600_000, timer: { setTimeout: (fn, ms) => { assert.equal(ms, 600_000); timers.set(++handle, fn); return handle; }, clearTimeout: (id) => timers.delete(id) } });
  await scheduler.start(); assert.equal(runs, 1); assert.equal(timers.size, 1);
  const [id, fn] = timers.entries().next().value; timers.delete(id); await fn();
  assert.equal(runs, 2); assert.equal(timers.size, 1);
  await scheduler.dispose(); assert.equal(timers.size, 0); assert.equal(disposed, true);
});

test('dispose aborts a hanging review, requeues its lease and prevents new ticks', async (t) => {
  const entered = deferred(); let signal;
  const s = await setup(t, { review: async (_, options) => { signal = options.signal; entered.resolve(); return new Promise(() => {}); } });
  await s.repository.insertEvent(eventInput()); s.time.value += 7 * DAY;
  const running = s.lifecycle.runDueReviews(); await entered.promise;
  await s.lifecycle.dispose(); await running;
  assert.equal(signal.aborted, true);
  assert.equal(s.rows('review_jobs')[0].state, 'queued');
  assert.equal(s.rows('review_jobs')[0].lease_until, null);
  assert.equal(s.rows('memory_events')[0].state, 'review-pending');
  await assert.rejects(s.lifecycle.runDueReviews(), { code: 'MEMORY_DISPOSED' });
});

test('scheduler recovers from a failed scan and disposal during catch-up never starts a timer', async () => {
  let runs = 0; let timers = 0;
  const running = deferred(); const release = deferred();
  const scheduler = new ReviewScheduler({ lifecycle: {
    runDueReviews: async () => { runs++; running.resolve(); await release.promise; throw new Error('body-secret'); },
    dispose: async () => release.resolve(),
  }, intervalMs: 10, timer: { setTimeout: () => { timers++; }, clearTimeout() {} } });
  const first = scheduler.start(); assert.equal(scheduler.start(), first); await running.promise;
  await scheduler.dispose(); await first;
  assert.equal(runs, 1); assert.equal(timers, 0);
  const callbacks = [];
  const recover = new ReviewScheduler({ lifecycle: { runDueReviews: async () => { throw new Error('secret'); }, dispose: async () => {} },
    intervalMs: 10, timer: { setTimeout: (fn) => { callbacks.push(fn); return callbacks.length; }, clearTimeout() {} } });
  await recover.start(); assert.equal(callbacks.length, 1); await recover.dispose();
});

test('plugin effect starts catch-up for offline due events and manual summaries contain no bodies', async () => {
  const dshHome = createTempHome(); const ctx = createFakeContext();
  const time = { value: NOW }; const clock = { now: () => time.value };
  const timer = { setTimeout: () => 1, clearTimeout: () => {} };
  await apply(ctx, {}, { dshHome, clock, timer, reviewModel: { review: discardAll } });
  let service = ctx.get('dafeiyuMemory');
  await service.recordEvent(eventInput()); await service.dispose();
  time.value += 8 * DAY;
  const next = createFakeContext(); await apply(next, {}, { dshHome, clock, timer, reviewModel: { review: discardAll } });
  service = next.get('dafeiyuMemory');
  await service.scheduler.start();
  assert.equal(service.status().events.recycle, 1);
  assert.deepEqual(await service.runDueReviews(), { queued: 0, completed: 0, retried: 0, failed: 0 });
  await next.disposers[0]();
});
