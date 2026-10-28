import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setupConnector } from '../aurabot-module/dafeiyu-memory/index.mjs';

// Import the installed host read-only; all its writers are redirected before import.
const home = mkdtempSync(join(tmpdir(), 'aurabot-host-boundaries-'));
process.env.DSH_HOME = home;
process.env.AURABOT_DATA_DIR = join(home, 'host-data');
process.env.AURABOT_WORKSPACE = join(home, 'workspace');
const root = process.env.AURABOT_TEST_ROOT || join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-aurabot-qq');
const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
assert.ok(['1.0.2', '1.0.5'].includes(version), 'reviewed real Aurabot version required');
const lib = async path => import(pathToFileURL(join(root, 'src', path)).href);
const { createHub } = await lib('chat/hub.js');
const { DEFAULTS } = await lib('core/config.js');
const libraries = { 'chat/inbound.js': await lib('chat/inbound.js'), 'chat/access.js': await lib('chat/access.js') };
test.after(() => rmSync(home, { recursive: true, force: true }));

function fixture(t, options = {}) {
  const events = [], warnings = [], listeners = new Map(), contexts = new Set(), disposers = [], timers = [];
  const cfg = { ...structuredClone(DEFAULTS), enabled: true, dryRun: false, botQQ: '900', ownerQQ: '100',
    allow: { groups: ['200'], private: ['300'] }, ...options.config };
  cfg.voice.enabled = false; cfg.stickers.enabled = false; cfg.stickers.collect = false;
  let nextId = 0;
  const onebot = options.onebot || { async call() { return { message_id: ++nextId }; } };
  const emit = (name, ...args) => { for (const fn of [...(listeners.get(name) || [])]) fn(...args); };
  const hub = createHub({ dsh: {}, getConfig: () => cfg, onebot, log: { info() {}, debug() {}, warn() {}, error() {} },
    isMuted: options.isMuted, onCommand: options.onCommand, onActivity: activity => emit('activity', activity),
    hooks: { ...options.hooks, message: async msg => {
      if (options.takeover) return true;
      for (const fn of listeners.get('message') || []) if (await fn(msg)) return true;
      return false;
    }, groupDecide: () => ({ reply: false, reason: 'synthetic no reply' }) } });
  const service = { recordEvent: async event => events.push(event), recall: () => '' };
  const api = { config: () => cfg, lib: path => libraries[path], core: { onebot, hub },
    dataDir: () => join(home, `module-${Math.random()}`), dsh: { get: () => service },
    log: { warn: (...args) => warnings.push(args) }, isOwner: id => id === cfg.ownerQQ,
    on(name, fn) { const set = listeners.get(name) || new Set(); listeners.set(name, set); set.add(fn); return () => set.delete(fn); },
    context(fn) { contexts.add(fn); return () => contexts.delete(fn); },
    every(ms, fn) { timers.push(fn); return () => timers.splice(timers.indexOf(fn), 1); },
    onDispose(fn) { disposers.push(fn); },
  };
  const dispose = () => disposers.splice(0).forEach(fn => fn());
  t.after(dispose);
  (options.setup || setupConnector)(api, { clock: { now: () => 1800000000123 } });
  const tick = async () => { for (const fn of timers) await fn(); };
  return { api, hub, onebot, events, warnings, cfg, dispose, tick, emit,
    async receive(event) { emit('onebot', event); await hub.onMessage(event); await tick(); } };
}
const message = (overrides = {}) => ({ post_type: 'message', message_type: 'group', self_id: 900, user_id: 300,
  group_id: 200, message_id: 42, time: 1700000000, sender: { nickname: '合成成员' },
  message: [{ type: 'text', data: { text: '合成消息' } }], ...overrides });

