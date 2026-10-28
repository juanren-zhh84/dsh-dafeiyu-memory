import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeAurabot } from './helpers/fake-aurabot.js';
import { MemoryDatabase } from '../src/storage/database.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { RecallEngine } from '../src/memory/recall.js';
import { createTempHome } from './helpers/temp-home.js';

const moduleUrl = new URL('../aurabot-module/dafeiyu-memory/index.mjs', import.meta.url);
const group = { kind: 'group', chatId: 'group:fixture-room', userId: 'friend-fixture', nickname: '测试成员', text: '普通群消息', messageId: 'fixture-message', raw: { time: 1700000000 }, mentioned: false };
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeAurabot(dir);
  const events = [], recalls = [];
  fake.service = { recordEvent: async (event) => { events.push(event); }, recall: (request) => { recalls.push(request); return '统一记忆'; } };
  const mod = await import(moduleUrl);
  mod.setupConnector(fake.api, { clock: { now: () => 1700000000123 }, ...options });
  t.after(() => fake.dispose());
  return { fake, dir, events, recalls, mod };
}

test('module exists with the public v1 identity', async () => {
  assert.equal(existsSync(moduleUrl), true, 'the versioned user module must exist');
  const { default: mod } = await import(moduleUrl);
  assert.equal(mod.id, 'dafeiyu-memory'); assert.equal(mod.api, 1); assert.equal(mod.version, '0.1.0');
});

test('every permitted group message is recorded without takeover or duplicate inbound activity', async (t) => {
  const { fake, events } = await fixture(t);
  assert.equal(await fake.emit('message', group), false);
  fake.emit('activity', { ...group, kind: 'in' }); await fake.tick();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { source: 'qq', sourceKey: 'fixture-message', conversationKind: 'group', conversationKey: group.chatId, actorKey: 'qq:friend-fixture', actorName: '测试成员', direction: 'incoming', contentText: group.text, occurredAt: 1700000000000, visibility: 'group' });
  assert.ok(Object.isFrozen(events[0]));
});

test('message returns false synchronously even while memory service is waiting', async (t) => {
  const { fake } = await fixture(t);
  let release;
  fake.service.recordEvent = () => new Promise((resolve) => { release = resolve; });
  const result = fake.emit('message', group);
  await new Promise(setImmediate); release(); await fake.tick();
  assert.equal(result, false);
});

test('sync contexts use current service, latest text, and owner/private/group/unknown boundaries', async (t) => {
  const { fake, recalls } = await fixture(t);
  await fake.emit('message', group);
  for (const [chat, audience] of [[{ ...group }, 'qq-group'], [{ kind: 'private', chatId: 'private:owner-fixture', userId: 'owner-fixture' }, 'owner'], [{ kind: 'private', chatId: 'private:friend-fixture', userId: 'friend-fixture' }, 'qq-private'], [{ kind: 'private', chatId: 'private:unknown-fixture' }, 'qq-private']]) {
    assert.equal(fake.context(chat), '统一记忆'); assert.equal(recalls.at(-1).audience, audience);
  }
  assert.equal(recalls[0].queryText, group.text);
  assert.equal(fake.context({ kind: 'system', chatId: 'system:fixture' }), '');
  assert.ok(fake.gets.every((args) => args[0] === 'dafeiyuMemory' && args[1] === false));
  fake.service = { recall: () => '已恢复服务' }; assert.equal(fake.context(group), '已恢复服务');
  fake.service = { recall: () => { throw new Error('正文和账号不得记录'); } }; assert.equal(fake.context(group), '');
  fake.api.isOwner = () => { throw new Error('unknown'); };
  fake.service = { recall: (r) => { assert.equal(r.audience, 'qq-private'); return ''; } };
  assert.equal(fake.context({ kind: 'private', chatId: 'private:owner-fixture', userId: 'owner-fixture' }), '');
});

test('private events protect owners, preserve media placeholders and safely fall back from bad timestamps', async (t) => {
  const { fake, events } = await fixture(t);
  for (const userId of ['owner-fixture', 'friend-fixture', undefined]) {
    await fake.emit('message', { ...group, kind: 'private', chatId: `private:${userId ?? 'unknown-fixture'}`, userId, text: '[图片]', messageId: undefined, raw: { time: Number.MAX_SAFE_INTEGER } });
  }
  await fake.tick();
  assert.deepEqual(events.map((e) => e.visibility), ['owner-private', 'conversation', 'conversation']);
  assert.ok(events.every((e) => e.contentText === '[图片]' && e.occurredAt === 1700000000123 && !Object.hasOwn(e, 'sourceKey')));
});

