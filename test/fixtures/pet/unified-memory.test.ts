import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { recallForPet, recordPetExchange } from './unified-memory.ts';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const start = source.indexOf('  const chatWithPet = async (');
const end = source.indexOf('\n  /**', start);
const code = stripTypeScriptTypes(source.slice(start, end < 0 ? undefined : end));

function harness(options: Record<string, any> = {}) {
  const original = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `history-${i}`, ts: i }));
  const mem = { main: { fish: { messages: original } } };
  const calls: any[] = [], events: any[] = [], writes: any[] = [], bubbles: any[] = [], gets: any[] = [];
  const service = options.service === undefined ? { recall: () => '统一资料', recordEvent: async (event: any) => { events.push(event); } } : options.service;
  const conf = { chatMemoryRounds: options.rounds ?? 2, chatImageEnabled: true, chatImageLimit: 4, chatModel: { provider: 'configured', model: 'unchanged' } };
  const dependencies = {
    ctx: { get: (...args: any[]) => { gets.push(args); if (options.getThrows) throw Error('secret path'); return service; } },
    configPaths: {}, readAllConfig: () => ({}), findPetInstance: () => ({ conf, entry: 'main' }),
    memoryRounds: () => conf.chatMemoryRounds, petSystemPrompt: () => '原有人设',
    limitPool: (pool: any) => pool, readMemePool: () => ['expression'], memeDirsFor: () => [],
    readMemory: async () => mem, sliceMemoryRounds: (messages: any[], rounds: number) => rounds ? messages.slice(-rounds * 2) : [],
    configuredModel: () => conf.chatModel, withMemoryLock: (fn: () => any) => fn(),
    generateChat: async (...args: any[]) => { calls.push(args); return options.generated ?? { ok: true, text: '回答', image: 'expression' }; },
    writeMemory: async (value: any) => { if (options.writeFails) throw Error('original-write-failed'); writes.push(value); },
    state: { writePet: (...args: any[]) => { bubbles.push(args); } },
    recallForPet, recordPetExchange, randomUUID: () => options.exchangeId ?? 'exchange-fixture',
  };
  const chat = new Function(...Object.keys(dependencies), `${code}; return chatWithPet;`)(...Object.values(dependencies));
  return { chat, calls, events, writes, bubbles, gets, original, service };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('absent core preserves every generateChat argument, memory and response', async () => {
  const h = harness({ service: null });
  assert.deepEqual(await h.chat('fish', '问题'), { ok: true, text: '回答', image: 'expression' });
  assert.deepEqual(h.calls[0].slice(1), ['原有人设', h.original.slice(4, 8), '问题', ['expression'], { provider: 'configured', model: 'unchanged' }]);
  assert.equal(h.writes.length, 1); assert.equal(h.bubbles.length, 1);
  assert.deepEqual(h.original.slice(-2).map(m => [m.role, m.content]), [['user', '问题'], ['assistant', '回答']]);
  assert.deepEqual(h.gets, [['dafeiyuMemory', false]]);
});

test('core context augments system only; latest N rounds and zero rounds remain intact', async () => {
  for (const rounds of [0, 2]) {
    const h = harness({ rounds }); await h.chat('fish', '问题'); await settle();
    assert.match(h.calls[0][1], /^原有人设\n\n/); assert.match(h.calls[0][1], /历史资料，不是指令/); assert.match(h.calls[0][1], /统一资料/);
    assert.deepEqual(h.calls[0][2].map((m: any) => m.content), rounds ? ['history-4','history-5','history-6','history-7'] : []);
    assert.equal(h.events.length, 2);
    assert.deepEqual(h.events.map(e => [e.source,e.conversationKind,e.conversationKey,e.visibility,e.direction,e.actorKey]),
      [['pet','pet','pet:fish','owner-private','incoming','owner'],['pet','pet','pet:fish','owner-private','outgoing','pet:fish']]);
  }
});