test('real hub records final reply/items/send output only after successful OneBot resolution', async t => {
  let resolve;
  const f = fixture(t, { onebot: { call: () => new Promise(done => { resolve = done; }) }, hooks: {
    reply: () => 'reply rewrite', items: () => [{ kind: 'text', value: 'items rewrite' }],
    send: () => [{ type: 'reply', data: { id: 'quote-only' } }, { type: 'text', data: { text: '最终可见' } },
      { type: 'image', data: { get file() { throw Error('must not read file'); } } },
      { type: 'record', data: { file: 'base64://SECRET' } }, { type: 'face', data: { id: 1 } }],
  } });
  const sending = f.hub.deliver('group:200', '原稿');
  await new Promise(setImmediate); await f.tick(); assert.equal(f.events.length, 0);
  resolve({ message_id: 789 }); await sending; await f.tick();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].contentText, '最终可见[图片][语音][表情]');
  assert.equal(f.events[0].sourceKey, 'aurabot:out:onebot:789');
  assert.equal(f.events[0].actorKey, 'qq:bot');
  assert.doesNotMatch(JSON.stringify(f.events), /原稿|rewrite|SECRET|quote-only/);
});

test('real hub drops blocked, failed, disabled, dry-run and capture sends from memory', async t => {
  const blocked = fixture(t, { hooks: { send: () => null } });
  await blocked.hub.deliver('group:200', 'blocked'); await blocked.tick(); assert.equal(blocked.events.length, 0);
  const failed = fixture(t, { onebot: { call: async () => { throw Error('synthetic'); } } });
  await failed.hub.deliver('group:200', 'failed'); await failed.tick(); assert.equal(failed.events.length, 0);
  const f = fixture(t);
  f.cfg.dryRun = true; await f.hub.deliver('group:200', 'dry');
  f.cfg.dryRun = false; f.cfg.enabled = false; await f.hub.deliver('group:200', 'disabled');
  f.cfg.enabled = true;
  const captured = await f.hub.capture(() => f.hub.deliver('group:200', 'captured'));
  assert.equal(captured.sent.length, 1); await f.tick(); assert.equal(f.events.length, 0);
});

test('direct hub/module/command sends and media use successful final call parameters', async t => {
  const f = fixture(t, { onCommand: async () => '命令成功' });
  await f.hub.sendText('private:100', '直接文字');
  await f.onebot.call('send_group_msg', { group_id: 200, message: [{ type: 'image', data: { file: 'C:\\SECRET.png' } }] });
  await f.receive(message({ message_type: 'private', user_id: 100, message: [{ type: 'text', data: { text: '/hello' } }] }));
  assert.deepEqual(f.events.filter(e => e.direction === 'outgoing').map(e => e.contentText), ['直接文字', '[图片]', '命令成功']);
  assert.equal(f.events[0].visibility, 'owner-private');
  assert.ok(f.events.every(e => !JSON.stringify(e).includes('SECRET')));
});

test('send listener reuse survives multiple module instances, reload and third-party replacement', async t => {
  const onebot = { call: async () => ({}) }, original = onebot.call;
  const first = fixture(t, { onebot }), wrapper = onebot.call;
  const reload = await import('../aurabot-module/dafeiyu-memory/index.mjs?hot-reload');
  const second = fixture(t, { onebot, setup: reload.setupConnector }); assert.equal(onebot.call, wrapper); assert.notEqual(wrapper, original);
  await onebot.call('send_private_msg', { user_id: 300, message: '同次发送' }); await first.tick(); await second.tick();
  assert.equal(first.events.length, 1); assert.equal(second.events.length, 1);
  assert.equal(first.events[0].sourceKey, second.events[0].sourceKey);
  first.dispose(); assert.equal(onebot.call, wrapper);
  await onebot.call('send_private_msg', { user_id: 300, message: '第二次' }); await second.tick();
  assert.equal(first.events.length, 1); assert.equal(second.events.length, 2);
  second.dispose(); assert.equal(onebot.call, original);
  const reloaded = fixture(t, { onebot });
  await onebot.call('send_private_msg', { user_id: 300, message: '重载' }); await reloaded.tick(); assert.equal(reloaded.events.length, 1);
  const later = async () => ({ message_id: 99 }); onebot.call = later;
  reloaded.dispose(); assert.equal(onebot.call, later);
});

