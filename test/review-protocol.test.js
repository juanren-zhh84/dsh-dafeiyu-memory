import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReviewDecision, validateReviewDecision, snapshotReviewRequest } from '../src/review/protocol.js';
import { ReviewModel } from '../src/review/model-client.js';
import { createFakeLlm, textStream } from './helpers/fake-llm.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import * as plugin from '../src/index.js';
import { createFakeContext } from './helpers/fake-context.js';
import { createTempHome } from './helpers/temp-home.js';
import { eventInput } from './fixtures/events.js';
import { readFileSync } from 'node:fs';
import semver from 'semver';

const candidates = () => [1, 2, 3].map((n) => ({ id: `e${n}`, version: 1, content: `private content ${n}`, visibility: 'owner-private' }));
const request = (mode = 'short-term') => snapshotReviewRequest({ mode, candidates: candidates() });
const decision = () => ({ retain: [{ sourceIds: ['e1'], kind: 'fact', content: '记忆', importance: 0.8 }], diary: [{ sourceIds: ['e2'], title: '标题', body: '日记' }], discard: ['e3'] });
const review = (chunks, config = DEFAULT_CONFIG) => new ReviewModel(createFakeLlm(chunks).ctx, { config }).review({ mode: 'short-term', candidates: candidates() });
function safeError(error, code = 'MEMORY_REVIEW_INVALID_PROTOCOL') {
  assert.equal(error.code, code);
  assert.match(error.message, /^Memory review [a-z ]+$/);
  assert.equal(error.stack, `Error: ${error.message}`);
  assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ['code', 'message', 'stack']);
  assert.doesNotMatch(JSON.stringify(error), /private content|secret|account|[A-Z]:\\/);
  return true;
}

test('valid short-term output partitions sources and defaults confidence without adding authority fields', () => {
  const result = parseReviewDecision(JSON.stringify(decision()), request());
  assert.deepEqual(result, { ...decision(), retain: [{ ...decision().retain[0], confidence: 1 }] });
  assert.equal(Object.hasOwn(result.retain[0], 'visibility'), false);
});

test('long-term accepts only diary and discard', () => {
  const value = { diary: [{ sourceIds: ['e1', 'e2'], title: '旧事', body: '日记' }], discard: ['e3'] };
  assert.deepEqual(parseReviewDecision(JSON.stringify(value), request('long-term')), value);
  assert.throws(() => parseReviewDecision(JSON.stringify(decision()), request('long-term')), safeError);
});

for (const [name, mutate] of [
  ['unknown root field', (d) => { d.sql = 'secret'; }],
  ['unknown retain authority', (d) => { d.retain[0].visibility = 'public'; }],
  ['unknown subject', (d) => { d.retain[0].subjectKey = 'account'; }],
  ['unknown diary field', (d) => { d.diary[0].deleteAt = 1; }],
  ['unknown kind', (d) => { d.retain[0].kind = 'sql'; }],
  ['out of batch', (d) => { d.discard = ['outside']; }],
  ['overlap', (d) => { d.discard = ['e1', 'e3']; }],
  ['duplicate source', (d) => { d.retain[0].sourceIds.push('e1'); }],
  ['duplicate discard', (d) => { d.discard.push('e3'); }],
  ['omitted source', (d) => { d.discard = []; }],
  ['empty sources', (d) => { d.diary[0].sourceIds = []; }],
  ['too many items', (d) => { d.diary = Array(41).fill(d.diary[0]); }],
  ['long content', (d) => { d.retain[0].content = 'a'.repeat(4001); }],
  ['long title', (d) => { d.diary[0].title = 'a'.repeat(201); }],
  ['long diary', (d) => { d.diary[0].body = 'a'.repeat(16001); }],
  ['empty content', (d) => { d.retain[0].content = ' '; }],
  ['invalid importance', (d) => { d.retain[0].importance = 1.01; }],
  ['invalid confidence', (d) => { d.retain[0].confidence = -1; }],
  ['nonfinite confidence', (d) => { d.retain[0].confidence = NaN; }],
  ['inherited root', (d) => { Object.setPrototypeOf(d, { secret: 'secret' }); }],
  ['inherited retain field', (d) => { Object.setPrototypeOf(d.retain[0], { confidence: 0.2 }); }],
  ['getter', (d) => { Object.defineProperty(d.retain[0], 'confidence', { get() { throw new Error('secret'); } }); }],
  ['proxy', (d) => { d.diary[0] = new Proxy({}, { getPrototypeOf() { throw new Error('secret'); } }); }],
  ['sparse source array', (d) => { d.retain[0].sourceIds = Array(1); }],
  ['inherited array index', (d) => { const a = Array(1); Object.setPrototypeOf(a, { 0: 'e1' }); d.retain[0].sourceIds = a; }],
  ['array extra property', (d) => { d.discard.extra = 'secret'; }],
]) test(`rejects ${name} with a sanitized protocol error`, () => {
  const value = decision(); mutate(value);
  assert.throws(() => validateReviewDecision(value, request()), safeError);
});

