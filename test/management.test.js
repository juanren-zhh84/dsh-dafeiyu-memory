import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { MemoryDatabase } from '../src/storage/database.js';
import { apply } from '../src/index.js';
import { createTempHome } from './helpers/temp-home.js';
import { createFakeContext } from './helpers/fake-context.js';
import { eventInput, NOW } from './fixtures/events.js';

async function setup(t) {
  const ctx = createFakeContext(); let route; let released = 0;
  ctx.webServer = { register: (value) => { route = value; return () => released++; } };
  await apply(ctx, {}, { dshHome: createTempHome(), clock: { now: () => NOW },
    timer: { setTimeout: () => 1, clearTimeout() {} }, reviewModel: { review: async () => ({ retain: [], diary: [], discard: [] }) } });
  t.after(async () => { for (const dispose of [...ctx.disposers].reverse()) await dispose(); });
  const service = ctx.get('dafeiyuMemory');
  async function request(path, body = {}, method = 'POST', options = {}) {
    assert.ok(route, 'management API must be registered with the host');
    assert.equal(route.kind, 'prefix');
    const req = Readable.from([options.raw ?? JSON.stringify(body)]);
    Object.assign(req, { method, url: '/dafeiyu-memory/api' + path,
      headers: { host: '127.0.0.1:3210', 'content-type': 'application/json', origin: 'http://127.0.0.1:3210', ...options.headers },
      socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' } });
    let result;
    const res = { setHeader() {}, end(text) { result = JSON.parse(text); } };
    await route.handler(req, res);
    return { status: res.statusCode, body: result };
  }
  return { ctx, service, request, route: () => route, released: () => released };
}

test('management status publishes counts, task times, capacity and connector observations without private data', async (t) => {
  const s = await setup(t);
  await s.service.recordEvent(eventInput({ actorKey: 'raw-account-secret', contentText: '正文绝不可出现在状态' }));
  const response = await s.request('/status', {}, 'GET');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.counts, { short: 1, long: 0, diary: 0, recycle: 0 });
  assert.equal(response.body.tasks.pending, 0);
  assert.equal(response.body.tasks.nextAt, NOW + 7 * 86400000);
  assert.equal(typeof response.body.capacity.databaseBytes, 'number');
  assert.equal(response.body.connectors.qq.code, 'observed');
  assert.equal(response.body.connectors.douyin.code, 'optional-unobserved');
  assert.doesNotMatch(JSON.stringify(response.body), /raw-account-secret|正文|sqlite|[A-Z]:\\|actorKey/);
});

test('search requires explicit management scope, returns metadata only, detail is fetched separately', async (t) => {
  const s = await setup(t); const event = await s.service.recordEvent(eventInput({ contentText: '私密正文匹配词', actorKey: 'secret-actor' }));
  await assert.rejects(s.service.search({ query: '匹配词' }), { code: 'MEMORY_INVALID_INPUT' });
  assert.equal((await s.request('/search', { query: '匹配词' })).status, 400);
  const response = await s.request('/search', { context: 'management', query: '匹配词', layer: 'all' });
  assert.equal(response.status, 200); assert.equal(response.body.items[0].id, event.id);
  assert.equal(response.body.items[0].actor, '已隐藏');
  assert.doesNotMatch(JSON.stringify(response.body), /私密正文|secret-actor|conversationKey|actorKey/);
  const detail = await s.request('/detail', { context: 'management', kind: 'event', id: event.id });
  assert.equal(detail.body.content, '私密正文匹配词');
  assert.doesNotMatch(JSON.stringify(detail.body), /secret-actor/);
  assert.equal((await s.request('/detail', { context: 'management', kind: 'event', id: 'absent' })).status, 404);
});

test('every write is POST only and hostile requests produce stable code-only errors', async (t) => {
  const s = await setup(t);
  for (const path of ['/search', '/detail', '/recycle/restore', '/recycle/purge', '/diary/promote', '/backup', '/review/run']) {
    assert.deepEqual(await s.request(path, {}, 'GET'), { status: 405, body: { code: 'MEMORY_METHOD_NOT_ALLOWED' } });
  }
  for (const raw of ['{"__proto__":{"polluted":1}}', '{"constructor":{}}', '{', '[]', '{"unknown":1}', '"' + 'x'.repeat(17000) + '"']) {
    const response = await s.request('/backup', {}, 'POST', { raw });
    assert.ok([400, 413].includes(response.status)); assert.deepEqual(Object.keys(response.body), ['code']);
  }
  const { validateFields } = await import('../src/management/projection.js');
  for (const value of [Object.create({ query: 'secret' }), { get query() { throw new Error('must not run'); } }, new Date()]) {
    assert.throws(() => validateFields(value, ['query']), { code: 'MEMORY_INVALID_INPUT' });
  }
  assert.equal((await s.request('/backup', {}, 'POST', { headers: { origin: 'https://other.test' } })).status, 403);
  assert.equal((await s.request('/status', {}, 'GET', { remoteAddress: '10.0.0.1' })).status, 403);
  assert.equal((await s.request('/backup', {}, 'POST', { headers: { 'content-type': 'text/plain' } })).status, 415);
  s.service.backup = async () => { throw Object.assign(new Error('private body C:\\secret'), { code: 'SQLITE_C:\\secret' }); };
  assert.deepEqual(await s.request('/backup'), { status: 500, body: { code: 'MEMORY_INTERNAL_ERROR' } });
});

test('permanent delete requires exact target phrase and current recycle state, repeats are idempotent', async (t) => {
  const s = await setup(t); const event = await s.service.recordEvent(eventInput());
  const input = { kind: 'event', id: event.id, confirmation: `永久删除 ${event.id}` };
  assert.equal((await s.request('/recycle/purge', input)).status, 409);
  await s.service.repository.moveToRecycle({ kind: 'event', id: event.id });
  assert.equal((await s.request('/recycle/purge', { ...input, confirmation: '永久删除' })).status, 400);
  assert.equal(s.service.status().events.recycle, 1);
  const results = await Promise.all([s.request('/recycle/purge', input), s.request('/recycle/purge', input)]);
  assert.deepEqual(results.map((r) => r.body.deleted).sort(), [0, 1]);
  assert.equal(s.service.status().events.recycle, 0);
  assert.equal((await s.service.recordEvent(eventInput())).purged, true);
});

test('manual delete rechecks restored state after backup and backup failure preserves the target', async (t) => {
  const s = await setup(t); const event = await s.service.recordEvent(eventInput());
  await s.service.repository.moveToRecycle({ kind: 'event', id: event.id });
  const input = { kind: 'event', id: event.id, confirmation: `永久删除 ${event.id}` };
  const create = s.service.backupManager.createUnlocked.bind(s.service.backupManager);
  s.service.backupManager.createUnlocked = async () => { throw Object.assign(new Error('private'), { code: 'MEMORY_BACKUP_FAILED' }); };
  assert.deepEqual(await s.request('/recycle/purge', input), { status: 503, body: { code: 'MEMORY_BACKUP_FAILED' } });
  assert.equal(s.service.status().events.recycle, 1);
  const other = await MemoryDatabase.open(s.service.paths.database); t.after(() => other.close());
  s.service.backupManager.createUnlocked = async (...args) => {
    const result = await create(...args);
    await other.write((db) => db.prepare("UPDATE memory_events SET state='active',purge_due_at=NULL,version=version+1 WHERE id=?").run(event.id));
    return result;
  };
  assert.equal((await s.request('/recycle/purge', input)).body.deleted, 0);
  assert.equal(s.service.status().events.active, 1);
  assert.equal(s.service.database.read((db) => db.prepare('SELECT count(*) AS n FROM purge_ledger').get().n), 0);
});

test('hostile error code values never execute conversion hooks or escape the code-only boundary', async (t) => {
  const s = await setup(t); let touched = false;
  s.service.backup = async () => { throw { code: { toString() { touched = true; throw new Error('secret'); } } }; };
  assert.deepEqual(await s.request('/backup'), { status: 500, body: { code: 'MEMORY_INTERNAL_ERROR' } });
  assert.equal(touched, false);
});

test('real chunked HTTP over the body limit still receives a stable JSON 413 response', async (t) => {
  const s = await setup(t);
  const server = createServer((req, res) => s.route().handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/dafeiyu-memory/api/backup',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.write('"' + 'x'.repeat(9000)); req.end('x'.repeat(9000) + '"');
  });
  assert.deepEqual(result, { status: 413, body: { code: 'MEMORY_BODY_TOO_LARGE' } });
});