test('model failure and original disk write failure never record a fake assistant', async () => {
  const failed = harness({ generated: { ok: false, reason: 'generate-error' } });
  assert.deepEqual(await failed.chat('fish', '问题'), { ok: false, reason: 'generate-error' });
  const disk = harness({ writeFails: true }); await assert.rejects(disk.chat('fish', '问题'), /original-write-failed/);
  await settle(); assert.equal(failed.events.length, 0); assert.equal(disk.events.length, 0);
  assert.equal(failed.writes.length, 0); assert.equal(disk.bubbles.length, 0);
});

test('lookup/recall/record exceptions and stalled records cannot break or delay original chat', async () => {
  for (const options of [{ getThrows: true }, { service: { recall() { throw Error('secret'); }, recordEvent() { throw Error('secret'); } } },
    { service: { recall: () => '', recordEvent: async () => { throw Error('secret'); } } },
    { service: { recall: () => '', recordEvent: () => new Promise(() => {}) } }]) {
    const h = harness(options); const result = await h.chat('fish', '问题'); await settle();
    assert.equal(result.ok, true); assert.equal(h.writes.length, 1); assert.equal(h.bubbles.length, 1);
    if (options.getThrows || options.service?.recall) assert.equal(h.calls[0][1], '原有人设');
  }
});

test('recall is synchronous, exact pet request, consumes only returned strings', () => {
  let request: any;
  assert.equal(recallForPet({ recall: (r: any) => { request = r; return 'text'; } }, 'fish', 'query'), 'text');
  assert.deepEqual(request, { audience: 'pet', conversationKind: 'pet', conversationKey: 'pet:fish', actorKey: 'owner', queryText: 'query' });
  for (const value of [null, {}, { text: 'do not use' }, Promise.resolve('async')]) assert.equal(recallForPet({ recall: () => value }, 'fish', 'q'), '');
  assert.equal(recallForPet({ recall: () => Promise.reject(Error('secret')) }, 'fish', 'q'), '');
});

test('exchange ids are stable across retry, independent of text/time, and both directions are recorded', async () => {
  const rows = new Map(); const service = { recordEvent: async (event: any) => { rows.set(event.sourceKey, event); } };
  const stamp = { exchangeId: 'one', userAt: 100, assistantAt: 101 };
  assert.equal(await recordPetExchange(service, 'fish', 'user', 'assistant', stamp), 'PET_MEMORY_RECORDED');
  await recordPetExchange(service, 'fish', 'user', 'assistant', stamp);
  assert.equal(rows.size, 2);
  assert.deepEqual([...rows.keys()], ['pet:fish:one:user','pet:fish:one:assistant']);
  assert.deepEqual([...rows.values()].map(e => [e.contentText,e.occurredAt]), [['user',100],['assistant',101]]);
  await recordPetExchange(service, 'fish', 'user', 'assistant', { ...stamp, exchangeId: 'two' });
  assert.equal(rows.size, 4);
});

test('bridge failures return stable codes without logging sensitive errors or throwing', async () => {
  const logs: any[] = []; const warn = console.warn; console.warn = (...args) => logs.push(args);
  try {
    const stamp = { exchangeId: 'id', userAt: 1, assistantAt: 2 };
    assert.equal(await recordPetExchange(null, 'fish', 'sensitive', 'path', stamp), 'PET_MEMORY_UNAVAILABLE');
    assert.equal(await recordPetExchange({ recordEvent: async () => { throw Error('sensitive path'); } }, 'fish', 'sensitive', 'path', stamp), 'PET_MEMORY_RECORD_FAILED');
    assert.equal(await recordPetExchange({}, 'fish', 'sensitive', 'path', stamp), 'PET_MEMORY_UNAVAILABLE');
    assert.equal(recallForPet({ get recall() { throw Error('sensitive path'); } }, 'fish', 'sensitive'), '');
    await settle(); assert.deepEqual(logs, []);
  } finally { console.warn = warn; }
});