for (const raw of [
  '```json\n{}\n```', 'prefix {}', '{} trailing', '', 'null', '[]',
  '{"retain":[],"diary":[],"discard":["e1","e2","e3"],"discard":[]}',
  '{"retain":[],"diary":[],"discard":[],"dis\\u0063ard":["e1","e2","e3"]}',
]) test(`rejects invalid JSON envelope ${JSON.stringify(raw).slice(0, 70)}`, () => {
  assert.throws(() => parseReviewDecision(raw, request()), safeError);
});

test('JSON strings and nested members do not trigger duplicate top-level detection', () => {
  const value = decision(); value.retain[0].content = '"discard": [], \\ } {';
  assert.equal(parseReviewDecision(JSON.stringify(value), request()).retain[0].content, value.retain[0].content);
});

test('candidate snapshot is detached and frozen', () => {
  const input = { mode: 'short-term', candidates: candidates() };
  const value = snapshotReviewRequest(input);
  input.candidates[0].content = 'changed';
  assert.equal(value.candidates[0].content, 'private content 1');
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.candidates)); assert.ok(Object.isFrozen(value.candidates[0]));
});

for (const mutate of [
  (r) => { r.candidates = Array(41).fill(r.candidates[0]); },
  (r) => { r.candidates[0].account = 'secret'; },
  (r) => { delete r.candidates[0].version; },
  (r) => { r.candidates[0].version = 0; },
  (r) => { r.candidates[0].visibility = 'invalid'; },
  (r) => { r.candidates[1].id = 'e1'; },
  (r) => { Object.setPrototypeOf(r.candidates[0], { id: 'secret' }); },
  (r) => { Object.defineProperty(r.candidates[0], 'content', { get() { throw new Error('secret'); } }); },
]) test('invalid candidate snapshot rejects before model execution', async () => {
  const fake = createFakeLlm([]); const input = { mode: 'short-term', candidates: candidates() }; mutate(input);
  await assert.rejects(new ReviewModel(fake.ctx, { config: DEFAULT_CONFIG }).review(input), (e) => safeError(e, 'MEMORY_REVIEW_INVALID_INPUT'));
  assert.equal(fake.requests.length, 0);
});

test('reads the current selection on every call and copies only permitted settings', async () => {
  const fake = createFakeLlm(textStream(JSON.stringify(decision())), { provider: 'p1', model: 'm1', reasoningEffort: 'high', apiKey: 'secret', temperature: 1 });
  const model = new ReviewModel(fake.ctx, { config: DEFAULT_CONFIG });
  const input = { mode: 'short-term', candidates: candidates() };
  await model.review(input); fake.selection.model = 'm2'; delete fake.selection.reasoningEffort; await model.review(input);
  assert.equal(fake.reads, 2);
  assert.equal(fake.requests[0].model, 'm1'); assert.equal(fake.requests[1].model, 'm2');
  assert.equal(fake.requests[0].reasoningEffort, 'high'); assert.equal(Object.hasOwn(fake.requests[1], 'reasoningEffort'), false);
  assert.equal(fake.requests[0].apiKey, undefined);
  assert.equal(fake.requests[0].temperature, 0); assert.equal(fake.requests[0].maxTokens, 4096);
  assert.ok(fake.requests[0].signal instanceof AbortSignal); assert.equal(fake.requests[0].tools, undefined);
  assert.match(fake.requests[0].system, /JSON/);
  assert.equal(fake.requests[0].messages[0].role, 'user');
  assert.deepEqual(JSON.parse(fake.requests[0].messages[0].content[0].text).candidates, candidates().map(({ id, content }) => ({ id, content })));
});