test('management list has bounded stable pages and explicit layer filtering', async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 53; i++) await s.service.recordEvent(eventInput({ sourceKey: `page-${i}` }));
  const first = await s.service.search({ context: 'management', query: '', layer: 'short' });
  const second = await s.service.search({ context: 'management', query: '', layer: 'short', offset: 50 });
  assert.equal(first.items.length, 50); assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 3); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map((row) => row.id)).size, 53);
  assert.equal((await s.service.search({ context: 'management', query: '', layer: 'diary' })).items.length, 0);
});

test('optional host injection mounts a later webserver and releases it while core stays available', async () => {
  const root = new Context(); let registered = 0; let disposed = 0;
  const fiber = await root.plugin((ctx) => apply(ctx, {}, { dshHome: createTempHome(),
    timer: { setTimeout: () => 1, clearTimeout() {} } }));
  const service = root.get('dafeiyuMemory');
  try {
    assert.equal(service.status().state, 'ready');
    const provider = await root.plugin((ctx) => { ctx.provide('webServer', { register: () => { registered++; return () => disposed++; } }); });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registered, 1);
    await provider.dispose(); assert.equal(disposed, 1); assert.equal(service.status().state, 'ready');
  } finally { await fiber.dispose(); }
});

test('restore, long-term diary promotion, manual backup and review operate through the host route', async (t) => {
  const s = await setup(t); const event = await s.service.recordEvent(eventInput());
  await s.service.repository.moveToRecycle({ kind: 'event', id: event.id });
  const recycle = await s.request('/search', { context: 'management', query: '', layer: 'recycle' });
  assert.equal(recycle.body.items.length, 1);
  const restored = await s.request('/recycle/restore', { kind: 'event', id: event.id });
  assert.equal(restored.status, 200); assert.doesNotMatch(JSON.stringify(restored.body), /我喜欢钓鱼/);
  await s.service.database.write((db) => db.prepare(`INSERT INTO memory_items
    (id,kind,subject_key,subject_name,content,importance,confidence,visibility,promoted_at,expires_at,state,source_refs_json,created_at,updated_at)
    VALUES ('long-1','fact','secret','secret','长期正文',0.5,1,'owner-private',?,?,'active','[]',?,?)`).run(NOW, NOW + 1000, NOW, NOW));
  const diary = await s.request('/diary/promote', { id: 'long-1' });
  assert.equal(diary.status, 200); assert.equal(s.service.status().diary, 1);
  assert.doesNotMatch(JSON.stringify(diary.body), /长期正文|secret/);
  assert.equal((await s.request('/backup')).status, 200);
  assert.equal((await s.request('/review/run')).status, 200);
});

