import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { MemoryDatabase } from '../src/storage/database.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { createTempHome } from './helpers/temp-home.js';
import { eventInput, NOW, DAY } from './fixtures/events.js';
import { apply } from '../src/index.js';
import { createFakeContext } from './helpers/fake-context.js';
import { allowsMemory, candidateScope } from '../src/memory/privacy.js';

const { RecallEngine } = await import('../src/memory/recall.js').catch((error) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const { tokenize } = await import('../src/memory/tokenize.js').catch((error) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const request = (overrides = {}) => ({ audience: 'owner', queryText: '', now: NOW,
  conversationKind: 'private', conversationKey: 'qq:friend-12345', actorKey: 'friend-12345', ...overrides });

async function setup(t) {
  assert.equal(typeof RecallEngine, 'function', 'RecallEngine must provide synchronous privacy-scoped retrieval');
  const database = await MemoryDatabase.open(join(createTempHome(), 'recall.sqlite'));
  t.after(() => database.close());
  let nextId = 0;
  const repository = new MemoryRepository({ database, clock: { now: () => NOW }, idGenerator: () => `internal-${++nextId}` });
  const engine = new RecallEngine({ database, clock: { now: () => NOW } });
  const event = async (id, overrides = {}) => repository.insertEvent(eventInput({ sourceKey: id,
    conversationKey: 'qq:friend-12345', actorKey: 'friend-12345', visibility: 'conversation', contentText: id, ...overrides }));
  const item = async (id, overrides = {}) => database.write((db) => {
    const row = { id, subject_key: 'friend-12345', content: id, visibility: 'conversation',
      importance: 0, promoted_at: NOW, expires_at: NOW + DAY, state: 'active', ...overrides };
    db.prepare(`INSERT INTO memory_items (id, kind, subject_key, subject_name, content, importance, confidence,
      visibility, promoted_at, expires_at, state, source_refs_json) VALUES (?, 'fact', ?, '', ?, ?, 1, ?, ?, ?, ?, '[]')`)
      .run(row.id, row.subject_key, row.content, row.importance, row.visibility, row.promoted_at, row.expires_at, row.state);
  });
  const diary = (title, body = title, visibility = 'public') => repository.appendDiary({ title, body, visibility });
  return { database, engine, repository, event, item, diary };
}
const contents = (result, layer) => result[layer].map((row) => row.contentText ?? row.content ?? row.title);

test('tokenization uses Chinese adjacent bigrams, singleton Han and lowercase alphanumeric words', () => {
  assert.equal(typeof tokenize, 'function', 'tokenize must implement Chinese retrieval tokens');
  assert.deepEqual(tokenize('  我爱钓鱼\n ＦＩＳＨ 42\t鱼 '), ['我爱', '爱钓', '钓鱼', 'fish', '42', '鱼']);
  assert.deepEqual(tokenize(' \n\t '), []);
});

test('owner and pet retrieve allowed cross-platform content, review-pending and permanent diary', async (t) => {
  const c = await setup(t);
  const pending = await c.event('桌宠私聊', { source: 'pet', conversationKind: 'pet', conversationKey: 'pet:secret', actorKey: 'owner-secret', visibility: 'owner-private' });
  await c.database.write((db) => db.prepare("UPDATE memory_events SET state = 'review-pending' WHERE id = ?").run(pending.id));
  await c.event('他人私聊', { conversationKey: 'qq:other-67890', actorKey: 'other-67890', visibility: 'owner-private' });
  await c.item('长期隐私', { visibility: 'owner-private' });
  await c.diary('永久日记', '完整私密正文', 'owner-private');
  for (const audience of ['owner', 'pet']) {
    const result = c.engine.recall(request({ audience, now: NOW + 100 * DAY }));
    assert.ok(!(result instanceof Promise));
    assert.deepEqual(new Set(contents(result, 'short')), new Set(['桌宠私聊', '他人私聊']));
    assert.deepEqual(contents(result, 'long'), ['长期隐私']);
    assert.equal(result.diary[0].body, '完整私密正文');
  }
});

test('ordinary private audience only receives its conversation and actor plus public memories', async (t) => {
  const c = await setup(t);
  await c.event('自己的会话');
  await c.event('公开事件', { visibility: 'public', conversationKey: 'qq:other-67890', actorKey: 'other-67890' });
  await c.event('同会话他人', { actorKey: 'other-67890' });
  await c.event('主人私聊', { visibility: 'owner-private' });
  await c.event('其他会话', { conversationKey: 'qq:other-67890' });
  await c.item('自己的长期');
  await c.item('其他长期', { subject_key: 'other-67890' });
  await c.item('公开长期', { subject_key: 'other-67890', visibility: 'public' });
  await c.item('私密长期', { visibility: 'owner-private' });
  await c.diary('私密日记', '秘密', 'owner-private');
  await c.diary('公开日记', '摘要');
  const result = c.engine.recall(request({ audience: 'qq-private' }));
  assert.deepEqual(new Set(contents(result, 'short')), new Set(['自己的会话', '公开事件']));
  assert.deepEqual(new Set(contents(result, 'long')), new Set(['自己的长期', '公开长期']));
  assert.deepEqual(contents(result, 'diary'), ['公开日记']);
  assert.doesNotMatch(JSON.stringify(result), /friend-12345|other-67890|qq:|internal-|actorKey|subjectKey|sourceRefs/);
});

test('private SQL candidates and independent DTO check admit same-conversation bot replies and reject foreign or owner-private traffic', async (t) => {
  const c = await setup(t);
  const cases = [
    ['联系人入站', {}, true],
    ['当前助手出站', { direction: 'outgoing', actorKey: 'qq:bot' }, true],
    ['其他联系人入站', { actorKey: 'other-fixture' }, false],
    ['其他会话助手出站', { direction: 'outgoing', actorKey: 'qq:bot', conversationKey: 'private:other-fixture' }, false],
    ['同会话主人隐私出站', { direction: 'outgoing', actorKey: 'qq:bot', visibility: 'owner-private' }, false],
    ['其他主人会话出站', { direction: 'outgoing', actorKey: 'qq:bot', visibility: 'owner-private', conversationKey: 'private:owner-fixture' }, false],
    ['伪装私聊的群出站', { direction: 'outgoing', actorKey: 'qq:bot', conversationKind: 'group' }, false],
    ['公开事件仍可见', { visibility: 'public', conversationKey: 'private:other-fixture', actorKey: 'other-fixture' }, true],
  ];
  for (const [content, overrides] of cases) await c.event(content, overrides);
  const req = request({ audience: 'qq-private' });
  const scope = candidateScope('short', req);
  const selected = c.database.read((db) => new Set(db.prepare(`SELECT content_text FROM memory_events WHERE ${scope.sql}`).all(...scope.params).map((r) => r.content_text)));
  const rows = c.database.read((db) => db.prepare('SELECT * FROM memory_events').all());
  for (const [content, , allowed] of cases) {
    assert.equal(selected.has(content), allowed, `SQL: ${content}`);
    assert.equal(allowsMemory('short', rows.find((r) => r.content_text === content), req), allowed, `DTO: ${content}`);
  }
  assert.deepEqual(new Set(contents(c.engine.recall(req), 'short')), new Set(cases.filter(([, , allowed]) => allowed).map(([content]) => content)));
});

test('group audience only receives current group events, scoped long-term and public diary summaries', async (t) => {
  const c = await setup(t);
  await c.event('当前群', { conversationKind: 'group', conversationKey: 'qq:group-10000', visibility: 'group' });
  await c.event('其他公开群', { conversationKind: 'group', conversationKey: 'qq:group-20000', visibility: 'public' });
  await c.event('主人私聊', { visibility: 'owner-private' });
  await c.item('群长期', { subject_key: 'qq:group-10000', visibility: 'group' });
  await c.item('群会话长期', { subject_key: 'qq:group-10000', visibility: 'conversation' });
  await c.item('其他群长期', { subject_key: 'qq:group-20000', visibility: 'group' });
  await c.item('公开长期', { visibility: 'public' });
  await c.item('私密行为事实', { subject_key: 'qq:group-10000', visibility: 'owner-private', content: '不讨论主人的安排：周五去医院' });
  await c.diary('公开日记', '摘'.repeat(220));
  await c.diary('私密日记', '秘密', 'owner-private');
  const result = c.engine.recall(request({ audience: 'qq-group', conversationKind: 'group', conversationKey: 'qq:group-10000' }));
  assert.deepEqual(contents(result, 'short'), ['当前群']);
  assert.deepEqual(new Set(contents(result, 'long')), new Set(['群长期', '群会话长期', '公开长期']));
  assert.equal(result.diary[0].summary, '摘'.repeat(200));
  assert.equal(Object.hasOwn(result.diary[0], 'body'), false);
  assert.doesNotMatch(JSON.stringify(result), /group-10000|group-20000|friend-12345|internal-|秘密|医院|摘{201}/);
});

test('missing, unknown, inherited and accessor request fields fail closed without invoking accessors', async (t) => {
  const c = await setup(t);
  await c.event('秘密');
  let reads = 0;
  const accessor = Object.defineProperty({}, 'audience', { get() { reads++; return 'owner'; } });
  for (const input of [undefined, {}, { audience: 'OWNER' }, { audience: 'toString' }, Object.create(request()), accessor]) {
    assert.deepEqual(c.engine.recall(input), { short: [], long: [], diary: [], text: '' });
  }
  assert.equal(reads, 0);
  assert.equal(c.engine.recall(request({ audience: 'qq-private', conversationKey: undefined })).short.length, 0);
  assert.equal(c.engine.recall(request({ audience: 'qq-group', conversationKind: 'private' })).short.length, 0);
});

test('each memory layer has its own quota and recycle is excluded', async (t) => {
  const c = await setup(t);
  for (let i = 0; i < 12; i++) await c.event(`短期${i}`);
  const recycled = await c.event('回收短期');
  await c.repository.moveToRecycle({ kind: 'event', id: recycled.id });
  for (let i = 0; i < 9; i++) await c.item(`长期${i}`);
  await c.item('回收长期', { state: 'recycle' });
  for (let i = 0; i < 5; i++) await c.diary(`日记${i}`);
  const result = c.engine.recall(request());
  assert.deepEqual([result.short.length, result.long.length, result.diary.length], [8, 6, 3]);
  assert.doesNotMatch(result.text, /回收/);
});

test('ranking orders exact scope, text relevance, importance, recency and stable id lexicographically', async (t) => {
  const c = await setup(t);
  await c.item('a-stable', { content: '钓鱼', importance: 0.3 });
  await c.item('b-stable', { content: '钓鱼', importance: 0.3 });
  await c.item('older', { content: '钓鱼', importance: 0.3, promoted_at: NOW - DAY });
  await c.item('important', { content: '钓鱼', importance: 0.9, promoted_at: NOW - 2 * DAY });
  await c.item('relevant', { content: '我爱钓鱼', importance: 0 });
  await c.item('exact', { content: '完全无关', subject_key: 'friend-12345' });
  await c.database.write((db) => db.prepare("UPDATE memory_items SET subject_key = 'someone-else' WHERE id <> 'exact'").run());
  assert.deepEqual(contents(c.engine.recall(request({ queryText: '我爱钓鱼' })), 'long'), ['完全无关', '我爱钓鱼', '钓鱼', '钓鱼', '钓鱼', '钓鱼']);
  const result = c.engine.recall(request({ queryText: '我爱钓鱼' }));
  assert.deepEqual(result.long.map(({ content, importance, promotedAt }) => [content, importance, promotedAt]), [
    ['完全无关', 0, NOW], ['我爱钓鱼', 0, NOW], ['钓鱼', 0.9, NOW - 2 * DAY],
    ['钓鱼', 0.3, NOW], ['钓鱼', 0.3, NOW], ['钓鱼', 0.3, NOW - DAY],
  ]);
});

test('blank queries still retrieve recent content and render no internal keys', async (t) => {
  const c = await setup(t);
  await c.event('较早', { occurredAt: NOW - DAY });
  await c.event('最近', { occurredAt: NOW });
  await c.diary('公开标题', '长'.repeat(250));
  const result = c.engine.recall(request({ queryText: ' \n ' }));
  assert.deepEqual(contents(result, 'short'), ['最近', '较早']);
  assert.doesNotMatch(result.text, /internal-|friend-12345|qq:|source_key/);
  assert.match(result.text, /长{250}/);
  const external = c.engine.recall(request({ audience: 'qq-private' }));
  assert.doesNotMatch(external.text, /长{201}/);
});

test('public service returns only projection text synchronously', async (t) => {
  const ctx = createFakeContext();
  await apply(ctx, {}, { dshHome: createTempHome() });
  const service = ctx.get('dafeiyuMemory');
  t.after(() => service.dispose());
  await service.recordEvent(eventInput({ contentText: '公开服务内容' }));
  const result = service.recall(request());
  assert.equal(typeof result, 'string');
  assert.match(result, /公开服务内容/);
});

test('recall statistics queue once per UTC day without changing this result or expiration', async (t) => {
  const c = await setup(t);
  await c.item('counted', { subject_key: 'someone-else', content: '统计内容' });
  const before = c.database.read((db) => db.prepare("SELECT expires_at FROM memory_items WHERE id = 'counted'").get().expires_at);
  let release;
  const blocked = c.database.writeQueue.enqueue(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const first = c.engine.recall(request());
  c.engine.recall(request({ now: NOW + 1 }));
  assert.equal(first.long.length, 1);
  assert.equal(c.database.read((db) => db.prepare('SELECT count(*) AS count FROM memory_recall_days').get().count), 0);
  release();
  await blocked;
  await c.database.writeQueue.drain();
  assert.equal(c.database.read((db) => db.prepare('SELECT count(*) AS count FROM memory_recall_days').get().count), 1);
  c.engine.recall(request({ now: NOW + DAY }));
  await c.database.writeQueue.drain();
  assert.deepEqual(c.database.read((db) => db.prepare('SELECT recalled_day FROM memory_recall_days ORDER BY recalled_day').all()).map(({ recalled_day }) => recalled_day), [Math.floor(NOW / DAY), Math.floor(NOW / DAY) + 1]);
  assert.equal(c.database.read((db) => db.prepare("SELECT expires_at FROM memory_items WHERE id = 'counted'").get().expires_at), before);
  assert.equal(first.long[0].content, '统计内容');
});

test('distinct recall dates break equal recency after importance but before stable id', async (t) => {
  const c = await setup(t);
  await c.item('a', { content: '稳定先' });
  await c.item('z', { content: '已召回' });
  await c.database.write((db) => {
    db.prepare('INSERT INTO memory_recall_days VALUES (?, ?, ?)').run('item', 'z', Math.floor(NOW / DAY) - 1);
  });
  assert.deepEqual(contents(c.engine.recall(request()), 'long'), ['已召回', '稳定先']);
});

test('statistics discard writes for records recycled before their queued execution', async (t) => {
  const c = await setup(t);
  const event = await c.event('将被回收');
  const recycling = c.repository.moveToRecycle({ kind: 'event', id: event.id });
  assert.equal(c.engine.recall(request()).short.length, 1);
  await recycling;
  await c.database.writeQueue.drain();
  assert.equal(c.database.read((db) => db.prepare('SELECT count(*) AS count FROM memory_recall_days').get().count), 0);
});

test('failed or closed statistics queues cannot throw or reject the synchronous recall', async (t) => {
  const c = await setup(t);
  await c.event('失败仍返回');
  c.engine.writeQueue = { enqueue() { throw new Error('secret body'); } };
  assert.equal(c.engine.recall(request()).short.length, 1);
  c.engine.writeQueue = { enqueue() { return Promise.reject(new Error('secret body')); } };
  assert.equal(c.engine.recall(request()).short.length, 1);
  await Promise.resolve();
  await c.database.writeQueue.close();
  c.engine.writeQueue = c.database.writeQueue;
  assert.equal(c.engine.recall(request()).short.length, 1);
});

test('allowed text retains numeric facts and email content while output metadata is excluded', async (t) => {
  const c = await setup(t);
  const body = '公开联系方式 test@example.com，已完成 123456789 次计数';
  await c.event(body);
  await c.item('long-private-id', { content: body });
  await c.diary('公开标题', body);
  const result = c.engine.recall(request({ audience: 'qq-private' }));
  assert.equal(result.short[0].contentText, body);
  assert.equal(result.long[0].content, body);
  assert.equal(result.diary[0].summary, body);
  assert.doesNotMatch(JSON.stringify(result), /friend-12345|internal-|long-private-id|actorKey|conversationKey|sourceRefs/);
});

test('post-query filtering rejects out-of-scope records even if a candidate source over-returns', async (t) => {
  const c = await setup(t);
  await c.event('本群', { conversationKind: 'group', conversationKey: 'qq:group-10000', visibility: 'group' });
  await c.event('其他私聊', { visibility: 'owner-private' });
  const realDatabase = c.database;
  const queries = [];
  c.engine.database = {
    read(callback) { return realDatabase.read((db) => callback({ prepare(sql) {
      queries.push(sql);
      if (sql.includes('FROM memory_events AS m')) return { all() { return db.prepare('SELECT * FROM memory_events').all(); } };
      return db.prepare(sql);
    } })); },
    transaction: (callback) => realDatabase.transaction(callback),
  };
  const result = c.engine.recall(request({ audience: 'qq-group', conversationKind: 'group', conversationKey: 'qq:group-10000' }));
  assert.deepEqual(contents(result, 'short'), ['本群']);
  assert.ok(queries.some((sql) => sql.includes("conversation_kind = 'group' AND conversation_key = ?")));
  assert.ok(queries.every((sql) => !sql.includes('group-10000')));
});

test('stable IDs decide true ties independently of database insertion order', async (t) => {
  const c = await setup(t);
  await c.item('z-last', { content: '钓鱼乙' });
  await c.item('a-first', { content: '钓鱼甲' });
  assert.deepEqual(contents(c.engine.recall(request({ queryText: '钓鱼' })), 'long'), ['钓鱼甲', '钓鱼乙']);
});

test('public diary summaries count Unicode characters and hidden tails never affect external ranking', async (t) => {
  const c = await setup(t);
  await c.diary('第一篇', '鱼'.repeat(200) + '另一个尾部');
  await c.diary('第二篇', '鱼'.repeat(200) + '隐藏关键');
  const external = c.engine.recall(request({ audience: 'qq-private', queryText: '隐藏关键' }));
  assert.deepEqual(contents(external, 'diary'), ['第一篇', '第二篇']);
  assert.deepEqual(contents(c.engine.recall(request({ queryText: '隐藏关键' })), 'diary'), ['第二篇', '第一篇']);
  assert.equal(external.diary[0].summary.length, 200);
  assert.equal(external.diary[1].summary.length, 200);
  await c.diary('表情', '🐟'.repeat(201));
  const projected = c.engine.recall(request({ audience: 'qq-private', queryText: '表情' })).diary[0];
  assert.equal([...projected.summary].length, 200);
  assert.ok(!projected.summary.includes('\ufffd'));
});


test('statistics use the UTC midnight boundary and only count the quota-selected records', async (t) => {
  const c = await setup(t);
  for (let i = 0; i < 10; i++) await c.event(`事件${i}`);
  const midnight = Math.floor(NOW / DAY) * DAY;
  c.engine.recall(request({ now: midnight - 1 }));
  c.engine.recall(request({ now: midnight }));
  await c.database.writeQueue.drain();
  const days = c.database.read((db) => db.prepare('SELECT recalled_day, count(*) AS count FROM memory_recall_days GROUP BY recalled_day ORDER BY recalled_day').all());
  assert.deepEqual(days.map(({ recalled_day, count }) => [recalled_day, count]), [[midnight / DAY - 1, 8], [midnight / DAY, 8]]);
});

test('a real statistics transaction failure is silently discarded while content stays available', async (t) => {
  const c = await setup(t);
  await c.event('数据库统计失败仍可召回');
  await c.database.write((db) => db.exec("CREATE TRIGGER reject_statistics BEFORE INSERT ON memory_recall_days BEGIN SELECT RAISE(ABORT, 'private-body'); END"));
  assert.equal(c.engine.recall(request()).short[0].contentText, '数据库统计失败仍可召回');
  await c.database.writeQueue.drain();
  assert.equal(c.database.read((db) => db.prepare('SELECT count(*) AS count FROM memory_recall_days').get().count), 0);
  assert.equal(c.engine.recall(request()).short.length, 1);
});

test('prototype pollution cannot turn a missing audience into owner access', async (t) => {
  const c = await setup(t);
  await c.event('禁止隐式主人访问');
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'audience');
  let result;
  try {
    Object.defineProperty(Object.prototype, 'audience', { value: 'owner', configurable: true });
    result = c.engine.recall({});
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'audience', original);
    else delete Object.prototype.audience;
  }
  assert.deepEqual(result, { short: [], long: [], diary: [], text: '' });
});