test('accepts reasoning blocks then exactly one text block using delta and complete block streams', async () => {
  const raw = JSON.stringify(decision());
  for (const chunks of [
    [{ type: 'reasoning-delta', index: 0, text: 'reason' }, { type: 'text-delta', index: 1, text: raw }, { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'reason' } }, { type: 'block-end', index: 1, block: { type: 'text', text: raw } }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'stop' } }],
  ]) assert.deepEqual((await review(chunks)).discard, ['e3']);
});

for (const [name, chunks] of [
  ['empty text', textStream('')], ['missing finish', textStream(JSON.stringify(decision())).slice(0, -1)],
  ...['aborted', 'error', 'max-tokens', 'tool-calls'].map((r) => [r, textStream(JSON.stringify(decision()), r)]),
  ['chunk after finish', [...textStream(JSON.stringify(decision())), { type: 'usage', usage: {} }]],
  ['second finish', [...textStream(JSON.stringify(decision())), { type: 'finish', reason: { kind: 'stop' } }]],
  ['multiple text blocks', [{ type: 'text-delta', index: 0, text: '{}' }, ...textStream(JSON.stringify(decision())).map((c) => ({ ...c, ...(Object.hasOwn(c, 'index') ? { index: 1 } : {}) }))]],
  ['tool block', [{ type: 'tool-call-delta', index: 0, id: 'tool', name: 'sql', argumentsDelta: '{}' }, ...textStream(JSON.stringify(decision()))]],
  ['unknown chunk', [{ type: 'secret' }, ...textStream(JSON.stringify(decision()))]],
  ['index type collision', [{ type: 'reasoning-delta', index: 0, text: 'reason' }, ...textStream(JSON.stringify(decision()))]],
]) test(`rejects invalid stream: ${name}`, async () => {
  await assert.rejects(review(chunks), (e) => safeError(e, name === 'empty text' ? 'MEMORY_REVIEW_INVALID_PROTOCOL' : 'MEMORY_REVIEW_STREAM_FAILED'));
});

test('timeouts reject even if a provider ignores the abort signal', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(review(() => ({ [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); } }), { ...DEFAULT_CONFIG, reviewTimeoutMs: 15 }), (e) => safeError(e, 'MEMORY_REVIEW_TIMEOUT')); }
  finally { clearTimeout(keepAlive); }
});

test('external cancellation aborts provider requests even when its iterator hangs', async () => {
  const controller = new AbortController();
  const fake = createFakeLlm(async function* () { await new Promise(() => {}); });
  const keepAlive = setTimeout(() => {}, 1000);
  const operation = new ReviewModel(fake.ctx, { config: { ...DEFAULT_CONFIG, reviewTimeoutMs: 50 } })
    .review({ mode: 'short-term', candidates: candidates() }, { signal: controller.signal });
  operation.catch(() => {});
  controller.abort(new Error('account-secret'));
  try {
    assert.equal(fake.requests[0].signal.aborted, true);
    await assert.rejects(operation, (e) => safeError(e, 'MEMORY_REVIEW_TIMEOUT'));
  } finally { await operation.catch(() => {}); clearTimeout(keepAlive); }
});