test('real core with fake Aurabot synchronously recalls both sides of one private chat while excluding other actors and owner-private replies', async (t) => {
  const dir = createTempHome(), clock = { now: () => 1700000000123 };
  const database = await MemoryDatabase.open(join(dir, 'memory.sqlite'));
  const repository = new MemoryRepository({ database, clock });
  const engine = new RecallEngine({ database, clock });
  const fake = fakeAurabot(join(dir, 'module-data'));
  fake.service = { recordEvent: (event) => repository.insertEvent(event), recall: (req) => engine.recall(req).text };
  const { setupConnector } = await import(moduleUrl);
  setupConnector(fake.api, { clock });
  t.after(async () => { fake.dispose(); await database.close(); });
  const current = { kind: 'private', chatId: 'private:friend-fixture', userId: 'friend-fixture' };
  for (const [userId, incoming, outgoing] of [
    ['friend-fixture', '当前联系人入站', '当前助手回复'],
    ['other-fixture', '其他联系人入站', '其他联系人助手回复'],
    ['owner-fixture', '主人私密入站', '主人私密助手回复'],
  ]) {
    assert.equal(fake.emit('message', { ...group, kind: 'private', chatId: `private:${userId}`, userId, text: incoming, messageId: `message:${userId}` }), false);
    await fake.send(`private:${userId}`, outgoing);
  }
  await fake.tick();
  const base = { source: 'qq', conversationKind: 'private', conversationKey: current.chatId,
    actorKey: 'qq:other-fixture', actorName: '测试联系人', direction: 'incoming',
    contentText: '同会话伪造其他来信', occurredAt: clock.now(), visibility: 'conversation' };
  await repository.insertEvent({ ...base, sourceKey: 'spoofed-incoming' });
  await repository.insertEvent({ ...base, sourceKey: 'protected-reply', actorKey: 'qq:bot', direction: 'outgoing', contentText: '同会话主人私密回复', visibility: 'owner-private' });
  const replyActors = database.read((db) => db.prepare("SELECT actor_key FROM memory_events WHERE direction = 'outgoing'").all());
  assert.ok(replyActors.every((row) => row.actor_key === 'qq:bot'));
  const context = fake.context(current);
  assert.equal(typeof context, 'string');
  assert.match(context, /当前联系人入站/);
  assert.match(context, /当前助手回复/);
  assert.doesNotMatch(context, /其他联系人|主人私密|伪造/);
  assert.deepEqual(fake.warnings, []);
  await fake.tick();
});

test('empty or whitespace-only input records a placeholder without inspecting media arrays', async (t) => {
  const { fake, events } = await fixture(t);
  for (const content of ['', ' \n\t ']) {
    const message = { ...group, text: content };
    Object.defineProperty(message, 'images', { get() { throw new Error('must not read media'); } });
    assert.equal(fake.emit('message', message), false);
  }
  await fake.tick();
  assert.equal(events.length, 2); assert.ok(events.every((e) => e.contentText === '[空消息]'));
});

test('successful outbound sends freeze unique same-millisecond keys and spool exact DTOs across recovery', async (t) => {
  const { fake, dir, events } = await fixture(t);
  fake.service = undefined;
  await fake.send(group.chatId, '重复回复'); await fake.send(group.chatId, '重复回复'); await fake.tick();
  const pending = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(pending.length, 2); assert.notEqual(pending[0].sourceKey, pending[1].sourceKey);
  assert.ok(pending.every((e) => e.contentText === '重复回复' && e.actorKey === 'qq:bot' && e.direction === 'outgoing'));
  fake.service = { recordEvent: async (e) => { events.push(e); return { deduplicated: true, purged: true }; }, recall: () => '' };
  assert.equal(fake.context(group), ''); await fake.tick();
  assert.deepEqual(events, pending); assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), '');
  assert.equal(fake.period, 30000);
});

test('record failures spool immutable snapshots, warning codes are throttled and corrupt rows reveal no content', async (t) => {
  const { fake, dir, events } = await fixture(t);
  fake.service.recordEvent = async () => { throw new Error('敏感正文、账号、路径'); };
  const msg = { ...group }; const result = fake.emit('message', msg); msg.text = '不应持久化';
  assert.equal(await result, false);
  await fake.tick();
  assert.equal(JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8')).contentText, group.text);
  writeFileSync(join(dir, 'events.jsonl'), '秘密坏行\n' + readFileSync(join(dir, 'events.jsonl'), 'utf8'));
  fake.service = { recordEvent: async (e) => events.push(e) }; await fake.tick();
  assert.equal(events.length, 1); assert.ok(fake.warnings.length <= 1);
  assert.ok(fake.warnings.flat().every((v) => typeof v === 'number' || /^[A-Z_]+$/.test(v)));
});

test('spool refuses new entries at 5000 records or 4 MiB without replacing old data', async (t) => {
  for (const contents of ['{}\n'.repeat(5000), 'x'.repeat(4 * 1024 * 1024)]) {
    const { fake, dir } = await fixture(t); fake.service = undefined;
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'events.jsonl'), contents);
    assert.equal(await fake.emit('message', group), false);
    await fake.tick();
    assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), contents);
  }
});