test('send observation preserves gateway this/arguments/results/errors and ignores disposal during an in-flight call', async t => {
  let resolve, seen;
  const result = { message_id: 55 }, failure = new Error('synthetic gateway failure');
  const onebot = { call(...args) { seen = { receiver: this, args };
    if (args[0] === 'failure') return Promise.reject(failure);
    return new Promise(done => { resolve = done; });
  } };
  const original = onebot.call, f = fixture(t, { onebot });
  const params = { user_id: 300, message: [{ type: 'text', data: { text: '成功发送' } }] }, options = { timeoutMs: 1 };
  const sending = onebot.call('send_private_msg', params, options);
  assert.equal(seen.receiver, onebot); assert.deepEqual(seen.args, ['send_private_msg', params, options]);
  f.dispose(); resolve(result); assert.equal(await sending, result); await f.tick(); assert.equal(f.events.length, 0);
  assert.equal(onebot.call, original);
  const next = fixture(t, { onebot });
  await assert.rejects(onebot.call('failure', {}), error => error === failure); await next.tick();
  assert.equal(next.events.length, 0);
});

test('real hub inbound observation precedes mute, owner command, takeover and no-reply exits exactly once', async t => {
  for (const options of [{ isMuted: () => true }, { onCommand: async () => 'command reply' }, { takeover: true }, {}]) {
    const f = fixture(t, options);
    const event = options.onCommand ? message({ message_type: 'private', user_id: 100,
      message: [{ type: 'text', data: { text: '/hello' } }] }) : message();
    await f.receive(event);
    f.emit('activity', { kind: 'in', chatId: 'group:200', text: 'activity duplicate' }); await f.tick();
    const incoming = f.events.filter(e => e.direction === 'incoming');
    assert.equal(incoming.length, 1, Object.keys(options).join() || 'no-reply');
    assert.equal(incoming[0].sourceKey, '42'); assert.equal(incoming[0].occurredAt, 1700000000000);
    f.dispose(); await f.receive({ ...event, message_id: 43 }); assert.equal(f.events.filter(e => e.direction === 'incoming').length, 1);
  }
});

test('real inbound parser and allow rules reject unauthorized, own and malformed events without media leakage', async t => {
  const f = fixture(t, { takeover: true });
  for (const event of [message({ group_id: 201 }), message({ message_type: 'private', user_id: 301 }),
    message({ user_id: 900 }), message({ post_type: 'message_sent' }), message({ message_type: 'unknown' }),
    message({ user_id: undefined, sender: {} }), message({ group_id: undefined }), { post_type: 'notice' }, null]) {
    f.emit('onebot', event);
  }
  await f.tick(); assert.equal(f.events.length, 0);
  await f.receive(message({ message: [{ type: 'at', data: { qq: '900' } }, { type: 'text', data: { text: '纯文字' } },
    { type: 'image', data: { file: 'base64://SECRET' } }, { type: 'record', data: { file: 'C:\\SECRET.wav' } },
    { type: 'file', data: { file: 'C:\\SECRET.txt' } }, { type: 'reply', data: { id: 77, text: 'QUOTED_SECRET' } }] }));
  assert.equal(f.events.length, 1); assert.equal(f.events[0].contentText, '纯文字[图片][语音][文件]');
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET|base64|900/);
  assert.equal(f.events[0].visibility, 'group');
  await f.receive(message({ message_type: 'private', user_id: 100 })); assert.equal(f.events.at(-1).visibility, 'owner-private');
  await f.receive(message({ message_type: 'private', user_id: 300 })); assert.equal(f.events.at(-1).visibility, 'conversation');
});

test('malformed OneBot identifiers never create events or stringify caller objects', async t => {
  const f = fixture(t, { takeover: true });
  let touched = 0;
  const objectId = { toString() { touched++; return '300'; } };
  for (const bad of [objectId, {}, [], true, NaN, Infinity, ' ', 'x'.repeat(513)]) {
    f.emit('onebot', message({ user_id: bad }));
    f.emit('onebot', message({ message_id: bad }));
  }
  await f.tick(); assert.equal(f.events.length, 0); assert.equal(touched, 0);
});
