import { join } from 'node:path';

export function fakeAurabot(dataDir) {
  const listeners = new Map(), contexts = new Set(), timers = new Set(), disposers = [];
  const fake = { service: undefined, warnings: [], gets: [], owners: new Set(['owner-fixture']),
    api: {
      dataDir: (...parts) => join(dataDir, ...parts),
      log: { warn: (...args) => fake.warnings.push(args) },
      isOwner: (id) => fake.owners.has(id),
      dsh: { get: (...args) => { fake.gets.push(args); return fake.service; } },
      on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); },
      context: (fn) => { contexts.add(fn); return () => contexts.delete(fn); },
      every: (ms, fn) => { timers.add(fn); fake.period = ms; return () => timers.delete(fn); },
      onDispose: (fn) => { disposers.push(fn); return () => {}; },
    },
    emit: (name, value) => listeners.get(name)?.(value),
    context: (chat) => [...contexts].map((fn) => fn({ chat, sessionId: 'fixture-session' })).join(''),
    tick: async () => { for (const fn of timers) await fn(); },
    dispose: () => disposers.forEach((fn) => fn()),
    get listenerCount() { return listeners.size + contexts.size + timers.size; },
  };
  return fake;
}