test('provider exceptions and selection exceptions never leak their cause', async () => {
  await assert.rejects(review(() => { throw new Error('secret account C:\\private'); }), (e) => safeError(e, 'MEMORY_REVIEW_MODEL_FAILED'));
  const fake = createFakeLlm([]); fake.ctx.agentDefaultModel.currentSelection = () => { throw new Error('secret'); };
  await assert.rejects(new ReviewModel(fake.ctx, { config: DEFAULT_CONFIG }).review({ mode: 'short-term', candidates: candidates() }), (e) => safeError(e, 'MEMORY_REVIEW_MODEL_FAILED'));
});

test('plugin injects model services and chat remains usable after a review failure', async () => {
  assert.deepEqual(plugin.inject, ['llm', 'agentDefaultModel']);
  const ctx = Object.assign(createFakeContext(), createFakeLlm(textStream('invalid')).ctx);
  await plugin.apply(ctx, {}, { dshHome: createTempHome() }); const service = ctx.get('dafeiyuMemory');
  try {
    assert.ok(service.reviewModel instanceof ReviewModel);
    await assert.rejects(service.reviewModel.review({ mode: 'short-term', candidates: candidates() }));
    const saved = await service.recordEvent(eventInput()); assert.ok(saved.id);
    assert.equal(typeof service.recall({ audience: 'owner' }), 'string');
    assert.deepEqual(await service.runDueReviews(), { queued: 0, completed: 0, retried: 0, failed: 0 });
  } finally { await service.dispose(); }
});

test('DSH runtime compatibility covers rc.2 and rc.3 while consumed development packages stay pinned', () => {
  const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const locked = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')).packages[''];
  const range = '0.2.1-rc.2 || 0.2.1-rc.3';
  const compatibility = [['0.2.1-rc.2', true], ['0.2.1-rc.3', true], ['0.2.1-rc.4', false],
    ['0.2.1', false], ['0.2.2-rc.1', false]];
  for (const [version, expected] of compatibility) {
    assert.equal(semver.satisfies(version, metadata.engines.dsh, { includePrerelease: true }), expected, `engine ${version}`);
    for (const [name, value] of Object.entries(metadata.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))) {
      assert.equal(semver.satisfies(version, value, { includePrerelease: true }), expected, `${name} ${version}`);
    }
  }
  assert.equal(metadata.engines.dsh, range);
  const peers = Object.entries(metadata.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'));
  assert.equal(peers.length, 4);
  for (const [name, value] of peers) assert.equal(value, range, name);
  assert.deepEqual(locked.engines, metadata.engines); assert.deepEqual(locked.peerDependencies, metadata.peerDependencies);
  assert.deepEqual(locked.devDependencies, metadata.devDependencies);
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent-default-model']) {
    assert.equal(metadata.devDependencies[name], '0.2.1-rc.2');
    assert.equal(metadata.peerDependenciesMeta?.[name]?.optional, undefined);
  }
});

test('maximum batch and output text lengths are accepted', () => {
  const input = { mode: 'short-term', candidates: Array.from({ length: 40 }, (_, n) => ({ id: `e${n}`, version: 1, content: 'a'.repeat(16000), visibility: 'public' })) };
  const value = { retain: [{ sourceIds: ['e0'], kind: 'behavior-note', content: 'a'.repeat(4000), importance: 0, confidence: 1 }],
    diary: [{ sourceIds: ['e1'], title: 'a'.repeat(200), body: 'a'.repeat(16000) }], discard: input.candidates.slice(2).map(({ id }) => id) };
  assert.deepEqual(parseReviewDecision(JSON.stringify(value), snapshotReviewRequest(input)), value);
});

test('candidate getters are rejected without invocation and proxies cannot leak failures', () => {
  let reads = 0;
  const input = { mode: 'short-term', candidates: candidates() };
  Object.defineProperty(input.candidates[0], 'content', { get() { reads++; return 'secret'; } });
  assert.throws(() => snapshotReviewRequest(input), (e) => safeError(e, 'MEMORY_REVIEW_INVALID_INPUT'));
  assert.equal(reads, 0);
  assert.throws(() => snapshotReviewRequest(new Proxy({}, { ownKeys() { throw new Error('secret'); } })), (e) => safeError(e, 'MEMORY_REVIEW_INVALID_INPUT'));
});

