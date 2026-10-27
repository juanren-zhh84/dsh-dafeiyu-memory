import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { importCore } from '../scripts/import-existing.mjs';
import { MemoryDatabase } from '../src/storage/database.js';
import { ImportManager } from '../src/importers/index.js';
import { parseAurabot } from '../src/importers/aurabot.js';
import { resolveConfig } from '../src/config.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const repo = fileURLToPath(new URL('../', import.meta.url));
const verifier = join(repo, 'scripts/verify-local-install.ps1');
const verify = (root, strict = false) => JSON.parse(spawnSync('pwsh', ['-NoProfile', '-File', verifier, '-DshHome', root, ...(strict ? ['-RequireActivated'] : [])], { encoding: 'utf8' }).stdout);

function home(t) { const root = mkdtempSync(join(tmpdir(), 'task12-review-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function source(root, text = 'synthetic first') {
  const file = join(root, 'plugins-data/aurabot/chatlog/2026-10-27.jsonl'); mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ t: 1800000000000, chatId: 'group:synthetic', uid: 'fixture', who: 'fixture', text })); return file;
}
test('actual import consumes only the preflight fingerprinted immutable source snapshot', async t => {
  const root = home(t); const file = source(root), original = readFileSync(file);
  const run = ImportManager.prototype.importExisting;
  t.mock.method(ImportManager.prototype, 'importExisting', async function(options) {
    if (options.dryRun) return run.call(this, options);
    source(root, 'synthetic transient change');
    try { return await run.call(this, options); } finally { writeFileSync(file, original); }
  });
  assert.equal((await importCore({ dshHome: root, apply: true })).ok, true);
  const db = new DatabaseSync(join(root, 'dafeiyu-memory/memory.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT content_text FROM memory_events').get().content_text, 'synthetic first'); } finally { db.close(); }
});
test('dummy tables with current user_version are UNKNOWN_TARGET before dry-run or apply', async t => {
  const root = home(t), target = join(root, 'dafeiyu-memory/memory.sqlite'); mkdirSync(join(target, '..'));
  const db = new DatabaseSync(target);
  for (const name of ['memory_events', 'memory_items', 'diary_entries', 'review_jobs', 'import_ledger', 'purge_ledger', 'schema_meta']) db.exec(`CREATE TABLE ${name}(id TEXT)`);
  db.exec('PRAGMA user_version=2'); db.close();
  const original = readFileSync(target);
  const checked = JSON.parse(spawnSync(process.execPath, [join(repo, 'scripts/inspect-local-database.mjs'), target], { encoding: 'utf8' }).stdout);
  assert.equal(checked.code, 'DATABASE_SCHEMA_INVALID'); assert.deepEqual(readFileSync(target), original);
  for (const apply of [false, true]) {
    await assert.rejects(importCore({ dshHome: root, apply }), { code: 'UNKNOWN_TARGET' });
    assert.deepEqual(readFileSync(target), original);
  }
});
for (const [name, sql] of [['index', 'DROP INDEX memory_events_due'], ['migration marker', "UPDATE schema_meta SET value='incomplete' WHERE key='migration_state'"]]) {
  test(`canonical target validation rejects changed ${name} without touching the database`, async t => {
    const root = home(t); await importCore({ dshHome: root, apply: true });
    const target = join(root, 'dafeiyu-memory/memory.sqlite'), db = new DatabaseSync(target); db.exec(sql); db.close();
    const original = readFileSync(target);
    await assert.rejects(importCore({ dshHome: root, apply: false }), { code: 'UNKNOWN_TARGET' });
    assert.deepEqual(readFileSync(target), original);
  });
}
for (const field of ['chatId', 'uid']) {
  test(`Aurabot qzone rejects inherited ${field} without touching its getter`, () => {
    let touched = 0;
    Object.defineProperty(Object.prototype, field, { configurable: true, get() { touched++; return field === 'chatId' ? 'qzone' : 'synthetic'; } });
    try {
      const row = { t: 1800000000000, chatId: 'qzone', uid: 'synthetic', who: 'fixture', text: 'synthetic' }; delete row[field];
      assert.throws(() => parseAurabot(Buffer.from(JSON.stringify(row)), 'chatlog/synthetic.jsonl', resolveConfig()), { code: 'INVALID_SOURCE' });
      assert.equal(touched, 0);
    } finally { delete Object.prototype[field]; }
  });
}
test('Aurabot snapshots all row and root own data properties before accessing any field', t => {
  for (const logical of ['memories.json', 'diary.json', 'chatlog/synthetic.jsonl']) {
    let touched = 0; const row = { t: 1800000000000, chatId: 'qzone', uid: 'fixture', who: 'fixture', text: 'synthetic', at: 1800000000000 };
    Object.defineProperty(row, logical.startsWith('chatlog') ? 'uid' : 'at', { enumerable: true, get() { touched++; return 1800000000000; } });
    const root = logical === 'memories.json' ? { items: [row] } : logical === 'diary.json' ? { history: [row] } : row;
    const mock = t.mock.method(JSON, 'parse', () => root);
    try { assert.throws(() => parseAurabot(Buffer.from('{}'), logical, resolveConfig()), { code: 'INVALID_SOURCE' }); assert.equal(touched, 0); }
    finally { mock.mock.restore(); }
  }
});
test('pet verification anchors canonical source instead of accepting three forged files and recalculated state hashes', t => {
  const root = home(t), pet = join(root, 'sources/dsh-pet-unified-memory'); mkdirSync(join(pet, 'src/host'), { recursive: true });
  const git = args => execFileSync('git', ['-C', pet, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  writeFileSync(join(pet, 'package.json'), JSON.stringify({ name: 'dsh-pet', version: '0.3.8' }));
  writeFileSync(join(pet, '.gitignore'), 'lib/\n'); writeFileSync(join(pet, 'src/host/index.ts'), 'synthetic upstream');
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']); git(['tag', 'v0.3.8']);
  const remote = 'https://github.com/PC2005-cloud/dsh-pet.git'; git(['remote', 'add', 'origin', remote]);
  const files = ['src/host/index.ts', 'src/host/unified-memory.ts', 'src/host/unified-memory.test.ts'].map(path => {
    writeFileSync(join(pet, path), 'synthetic forged source'); return { path, hash: createHash('sha256').update(readFileSync(join(pet, path))).digest('hex') };
  });
  mkdirSync(join(pet, 'lib')); writeFileSync(join(pet, 'lib/index.js'), 'synthetic fake build');
  const patchHash = createHash('sha256').update(readFileSync(join(repo, 'integrations/dsh-pet/patches/0.3.8-unified-memory.patch'))).digest('hex');
  writeFileSync(join(pet, '.git/dafeiyu-unified-memory.json'), JSON.stringify({ packageRelative: '', tag: 'v0.3.8', patchHash, baseCommit: git(['rev-parse', 'HEAD']), remote, files }));
  const report = verify(root); assert.equal(report.checks.find(x => x.code === 'PET_PREPARED').status, 'fail');
});
test('canonical pet patch with the exact allowed git status remains build-pending and any extra file fails', t => {
  const root = home(t), pet = join(root, 'sources/dsh-pet-unified-memory'); mkdirSync(join(pet, 'src/host'), { recursive: true });
  const git = args => execFileSync('git', ['-C', pet, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  writeFileSync(join(pet, 'package.json'), readFileSync(join(repo, 'test/fixtures/pet/upstream-package.json')));
  writeFileSync(join(pet, 'src/host/index.ts'), readFileSync(join(repo, 'test/fixtures/pet/upstream-chat-0.3.8.ts')));
  git(['init', '-q']); git(['config', 'core.autocrlf', 'false']); git(['add', '.']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']); git(['tag', 'v0.3.8']);
  const remote = 'https://github.com/PC2005-cloud/dsh-pet.git'; git(['remote', 'add', 'origin', remote]);
  const patch = join(repo, 'integrations/dsh-pet/patches/0.3.8-unified-memory.patch'); git(['apply', patch]);
  const files = ['src/host/index.ts', 'src/host/unified-memory.ts', 'src/host/unified-memory.test.ts'].map(path => ({ path, hash: createHash('sha256').update(readFileSync(join(pet, path))).digest('hex') }));
  writeFileSync(join(pet, '.git/dafeiyu-unified-memory.json'), JSON.stringify({ packageRelative: '', tag: 'v0.3.8', patchHash: createHash('sha256').update(readFileSync(patch)).digest('hex'), baseCommit: git(['rev-parse', 'HEAD']), remote, files }));
  const prepared = verify(root).checks.find(x => x.code === 'PET_PREPARED');
  assert.equal(prepared.status, 'pending'); assert.equal(prepared.details.code, 'BUILD_PENDING');
  writeFileSync(join(pet, 'extra.txt'), 'synthetic change');
  assert.equal(verify(root).checks.find(x => x.code === 'PET_PREPARED').status, 'fail');
});
test('strict activation rejects registry versions and nonexistent paths containing a plausible pet directory name', t => {
  const root = home(t), profile = join(root, 'profiles/desktop/package.json'); mkdirSync(join(profile, '..'), { recursive: true });
  writeFileSync(profile, JSON.stringify({ dependencies: { 'dsh-dafeiyu-memory': '0.0.0-wrong', 'dsh-pet': 'file:../../sources/wrong/dsh-pet-unified-memory' } }));
  const report = verify(root, true);
  for (const code of ['CORE_ACTIVATION', 'PET_ACTIVATION']) assert.equal(report.checks.find(x => x.code === code).status, 'fail');
});
test('activation resolves profile-relative nested pet package paths and validates package identity', t => {
  const root = home(t), profile = join(root, 'profiles/desktop/package.json'), pet = join(root, 'sources/dsh-pet-unified-memory/dsh-pet');
  mkdirSync(join(profile, '..'), { recursive: true }); mkdirSync(pet, { recursive: true });
  writeFileSync(join(pet, 'package.json'), JSON.stringify({ name: 'dsh-pet', version: '0.3.8' }));
  writeFileSync(profile, JSON.stringify({ dependencies: { 'dsh-dafeiyu-memory': `file:${repo}`, 'dsh-pet': 'file:../../sources/dsh-pet-unified-memory/dsh-pet' } }));
  let report = verify(root, true);
  for (const code of ['CORE_ACTIVATION', 'PET_ACTIVATION']) assert.equal(report.checks.find(x => x.code === code).status, 'pass');
  writeFileSync(join(pet, 'package.json'), JSON.stringify({ name: 'dsh-pet', version: '0.0.0-wrong' }));
  report = verify(root, true); assert.equal(report.checks.find(x => x.code === 'PET_ACTIVATION').status, 'fail');
});
for (const existing of [false, true]) {
  test(`source race at actual database open leaves ${existing ? 'existing' : 'new'} target entirely unchanged`, async t => {
    const root = home(t), target = join(root, 'dafeiyu-memory/memory.sqlite');
    if (existing) assert.equal((await importCore({ dshHome: root, apply: true })).ok, true);
    const original = existing ? readFileSync(target) : undefined; const file = source(root);
    const open = MemoryDatabase.open; let touched = 0;
    t.mock.method(MemoryDatabase, 'open', async function(path, ...args) {
      const result = await open.call(this, path, ...args);
      if (path.endsWith('memory.sqlite')) { touched++; source(root, 'synthetic changed at open'); }
      return result;
    });
    await assert.rejects(importCore({ dshHome: root, apply: true }), { code: 'SOURCE_CHANGED' });
    assert.equal(touched, 1); assert.ok(readFileSync(file, 'utf8').includes('changed at open'));
    if (existing) assert.deepEqual(readFileSync(target), original); else assert.equal(existsSync(target), false);
  });
  test(`source addition after staged import leaves ${existing ? 'existing' : 'new'} target records unchanged`, async t => {
    const root = home(t), target = join(root, 'dafeiyu-memory/memory.sqlite');
    if (existing) await importCore({ dshHome: root, apply: true });
    const original = existing ? readFileSync(target) : undefined; source(root);
    const run = ImportManager.prototype.importExisting;
    t.mock.method(ImportManager.prototype, 'importExisting', async function(options) {
      const result = await run.call(this, options);
      if (!options.dryRun) writeFileSync(join(root, 'plugins-data/aurabot/diary.json'), JSON.stringify({ history: [{ at: 1800000000000, text: 'synthetic addition' }] }));
      return result;
    });
    await assert.rejects(importCore({ dshHome: root, apply: true }), { code: 'SOURCE_CHANGED' });
    if (existing) assert.deepEqual(readFileSync(target), original); else assert.equal(existsSync(target), false);
  });
}
