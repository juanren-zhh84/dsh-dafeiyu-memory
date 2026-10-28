import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
const root = process.env.AURABOT_TEST_ROOT || join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-aurabot-qq');
const libraries = Object.fromEntries(await Promise.all(['chat/inbound.js', 'chat/access.js'].map(async path =>
  [path, await import(pathToFileURL(join(root, 'src', path)).href)])));

export function fakeAurabot(dataDir) {
  const listeners = new Map(), contexts = new Set(), timers = new Set(), disposers = [];
  const fake = { service: undefined, warnings: [], gets: [], owners: new Set(['owner-fixture']),
    api: {
      core: { onebot: { call: async () => ({}) } },
      lib: path => libraries[path],
      config: () => ({ botQQ: 'bot-fixture', ownerQQ: 'owner-fixture',
        allow: { private: ['friend-fixture', 'other-fixture', 'unknown-fixture'], groups: ['fixture-room', 'acceptance'] } }),
      dataDir: (...parts) => join(dataDir, ...parts),
      log: { warn: (...args) => fake.warnings.push(args) },
      isOwner: (id) => fake.owners.has(id),
      dsh: { get: (...args) => { fake.gets.push(args); return fake.service; } },
      on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); },
      context: (fn) => { contexts.add(fn); return () => contexts.delete(fn); },
      every: (ms, fn) => { timers.add(fn); fake.period = ms; return () => timers.delete(fn); },
      onDispose: (fn) => { disposers.push(fn); return () => {}; },
    },
    emit: (name, value) => {
      if (name === 'message') listeners.get('onebot')?.({ post_type: 'message', message_type: value.kind,
        self_id: 'bot-fixture', user_id: value.userId ?? value.chatId?.slice(8), group_id: value.groupId ?? value.chatId?.slice(6),
        message_id: value.messageId, time: value.raw?.time, sender: { nickname: value.nickname },
        message: [{ type: 'text', data: { text: value.text } }] });
      return listeners.get(name)?.(value) ?? (name === 'message' ? false : undefined);
    },
    send: (chatId, value) => fake.api.core.onebot.call(chatId.startsWith('group:') ? 'send_group_msg' : 'send_private_msg',
      { [chatId.startsWith('group:') ? 'group_id' : 'user_id']: chatId.slice(chatId.indexOf(':') + 1),
        message: [{ type: 'text', data: { text: value } }] }),
    context: (chat) => [...contexts].map((fn) => fn({ chat, sessionId: 'fixture-session' })).join(''),
    tick: async () => { for (const fn of timers) await fn(); },
    dispose: () => disposers.forEach((fn) => fn()),
    get listenerCount() { return listeners.size + contexts.size + timers.size; },
  };
  return fake;
}