test('request is snapshotted before selection and long-term prompts prohibit retain', async () => {
  const input = { mode: 'long-term', candidates: candidates() };
  const value = { diary: [], discard: ['e1', 'e2', 'e3'] };
  const fake = createFakeLlm(textStream(JSON.stringify(value)));
  fake.ctx.agentDefaultModel.currentSelection = () => { input.candidates[0].content = 'changed'; return fake.selection; };
  assert.deepEqual(await new ReviewModel(fake.ctx).review(input), value);
  assert.equal(JSON.parse(fake.requests[0].messages[0].content[0].text).candidates[0].content, 'private content 1');
  assert.match(fake.requests[0].system, /顶层精确字段：diary、discard/);
});

test('asynchronous iterator failures are sanitized', async () => {
  await assert.rejects(review(async function* () { yield { type: 'text-delta', index: 0, text: 'secret' }; throw new Error('secret account'); }), (e) => safeError(e, 'MEMORY_REVIEW_STREAM_FAILED'));
});

test('stream accessors and inherited chunks cannot bypass validation', async () => {
  let reads = 0;
  const raw = JSON.stringify(decision());
  const chunk = { type: 'text-delta', index: 0 };
  Object.defineProperty(chunk, 'text', { get() { reads++; return raw; } });
  for (const first of [chunk, Object.create({ type: 'text-delta', index: 0, text: raw })]) {
    await assert.rejects(review([first, { type: 'finish', reason: { kind: 'stop' } }]), (e) => safeError(e, 'MEMORY_REVIEW_STREAM_FAILED'));
  }
  assert.equal(reads, 0);
});

test('nested stream accessors and proxy failures are rejected without leaking contents', async () => {
  let reads = 0;
  const block = { type: 'text' };
  Object.defineProperty(block, 'text', { get() { reads++; return JSON.stringify(decision()); } });
  const reason = {};
  Object.defineProperty(reason, 'kind', { get() { reads++; return 'stop'; } });
  for (const chunks of [
    [{ type: 'block-end', index: 0, block }, { type: 'finish', reason: { kind: 'stop' } }],
    [...textStream(JSON.stringify(decision())).slice(0, -1), { type: 'finish', reason }],
    [new Proxy({}, { getPrototypeOf() { throw new Error('secret'); } })],
  ]) await assert.rejects(review(chunks), (e) => safeError(e, 'MEMORY_REVIEW_STREAM_FAILED'));
  assert.equal(reads, 0);
});

for (const chunk of [
  { type: 'reasoning-delta', index: 0, text: 'secret reasoning' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'secret reasoning' } },
  { type: 'block-start', index: 2, blockType: 'reasoning' },
]) test(`rejects ${chunk.type} reasoning after the text phase begins`, async () => {
  await assert.rejects(review([
    { type: 'reasoning-delta', index: 0, text: 'secret prefix' },
    { type: 'text-delta', index: 1, text: JSON.stringify(decision()) },
    chunk,
    { type: 'finish', reason: { kind: 'stop' } },
  ]), (e) => safeError(e, 'MEMORY_REVIEW_STREAM_FAILED'));
});

test('completed reasoning blocks then one text block still succeed', async () => {
  const raw = JSON.stringify(decision());
  assert.deepEqual((await review([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'first' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'first' } },
    { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'second' } },
    { type: 'block-start', index: 2, blockType: 'text' },
    { type: 'text-delta', index: 2, text: raw },
    { type: 'block-end', index: 2, block: { type: 'text', text: raw } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])).discard, ['e3']);
});

for (const chunk of [
  { type: 'reasoning-delta', index: 0, text: 'secret extra' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'secret extra' } },
]) test(`rejects ${chunk.type} for an already completed reasoning block`, async () => {
  await assert.rejects(review([
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'secret original' } },
    chunk,
    { type: 'text-delta', index: 1, text: JSON.stringify(decision()) },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), (e) => safeError(e, 'MEMORY_REVIEW_STREAM_FAILED'));
});