test('dispose unregisters listeners and stops queued drain and disk writes after an in-flight failure', async (t) => {
  const { fake, dir } = await fixture(t);
  let reject; fake.service.recordEvent = () => new Promise((_, no) => { reject = no; });
  const pending = fake.emit('message', group);
  await new Promise(setImmediate); fake.dispose(); reject(new Error('failure'));
  assert.equal(await pending, false); await new Promise(setImmediate); await fake.tick(); fake.emit('message', group);
  assert.equal(fake.listenerCount, 0); assert.equal(existsSync(join(dir, 'events.jsonl')), false);
});

test('an unreadable old spool cannot prevent a fresh event reaching a healthy service', async (t) => {
  const { fake, dir, events } = await fixture(t);
  mkdirSync(join(dir, 'events.jsonl'));
  assert.equal(await fake.emit('message', group), false);
  await fake.tick();
  assert.equal(events.length, 1);
});

test('recovery retries serially with original keys and retains an interrupted batch after dispose', async (t) => {
  const { fake, dir, events } = await fixture(t);
  fake.service = undefined;
  await fake.emit('message', group);
  await fake.emit('message', { ...group, messageId: 'second-fixture' });
  await fake.tick();
  let release, calls = 0;
  fake.service = { recordEvent: (e) => { calls++; events.push(e); return new Promise((resolve) => { release = resolve; }); } };
  const draining = fake.tick(); await new Promise(setImmediate);
  assert.equal(calls, 1); fake.dispose(); release(); await draining;
  assert.equal(calls, 1);
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('spool bytes include the newline needed after a truncated last row', async (t) => {
  const { fake, dir } = await fixture(t); fake.service = undefined;
  await fake.emit('message', group);
  await fake.tick();
  const line = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  const contents = 'x'.repeat(4 * 1024 * 1024 - Buffer.byteLength(line));
  writeFileSync(join(dir, 'events.jsonl'), contents);
  await fake.emit('message', group);
  await fake.tick();
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), contents);
});

test('corrupt spool rows report only their line number and stable code; warnings reopen after five minutes', async (t) => {
  let now = 1700000000123;
  const { fake, dir } = await fixture(t, { clock: { now: () => now } });
  writeFileSync(join(dir, 'events.jsonl'), '敏感坏正文\n');
  await fake.tick();
  assert.deepEqual(fake.warnings, [['MEMORY_SPOOL_INVALID_ROW', 1]]);
  fake.service = undefined;
  await fake.emit('message', group); await fake.tick();
  assert.equal(fake.warnings.length, 1);
  now += 300000;
  await fake.emit('message', group); await fake.tick();
  assert.deepEqual(fake.warnings[1], ['MEMORY_SERVICE_UNAVAILABLE']);
});

test('installer copies only module files, backs up replacement and rejects a link escaping temporary DshHome', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-install-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = new URL('../scripts/install-aurabot-module.ps1', import.meta.url);
  assert.equal(existsSync(script), true, 'safe installer must exist');
  const run = () => spawnSync('pwsh', ['-NoProfile', '-File', fileURLToPath(script), '-DshHome', dir], { encoding: 'utf8' });
  assert.equal(run().status, 0); const target = join(dir, 'plugins-data/aurabot/modules/dafeiyu-memory');
  assert.equal(readFileSync(join(target, 'index.mjs'), 'utf8').includes("id: 'dafeiyu-memory'"), true);
  writeFileSync(join(target, 'old-fixture.txt'), 'old'); assert.equal(run().status, 0);
  assert.equal(existsSync(join(target, 'old-fixture.txt')), false);
  assert.deepEqual(readdirSync(target).sort(), ['index.mjs', 'spool.mjs']);
  const backups = readdirSync(join(dir, 'plugins-data/aurabot')).filter((name) => name.startsWith('dafeiyu-memory-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, 'plugins-data/aurabot', backups[0], 'old-fixture.txt'), 'utf8'), 'old');
  const linkHome = join(dir, 'linked-home'); mkdirSync(linkHome);
  const linked = spawnSync('pwsh', ['-NoProfile', '-Command', `New-Item -ItemType Junction -Path '${linkHome}/plugins-data' -Target '${dir}/plugins-data' | Out-Null`], { encoding: 'utf8' });
  assert.equal(linked.status, 0);
  const rejected = spawnSync('pwsh', ['-NoProfile', '-File', fileURLToPath(script), '-DshHome', linkHome], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /INSTALL_LINK_REJECTED/);
  rmSync(join(linkHome, 'plugins-data'));
  mkdirSync(join(dir, 'missing-fixture'));
  const dangling = spawnSync('pwsh', ['-NoProfile', '-Command', `New-Item -ItemType Junction -Path '${linkHome}/plugins-data' -Target '${dir}/missing-fixture' | Out-Null`], { encoding: 'utf8' });
  assert.equal(dangling.status, 0);
  rmdirSync(join(dir, 'missing-fixture'));
  const danglingResult = spawnSync('pwsh', ['-NoProfile', '-File', fileURLToPath(script), '-DshHome', linkHome], { encoding: 'utf8' });
  assert.notEqual(danglingResult.status, 0);
  assert.match(danglingResult.stderr, /INSTALL_LINK_REJECTED/);
});