test('client is a lazy host React factory, registers once and releases slot and stylesheet', () => {
  assert.ok(existsSync(new URL('../client.js', import.meta.url)), 'settings client must exist');
  let descriptor; let registered = 0; let injected = 0; let disposed = 0; let removed = 0; let renderer;
  const sandbox = { window: { __ModuleLoader__: { load(value) { descriptor = value; } } },
    document: { createElement: () => ({ setAttribute() {}, remove: () => removed++ }), head: { appendChild() {} } } };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
  assert.equal(descriptor.id, 'dsh-dafeiyu-memory');
  const plugin = descriptor.factory((name) => { assert.equal(name, 'react'); return { createElement: (type) => ({ type }) }; });
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale']);
  const ctx = createFakeContext();
  const slots = { inject(name, fn) { injected++; fn(); return () => disposed++; },
    register(meta, render) { registered++; assert.equal(meta.name, 'settings.section'); renderer = render; return () => disposed++; } };
  ctx.get = (name) => name === 'slots' ? slots : { t: (text) => text };
  plugin.apply(ctx); plugin.apply(ctx);
  assert.equal(injected, 1); assert.equal(registered, 1); assert.ok(renderer().type);
  ctx.disposers.forEach((dispose) => dispose()); assert.equal(disposed, 2); assert.equal(removed, 1);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.exports['./client'], './client.js'); assert.ok(pkg.files.includes('client.js')); assert.equal(pkg.dsh.client.platform, 'web');
});

// Browser packages are test-only, supplied by the caller; the plugin never bundles React or Playwright.
test('desktop and mobile ledger renders, wraps, expands bodies and enforces deletion confirmation', {
  skip: !process.env.MANAGEMENT_VISUAL_RUNTIME || !process.env.MANAGEMENT_PLAYWRIGHT_PATH
    ? 'Set MANAGEMENT_VISUAL_RUNTIME (React 18 UMD directory) and MANAGEMENT_PLAYWRIGHT_PATH to an existing Playwright entry' : false,
}, async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.MANAGEMENT_PLAYWRIGHT_PATH).href);
  const assets = {
    '/react.js': readFileSync(join(process.env.MANAGEMENT_VISUAL_RUNTIME, 'node_modules/react/umd/react.development.js')),
    '/react-dom.js': readFileSync(join(process.env.MANAGEMENT_VISUAL_RUNTIME, 'node_modules/react-dom/umd/react-dom.development.js')),
    '/client.js': readFileSync(new URL('../client.js', import.meta.url)),
  };
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>:root{--dsw-alias-label-primary:#263239;--dsw-alias-label-secondary:#6d7479;--dsw-alias-background-primary:#fff;--dsw-alias-border-primary:#d9dddf}
    body{margin:0;font:14px 'Microsoft YaHei',sans-serif;background:#fff}main{padding:24px;max-width:1440px;margin:auto}@media(max-width:520px){main{padding:16px}}</style>
    <main id="root"></main><script src="/react.js"></script><script src="/react-dom.js"></script>
    <script>window.__ModuleLoader__={load(d){window.plugin=d.factory(n=>React)}};</script><script src="/client.js"></script>
    <script>window.root=ReactDOM.createRoot(document.getElementById('root'));window.disposers=[];
    const slots={inject(n,f){f();return ()=>{}},register(meta,render){root.render(React.createElement(React.StrictMode,null,render()));return ()=>root.unmount()}};
    plugin.apply({get:n=>n==='slots'?slots:{},effect:f=>disposers.push(f())});</script></html>`;
  const server = createServer((req, res) => { res.setHeader('content-type', assets[req.url] ? 'text/javascript' : 'text/html'); res.end(assets[req.url] ?? html); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ channel: process.env.MANAGEMENT_BROWSER_CHANNEL || 'msedge', headless: true });
  t.after(() => browser.close());
  const output = mkdtempSync(join(tmpdir(), 'dafeiyu-management-visual-'));
  t.diagnostic(`Visual screenshots: ${output}`);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    try {
      const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
      let detailRequests = 0; let purgeRequests = 0; let recycle = true;
      const id = '合成编号-' + '0123456789abcdef'.repeat(5);
      const metadata = { id, kind: 'event', source: 'qq', state: 'recycle', time: NOW, version: 2, actor: '已隐藏' };
      const longError = 'MEMORY_' + 'ERROR_'.repeat(12);
      await page.route('**/dafeiyu-memory/api/**', async (route) => {
        const path = new URL(route.request().url()).pathname.split('/api')[1];
        let data; let status = 200;
        if (path === '/status') data = { code: 'ready', counts: { short: 128, long: 36, diary: 12, recycle: recycle ? 1 : 0 },
          tasks: { pending: 3, failed: 0, nextAt: NOW }, capacity: { databaseBytes: 5000000, backupsBytes: 10000000, spoolBytes: 1000, totalBytes: 15001000, limitBytes: 1073741824 },
          connectors: { qq: { code: 'observed', lastAt: NOW }, pet: { code: 'observed', lastAt: NOW }, douyin: { code: 'optional-unobserved', lastAt: null } } };
        if (path === '/search') data = { items: recycle ? [metadata] : [], hasMore: false, offset: 0 };
        if (path === '/detail') { detailRequests++; data = { content: '只在主动展开后显示的合成正文。' }; }
        if (path === '/backup') { status = 503; data = { code: longError }; }
        if (path === '/recycle/purge') { purgeRequests++; assert.equal(route.request().postDataJSON().confirmation, `永久删除 ${id}`); recycle = false; data = { deleted: 1 }; }
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data ?? {}) });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByRole('button', { name: '展开正文', exact: true }).waitFor();
      assert.equal(detailRequests, 0);
      await page.getByRole('button', { name: '展开正文', exact: true }).click();
      await page.getByText('只在主动展开后显示的合成正文。', { exact: true }).waitFor();
      assert.equal(detailRequests, 1);
      await page.getByRole('button', { name: '永久删除', exact: true }).click();
      const destructive = page.getByRole('button', { name: '确认永久删除', exact: true });
      assert.equal(await destructive.isDisabled(), true);
      await page.getByRole('textbox', { name: '永久删除确认短语' }).fill('永久删除');
      assert.equal(await destructive.isDisabled(), true); assert.equal(purgeRequests, 0);
      await page.getByRole('textbox', { name: '永久删除确认短语' }).fill(`永久删除 ${id}`);
      assert.equal(await destructive.isEnabled(), true);
      await page.getByRole('button', { name: '立即备份' }).click();
      await page.getByRole('status').filter({ hasText: longError }).waitFor();
      const bounds = await page.evaluate(() => {
        const invalid = [...document.querySelectorAll('[data-memory] *')].filter((element) => {
          const r = element.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1);
        }).map((element) => element.tagName + ':' + element.className);
        const buttons = [...document.querySelectorAll('[data-memory] button')].map((element) => element.getBoundingClientRect());
        let overlaps = 0;
        for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
          const a = buttons[i]; const b = buttons[j];
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps++;
        }
        return { width: document.documentElement.scrollWidth, viewport: innerWidth, invalid, overlaps, content: document.querySelector('[data-memory]').textContent.length };
      });
      assert.ok(bounds.content > 200); assert.ok(bounds.width <= bounds.viewport); assert.deepEqual(bounds.invalid, []); assert.equal(bounds.overlaps, 0);
      await page.screenshot({ path: join(output, `${viewport.width}x${viewport.height}.png`), fullPage: true });
      await destructive.click();
      await page.getByText('已永久删除', { exact: true }).waitFor();
      assert.equal(purgeRequests, 1);
      await page.evaluate(() => window.disposers.forEach((dispose) => dispose()));
      assert.equal(await page.locator('[data-memory]').count(), 0);
      assert.equal(await page.locator('style[data-plugin-css="dsh-dafeiyu-memory"]').count(), 0);
      assert.deepEqual(pageErrors, []);
    } finally { await page.close(); }
  }
});
