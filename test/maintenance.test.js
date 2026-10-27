import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { apply } from '../src/index.js';
import { resolveConfig } from '../src/config.js';
import { createTempHome } from './helpers/temp-home.js';
import { createFakeContext } from './helpers/fake-context.js';
import { eventInput, NOW, DAY } from './fixtures/events.js';

async function setup(t, maintenance = {}, config = {}) {
  const ctx = createFakeContext();
  const time = { value: NOW };
  await apply(ctx, config, { dshHome: createTempHome(), clock: { now: () => time.value }, maintenance });
  const service = ctx.get('dafeiyuMemory');
  t.after(() => service.dispose());
  await service.scheduler.start();
  await service.writeQueue.drain();
  return { service, time, rows: (table) => service.database.read((db) => db.prepare(`SELECT * FROM ${table}`).all()) };
}

test('maintenance defaults and strict bounds are enforced', () => {
  const config = resolveConfig();
  assert.equal(config.backupRetentionDays, 30);
  assert.equal(config.backupLimitBytes, 268435456);
  assert.equal(config.spoolLimitBytes, 16777216);
  assert.equal(config.spoolMaxEntries, 10000);
  assert.equal(config.purgeBatchSize, 100);
  assert.equal(config.incrementalVacuumFreeRatio, 0.2);
  for (const [name, values] of Object.entries({ backupRetentionDays: [0, 1.5, '30'], backupLimitBytes: [33554431, Infinity],
    spoolLimitBytes: [1048575, NaN], spoolMaxEntries: [0, 1.5], purgeBatchSize: [0, 101], incrementalVacuumFreeRatio: [0, 1.1, '0.2'] })) {
    for (const value of values) assert.throws(() => resolveConfig({ [name]: value }), { code: 'MEMORY_INVALID_CONFIG' });
  }
});

test('official SQLite backup creates a readable snapshot and a metadata-only manifest', async (t) => {
  const { service } = await setup(t);
  await service.recordEvent(eventInput());
  const result = await service.backup();
  assert.deepEqual(Object.keys(result).sort(), ['id', 'overLimit', 'protected', 'reason', 'sha256', 'size', 'time']);
  assert.equal(result.reason, 'manual');
  const path = join(service.paths.backups, `${result.id}.sqlite`);
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), result.sha256);
  const db = new DatabaseSync(path);
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM memory_events').get().n, 1); } finally { db.close(); }
  const manifest = JSON.parse(readFileSync(join(service.paths.backups, 'manifest.json')));
  const { overLimit, ...record } = result;
  assert.equal(overLimit, false);
  assert.deepEqual(manifest, [record]);
  assert.equal(JSON.stringify(manifest).includes('钓鱼'), false);
  assert.equal(JSON.stringify(manifest).includes(service.paths.root), false);
  assert.equal(readdirSync(service.paths.backups).some((name) => name.endsWith('.tmp')), false);
});

test('purge backs up first, removes only due recycle and records irreversible hashes without deleting import ledger', async (t) => {
  const { service, time, rows } = await setup(t);
  const due = await service.recordEvent(eventInput());
  await service.repository.moveToRecycle({ kind: 'event', id: due.id });
  await service.recordEvent(eventInput({ sourceKey: 'active' }));
  await service.promoteToDiary({ title: '日记', body: '永久保留' });
  await service.database.write((db) => {
    db.prepare('INSERT INTO memory_recall_days VALUES (?, ?, ?)').run('event', due.id, 1);
    db.prepare('INSERT INTO import_ledger VALUES (?, ?, ?, ?, ?, ?, ?)').run('qq', due.externalKey, 'hash', 'ok', 'event', due.id, NOW);
  });
  assert.equal((await service.purgeRecycleItem()).deleted, 0);
  time.value += 7 * DAY;
  assert.equal((await service.purgeRecycleItem()).deleted, 1);
  assert.equal(rows('memory_events').length, 1);
  assert.equal(rows('diary_entries').length, 1);
  assert.equal(rows('memory_recall_days').length, 0);
  assert.equal(rows('import_ledger').length, 1);
  assert.deepEqual(rows('purge_ledger').map((r) => ({ ...r })), [{ object_kind: 'event',
    source_hash: createHash('sha256').update(`event\0${due.externalKey}`).digest('hex'), purged_at: time.value }]);
  const manifest = JSON.parse(readFileSync(join(service.paths.backups, 'manifest.json')));
  const backup = new DatabaseSync(join(service.paths.backups, `${manifest[0].id}.sqlite`));
  try { assert.equal(backup.prepare('SELECT count(*) AS n FROM memory_events').get().n, 2); } finally { backup.close(); }
});

test('backup failure deletes zero, cleans temporary files and does not poison chat writes', async (t) => {
  const { service, time, rows } = await setup(t, { backup: async (_db, path) => {
    writeFileSync(path, 'partial'); throw new Error('secret body account C:\\private');
  } });
  const event = await service.recordEvent(eventInput());
  await service.repository.moveToRecycle({ kind: 'event', id: event.id });
  time.value += 7 * DAY;
  await assert.rejects(service.purgeRecycleItem(), (error) => {
    assert.equal(error.code, 'MEMORY_BACKUP_FAILED');
    assert.equal(JSON.stringify(error).includes('secret'), false); return true;
  });
  assert.equal(rows('memory_events').length, 1);
  assert.equal(rows('purge_ledger').length, 0);
  assert.deepEqual(readdirSync(service.paths.backups), []);
  await service.recordEvent(eventInput({ sourceKey: 'still-working' }));
  assert.equal(rows('memory_events').length, 2);
});

test('retention removes old unprotected backups but migration protection survives until explicit release', async (t) => {
  const { service, time } = await setup(t);
  const protectedBackup = await service.backupManager.create('migration', true);
  const old = await service.backup();
  time.value += 31 * DAY;
  const latest = await service.backup();
  assert.equal(typeof service.backupManager.prune, 'function');
  await service.backupManager.prune();
  assert.equal(existsSync(join(service.paths.backups, `${old.id}.sqlite`)), false);
  assert.equal(existsSync(join(service.paths.backups, `${protectedBackup.id}.sqlite`)), true);
  assert.equal(existsSync(join(service.paths.backups, `${latest.id}.sqlite`)), true);
  await service.backupManager.releaseProtectedBackup(protectedBackup.id);
  await service.backupManager.prune();
  assert.equal(existsSync(join(service.paths.backups, `${protectedBackup.id}.sqlite`)), false);
});

test('backup capacity removes oldest ordinary files and keeps protected files even over limit', async (t) => {
  const { service, time } = await setup(t, {}, { backupLimitBytes: 32 * 1024 ** 2 });
  const protectedBackup = await service.backupManager.create('migration', true);
  time.value++;
  const ordinary = await service.backup();
  const manifestPath = join(service.paths.backups, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  // Real sparse files exercise accounting without large resident test data.
  const { truncateSync } = await import('node:fs');
  truncateSync(join(service.paths.backups, `${protectedBackup.id}.sqlite`), 34 * 1024 ** 2);
  time.value++;
  const latest = await service.backup();
  assert.equal(typeof service.backupManager.prune, 'function');
  await service.backupManager.prune();
  assert.equal(existsSync(join(service.paths.backups, `${ordinary.id}.sqlite`)), false);
  assert.equal(existsSync(join(service.paths.backups, `${protectedBackup.id}.sqlite`)), true);
  assert.equal(existsSync(join(service.paths.backups, `${latest.id}.sqlite`)), true);
  assert.equal(JSON.parse(readFileSync(manifestPath)).length, 2);
  assert.equal(manifest.length, 2);
});

test('apply automatically awaits protected backup before migrating a legacy database', async (t) => {
  const dshHome = createTempHome();
  const root = join(dshHome, 'dafeiyu-memory');
  mkdirSync(root);
  const db = new DatabaseSync(join(root, 'memory.sqlite'));
  const { MIGRATIONS } = await import('../src/storage/migrations.js');
  db.exec(MIGRATIONS[0].sql);
  db.exec('PRAGMA user_version = 1');
  db.close();
  const ctx = createFakeContext();
  await apply(ctx, {}, { dshHome, clock: { now: () => NOW } });
  const service = ctx.get('dafeiyuMemory');
  t.after(() => service.dispose());
  const [manifest] = JSON.parse(readFileSync(join(root, 'backups', 'manifest.json')));
  assert.equal(manifest.reason, 'migration'); assert.equal(manifest.protected, true);
  const snapshot = new DatabaseSync(join(root, 'backups', `${manifest.id}.sqlite`));
  try { assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 1); } finally { snapshot.close(); }
  assert.equal(service.database.read((conn) => conn.prepare('PRAGMA user_version').get().user_version), 2);
});

test('migration backup failure preserves the original schema and creates no service', async () => {
  const dshHome = createTempHome();
  const root = join(dshHome, 'dafeiyu-memory'); mkdirSync(root);
  const path = join(root, 'memory.sqlite');
  const db = new DatabaseSync(path); db.exec('CREATE TABLE legacy (body TEXT); INSERT INTO legacy VALUES (\'secret\')'); db.close();
  const ctx = createFakeContext();
  await assert.rejects(apply(ctx, {}, { dshHome, maintenance: { backup: async () => { throw new Error('secret'); } } }), { code: 'MEMORY_DATABASE_OPEN_FAILED' });
  assert.equal(ctx.get('dafeiyuMemory'), undefined);
  const unchanged = new DatabaseSync(path);
  try { assert.equal(unchanged.prepare('SELECT body FROM legacy').get().body, 'secret');
    assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 0); } finally { unchanged.close(); }
});

test('80 percent triggers only safe cleanup and 100 percent stays degraded without deleting active memories or diary', async (t) => {
  const { service, time, rows } = await setup(t, {}, { diskSoftLimitBytes: 256 * 1024 ** 2 });
  const recycled = await service.recordEvent(eventInput());
  await service.repository.moveToRecycle({ kind: 'event', id: recycled.id });
  await service.recordEvent(eventInput({ sourceKey: 'active' }));
  await service.promoteToDiary({ title: 'diary', body: 'body' });
  time.value += 7 * DAY;
  mkdirSync(service.paths.reports, { recursive: true });
  const report = join(service.paths.reports, 'space.json'); writeFileSync(report, '');
  const { truncateSync } = await import('node:fs');
  truncateSync(report, Math.ceil(service.config.diskSoftLimitBytes * 0.8));
  assert.equal(typeof service.runMaintenance, 'function');
  const warning = await service.runMaintenance();
  assert.equal(warning.state, 'warning');
  assert.equal(rows('memory_events').length, 1);
  truncateSync(report, service.config.diskSoftLimitBytes);
  assert.equal((await service.runMaintenance()).state, 'degraded');
  assert.equal(service.status().state, 'degraded');
  assert.equal(rows('memory_events').length, 1); assert.equal(rows('diary_entries').length, 1);
  await service.recordEvent(eventInput({ sourceKey: 'chat-still-works' }));
  assert.equal(rows('memory_events').length, 2);
  assert.equal(JSON.stringify(service.status()).includes(service.paths.root), false);
});

test('capacity counts only dedicated storage and never follows symlinks outside the memory root', async (t) => {
  const { service } = await setup(t);
  const { truncateSync } = await import('node:fs');
  const unrelated = join(service.paths.root, 'unrelated.bin'); writeFileSync(unrelated, ''); truncateSync(unrelated, 300 * 1024 ** 2);
  const outside = join(createTempHome(), 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'large'), ''); truncateSync(join(outside, 'large'), 300 * 1024 ** 2);
  mkdirSync(service.paths.reports, { recursive: true });
  const { symlinkSync } = await import('node:fs');
  symlinkSync(outside, join(service.paths.reports, 'linked'), 'junction');
  assert.equal(typeof service.runMaintenance, 'function');
  assert.equal((await service.runMaintenance()).state, 'ready');
  assert.ok(service.status().maintenance.totalBytes < 1024 ** 2);
});

test('spool rejects unsafe DTOs without invoking getters and preserves bounded old entries', async (t) => {
  const { service } = await setup(t, {}, { spoolMaxEntries: 1, spoolLimitBytes: 1024 ** 2 });
  assert.equal(typeof service.enqueueSpool, 'function');
  let calls = 0;
  const getter = { ...eventInput() }; Object.defineProperty(getter, 'contentText', { get() { calls++; return 'secret'; } });
  for (const input of [getter, Object.create(eventInput()), eventInput({ contentText: Buffer.from('secret') }), eventInput({ mediaRefs: [Buffer.from('bytes')] })]) {
    await assert.rejects(service.enqueueSpool(input), { code: 'MEMORY_INVALID_INPUT' });
  }
  assert.equal(calls, 0);
  await service.enqueueSpool(eventInput());
  const before = readFileSync(join(service.paths.spool, 'events.jsonl'), 'utf8');
  assert.deepEqual(JSON.parse(before), eventInput());
  await assert.rejects(service.enqueueSpool(eventInput({ sourceKey: 'rejected' })), { code: 'MEMORY_SPOOL_FULL' });
  assert.equal(readFileSync(join(service.paths.spool, 'events.jsonl'), 'utf8'), before);
});

test('spool drains successes, retains failures and quarantines corrupt lines with metadata only', async (t) => {
  const { service, rows } = await setup(t);
  assert.equal(typeof service.drainSpool, 'function');
  await service.enqueueSpool(eventInput());
  const file = join(service.paths.spool, 'events.jsonl');
  writeFileSync(file, `${readFileSync(file, 'utf8')}{secret-body-not-json}\n${JSON.stringify(eventInput({ sourceKey: 'retry' }))}\n`);
  const native = service.recordEvent.bind(service);
  service.recordEvent = async (input) => {
    if (input.sourceKey === 'retry') throw new Error('secret-account-path');
    return native(input);
  };
  const result = await service.drainSpool();
  assert.deepEqual(result, { recorded: 1, retained: 1, invalid: 1 });
  assert.equal(rows('memory_events').length, 1);
  const retained = readFileSync(file, 'utf8');
  assert.equal(retained.includes('retry'), true); assert.equal(retained.includes('secret-body'), false);
  const reports = readdirSync(service.paths.reports).map((name) => readFileSync(join(service.paths.reports, name), 'utf8')).join('');
  assert.equal(reports.includes('secret'), false);
  assert.match(reports, /MEMORY_SPOOL_INVALID_JSON/);
  service.recordEvent = native;
  assert.deepEqual(await service.drainSpool(), { recorded: 1, retained: 0, invalid: 0 });
  assert.equal(readFileSync(file, 'utf8'), '');
  assert.equal(rows('memory_events').length, 2);
});

test('startup and recurring scheduler perform due purge even when disk usage is small', async (t) => {
  const { service, time, rows } = await setup(t);
  const event = await service.recordEvent(eventInput());
  await service.repository.moveToRecycle({ kind: 'event', id: event.id });
  time.value += 7 * DAY;
  await service.dispose();
  const ctx = createFakeContext();
  const { dirname } = await import('node:path');
  await apply(ctx, {}, { dshHome: dirname(service.paths.root), clock: { now: () => time.value } });
  const restarted = ctx.get('dafeiyuMemory'); t.after(() => restarted.dispose());
  await restarted.scheduler.start();
  assert.equal(restarted.status().events.recycle, 0);
  assert.equal(restarted.database.read((db) => db.prepare('SELECT count(*) AS n FROM purge_ledger').get().n), 1);
});

test('due purge is bounded at 100 and ledger uses item ID hashes while pending and future objects survive', async (t) => {
  const { service, rows } = await setup(t);
  await service.database.write((db) => {
    for (let i = 0; i < 102; i++) db.prepare(`INSERT INTO memory_items
      (id,kind,subject_key,subject_name,content,importance,confidence,visibility,promoted_at,expires_at,state,source_refs_json,purge_due_at)
      VALUES (?, 'fact', 'subject', '', 'body', 1, 1, 'owner-private', ?, ?, 'recycle', '[]', ?)`).run(`item-${i.toString().padStart(3, '0')}`, NOW - 40 * DAY, NOW - 10 * DAY, NOW);
    db.prepare("UPDATE memory_items SET purge_due_at = ? WHERE id = 'item-101'").run(NOW + 1);
  });
  assert.equal((await service.purgeRecycleItem()).deleted, 100);
  assert.equal(rows('memory_items').length, 2);
  assert.equal(rows('purge_ledger')[0].source_hash, createHash('sha256').update('item\0item-000').digest('hex'));
  assert.equal((await service.purgeRecycleItem()).deleted, 1);
  assert.equal(rows('memory_items')[0].id, 'item-101');
});

test('purge rejects accessor targets without executing them', async (t) => {
  const { service } = await setup(t);
  let calls = 0;
  await assert.rejects(service.purgeRecycleItem({ get kind() { calls++; return 'event'; }, id: 'id' }), { code: 'MEMORY_INVALID_INPUT' });
  assert.equal(calls, 0);
});

test('purge transaction rolls back ledger and recall removal when deletion fails', async (t) => {
  const { service, time, rows } = await setup(t);
  const event = await service.recordEvent(eventInput()); await service.repository.moveToRecycle({ kind: 'event', id: event.id });
  time.value += 7 * DAY;
  await service.database.write((db) => {
    db.prepare('INSERT INTO memory_recall_days VALUES (?, ?, ?)').run('event', event.id, 1);
    db.exec("CREATE TRIGGER prevent_test_delete BEFORE DELETE ON memory_events BEGIN SELECT RAISE(ABORT, 'secret'); END");
  });
  await assert.rejects(service.purgeRecycleItem(), { code: 'MEMORY_PURGE_FAILED' });
  assert.equal(rows('memory_events').length, 1); assert.equal(rows('memory_recall_days').length, 1);
  assert.equal(rows('purge_ledger').length, 0);
});

test('spool byte limit includes an in-flight batch and refuses growth at degraded capacity', async (t) => {
  const { service } = await setup(t, {}, { spoolLimitBytes: 1024 ** 2, spoolMaxEntries: 10000 });
  const text = '鱼'.repeat(15000);
  for (let i = 0; i < 23; i++) await service.enqueueSpool(eventInput({ sourceKey: String(i), contentText: text }));
  const path = join(service.paths.spool, 'events.jsonl');
  const before = readFileSync(path, 'utf8');
  await assert.rejects(service.enqueueSpool(eventInput({ sourceKey: 'too-large', contentText: text })), { code: 'MEMORY_SPOOL_FULL' });
  assert.equal(readFileSync(path, 'utf8'), before);
  mkdirSync(service.paths.reports, { recursive: true });
  const report = join(service.paths.reports, 'full'); writeFileSync(report, '');
  const { truncateSync } = await import('node:fs'); truncateSync(report, service.config.diskSoftLimitBytes);
  await assert.rejects(service.enqueueSpool(eventInput()), { code: 'MEMORY_SPOOL_FULL' });
});

test('drain permits concurrent writes without losing the newly appended spool and shares overlapping drains', async (t) => {
  const { service, rows } = await setup(t, {}, { spoolMaxEntries: 2 });
  await service.enqueueSpool(eventInput());
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const native = service.recordEvent.bind(service);
  service.recordEvent = async (input) => { started(); await gate; return native(input); };
  const first = service.drainSpool(); await entered;
  const second = service.drainSpool();
  await service.enqueueSpool(eventInput({ sourceKey: 'new-during-drain' }));
  await assert.rejects(service.enqueueSpool(eventInput({ sourceKey: 'third' })), { code: 'MEMORY_SPOOL_FULL' });
  release();
  assert.deepEqual(await first, await second);
  assert.equal(rows('memory_events').length, 1);
  service.recordEvent = native;
  assert.equal((await service.drainSpool()).recorded, 1);
  assert.equal(rows('memory_events').length, 2);
});

test('spool resumes a rotated batch after restart and a rename failure never overwrites prior events', async (t) => {
  const io = await import('node:fs/promises');
  let fail = false;
  const { service } = await setup(t, { io: { ...io, rename: async (...args) => { if (fail) throw new Error('secret path'); return io.rename(...args); } } });
  await service.enqueueSpool(eventInput());
  const file = join(service.paths.spool, 'events.jsonl'); const before = readFileSync(file, 'utf8');
  fail = true;
  await assert.rejects(service.enqueueSpool(eventInput({ sourceKey: 'failed' })), { code: 'MEMORY_SPOOL_FAILED' });
  assert.equal(readFileSync(file, 'utf8'), before);
  fail = false;
  await io.rename(file, join(service.paths.spool, 'draining.jsonl'));
  assert.equal((await service.drainSpool()).recorded, 1);
});

test('failed fsync or publication removes backup temporaries and does not record success', async (t) => {
  const io = await import('node:fs/promises');
  let stage = 'sync';
  const injected = { ...io, open: async (...args) => {
    const handle = await io.open(...args);
    return { close: () => handle.close(), sync: () => stage === 'sync' ? Promise.reject(new Error('secret')) : handle.sync() };
  }, rename: async (...args) => { if (stage === 'rename') throw new Error('secret'); return io.rename(...args); } };
  const { service } = await setup(t, { io: injected });
  for (stage of ['sync', 'rename']) {
    await assert.rejects(service.backup(), { code: 'MEMORY_BACKUP_FAILED' });
    assert.deepEqual(readdirSync(service.paths.backups), []);
  }
});

test('manual backup immediately prunes expired files and keeps its latest snapshot above the independent cap', async (t) => {
  const { service, time } = await setup(t, {}, { backupLimitBytes: 32 * 1024 ** 2 });
  const old = await service.backup(); time.value += 31 * DAY;
  const latest = await service.backup();
  assert.equal(existsSync(join(service.paths.backups, `${old.id}.sqlite`)), false);
  assert.equal(existsSync(join(service.paths.backups, `${latest.id}.sqlite`)), true);
  const { truncateSync } = await import('node:fs');
  const native = service.backupManager.implementation;
  service.backupManager.implementation = async (db, path) => { await native(db, path); truncateSync(path, 33 * 1024 ** 2); };
  const oversized = await service.backup();
  assert.equal(oversized.overLimit, true);
  assert.equal(existsSync(join(service.paths.backups, `${oversized.id}.sqlite`)), true);
  assert.equal(existsSync(join(service.paths.backups, `${latest.id}.sqlite`)), false);
  await service.backupManager.prune();
  assert.equal(existsSync(join(service.paths.backups, `${oversized.id}.sqlite`)), true);
});

test('purge gate keeps the newest snapshot even when protected backups exceed the backup cap', async (t) => {
  const { service, time, rows } = await setup(t, {}, { backupLimitBytes: 32 * 1024 ** 2 });
  const protectedBackup = await service.backupManager.create('migration', true);
  const { truncateSync } = await import('node:fs'); truncateSync(join(service.paths.backups, `${protectedBackup.id}.sqlite`), 34 * 1024 ** 2);
  const event = await service.recordEvent(eventInput()); await service.repository.moveToRecycle({ kind: 'event', id: event.id });
  time.value += 7 * DAY;
  assert.equal((await service.purgeRecycleItem()).deleted, 1);
  assert.equal(rows('memory_events').length, 0);
  const manifest = JSON.parse(readFileSync(join(service.paths.backups, 'manifest.json')));
  assert.equal(manifest.length, 2);
  const gate = manifest.find((record) => record.reason === 'purge');
  assert.equal(existsSync(join(service.paths.backups, `${gate.id}.sqlite`)), true);
});

test('retention heals a manifest after one failed manifest publication without losing protected backups', async (t) => {
  const io = await import('node:fs/promises'); let fail = false;
  const { service, time } = await setup(t, { io: { ...io, rename: async (...args) => {
    if (fail && args[1].endsWith('manifest.json')) { fail = false; throw new Error('secret'); }
    return io.rename(...args);
  } } });
  const protectedBackup = await service.backupManager.create('migration', true);
  const old = await service.backup();
  time.value += 31 * DAY;
  fail = true;
  await assert.rejects(service.backupManager.prune(), { code: 'MEMORY_BACKUP_FAILED' });
  await service.backupManager.prune();
  assert.equal(existsSync(join(service.paths.backups, `${protectedBackup.id}.sqlite`)), true);
  assert.equal(existsSync(join(service.paths.backups, `${old.id}.sqlite`)), false);
});

test('spool sanitizes thrown error objects with hostile code getters', async (t) => {
  const io = await import('node:fs/promises'); let fail = false;
  const error = Object.defineProperty({}, 'code', { get() { throw new Error('secret-path-body'); } });
  const { service } = await setup(t, { io: { ...io, rename: async (...args) => { if (fail) throw error; return io.rename(...args); } } });
  await service.enqueueSpool(eventInput()); fail = true;
  await assert.rejects(service.enqueueSpool(eventInput({ sourceKey: 'second' })), { code: 'MEMORY_SPOOL_FAILED' });
});

test('failed older spool entries do not starve a newer pending batch', async (t) => {
  const { service, rows } = await setup(t);
  await service.enqueueSpool(eventInput({ sourceKey: 'retry' }));
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const native = service.recordEvent.bind(service);
  service.recordEvent = async (input) => {
    if (input.sourceKey === 'retry') { entered(); await gate; throw new Error('retry'); }
    return native(input);
  };
  const first = service.drainSpool(); await started;
  await service.enqueueSpool(eventInput({ sourceKey: 'newer' })); release(); await first;
  assert.deepEqual(await service.drainSpool(), { recorded: 1, retained: 1, invalid: 0 });
  assert.equal(rows('memory_events').length, 1);
});

test('checkpoint follows purge and incremental vacuum runs only at the configured free-page ratio', async (t) => {
  const { service } = await setup(t);
  const { PurgeManager } = await import('../src/maintenance/purge.js');
  const nativeRead = service.database.read.bind(service.database);
  const executed = [];
  const instrumented = { checkpoint: () => executed.push('checkpoint'), read: (callback) => nativeRead((db) => callback({
    prepare: (sql) => db.prepare(sql), exec: (sql) => { executed.push(sql); return db.exec(sql); },
  })) };
  const manager = new PurgeManager({ database: instrumented, config: service.config });
  manager.reclaimUnlocked(); assert.deepEqual(executed, ['checkpoint']);
  await service.database.write((db) => {
    db.exec('CREATE TABLE free_page_probe (body BLOB)');
    db.prepare('INSERT INTO free_page_probe VALUES (zeroblob(?))').run(2 * 1024 ** 2);
    db.exec('DROP TABLE free_page_probe');
  });
  manager.reclaimUnlocked();
  assert.deepEqual(executed, ['checkpoint', 'checkpoint', 'PRAGMA incremental_vacuum']);
  assert.equal(executed.includes('VACUUM'), false);
});

test('manifest publication failure cleans the completed file and preserves previous success records', async (t) => {
  const io = await import('node:fs/promises'); let fail = false;
  const { service } = await setup(t, { io: { ...io, rename: async (...args) => {
    if (fail && args[1].endsWith('manifest.json')) throw new Error('secret');
    return io.rename(...args);
  } } });
  const first = await service.backup(); fail = true;
  await assert.rejects(service.backup(), { code: 'MEMORY_BACKUP_FAILED' });
  const manifest = JSON.parse(readFileSync(join(service.paths.backups, 'manifest.json')));
  assert.equal(manifest.length, 1); assert.equal(manifest[0].id, first.id);
  assert.deepEqual(readdirSync(service.paths.backups).sort(), [`${first.id}.sqlite`, 'manifest.json'].sort());
});

test('purge rechecks state after backup so another connection can restore without receiving a purge ledger', async (t) => {
  const { backup } = await import('node:sqlite');
  let restore;
  const { service, time, rows } = await setup(t, { backup: async (source, path) => {
    await backup(source, path); if (restore) restore();
  } });
  const event = await service.recordEvent(eventInput()); await service.repository.moveToRecycle({ kind: 'event', id: event.id });
  await service.database.write((db) => db.prepare('INSERT INTO memory_recall_days VALUES (?, ?, ?)').run('event', event.id, 1));
  time.value += 7 * DAY;
  restore = () => {
    const other = new DatabaseSync(service.paths.database);
    try { other.prepare("UPDATE memory_events SET state = 'active', purge_due_at = NULL, version = version + 1 WHERE id = ?").run(event.id); }
    finally { other.close(); }
  };
  assert.equal((await service.purgeRecycleItem()).deleted, 0);
  assert.equal(rows('memory_events')[0].state, 'active');
  assert.equal(rows('memory_recall_days').length, 1); assert.equal(rows('purge_ledger').length, 0);
});

test('queued purge captures its target before waiting so later caller changes cannot select another record', async (t) => {
  const { service, time, rows } = await setup(t);
  const first = await service.recordEvent(eventInput());
  const second = await service.recordEvent(eventInput({ sourceKey: 'second' }));
  for (const row of [first, second]) await service.repository.moveToRecycle({ kind: 'event', id: row.id });
  time.value += 7 * DAY;
  let release;
  const blocked = service.writeQueue.enqueue(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const input = { kind: 'event', id: first.id };
  const purge = service.purgeRecycleItem(input); input.id = second.id; release(); await blocked;
  assert.equal((await purge).deleted, 1);
  assert.deepEqual(rows('memory_events').map((row) => row.id), [second.id]);
});

test('spool snapshot validates the exact captured values instead of reading caller descriptors twice', async (t) => {
  const { service } = await setup(t);
  let reads = 0;
  const input = new Proxy(eventInput(), { getOwnPropertyDescriptor(target, key) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (key === 'contentText' && ++reads > 1) return { ...descriptor, value: Buffer.from('binary') };
    return descriptor;
  } });
  await service.enqueueSpool(input);
  const snapshot = JSON.parse(readFileSync(join(service.paths.spool, 'events.jsonl'), 'utf8'));
  assert.equal(snapshot.contentText, '我喜欢钓鱼');
});

test('a failed purge backup still permits expired ordinary backup cleanup and checkpoint', async (t) => {
  const { backup } = await import('node:sqlite'); let fail = false;
  const { service, time, rows } = await setup(t, { backup: async (...args) => { if (fail) throw new Error('secret'); return backup(...args); } });
  const old = await service.backup();
  const event = await service.recordEvent(eventInput()); await service.repository.moveToRecycle({ kind: 'event', id: event.id });
  time.value += 31 * DAY; fail = true;
  const result = await service.runMaintenance();
  assert.equal(result.lastErrorCode, 'MEMORY_BACKUP_FAILED');
  assert.equal(rows('memory_events').length, 1); assert.equal(rows('purge_ledger').length, 0);
  assert.equal(existsSync(join(service.paths.backups, `${old.id}.sqlite`)), false);
});

for (const sourceKey of ['original-message', undefined]) {
  test(`spool and direct redelivery cannot revive a purged event with ${sourceKey === undefined ? 'derived' : 'explicit'} source key`, async (t) => {
    const { service, time, rows } = await setup(t);
    const input = eventInput({ sourceKey });
    await service.enqueueSpool(input);
    const event = await service.recordEvent(input);
    await service.repository.moveToRecycle({ kind: 'event', id: event.id });
    time.value += 7 * DAY;
    assert.equal((await service.purgeRecycleItem()).deleted, 1);
    const ledger = rows('purge_ledger').map((row) => ({ ...row }));
    assert.equal(ledger[0].source_hash, createHash('sha256').update(`event\0${event.externalKey}`).digest('hex'));
    assert.deepEqual(await service.drainSpool(), { recorded: 1, retained: 0, invalid: 0 });
    assert.equal(rows('memory_events').length, 0);
    assert.equal(readFileSync(join(service.paths.spool, 'events.jsonl'), 'utf8'), '');
    for (let retry = 0; retry < 2; retry++) {
      assert.deepEqual(await service.recordEvent(input), { inserted: false, deduplicated: true, purged: true, id: null });
    }
    assert.equal(rows('memory_events').length, 0);
    assert.deepEqual(rows('purge_ledger').map((row) => ({ ...row })), ledger);
  });
}

test('incremental vacuum requires a valid threshold of at least 0.2 and enough actual free pages', async () => {
  const { PurgeManager } = await import('../src/maintenance/purge.js');
  for (const [threshold, free, expected] of [[0.2, 19, 0], [0.2, 20, 1], [0.6, 59, 0], [0.6, 60, 1],
    [1, 99, 0], [1, 100, 1], [0.19999999999999998, 20, 0], [1.1, 120, 0], [NaN, 100, 0], [Infinity, 100, 0]]) {
    const executed = [];
    const database = { checkpoint() {}, read: (callback) => callback({
      prepare: (sql) => ({ get: () => sql === 'PRAGMA freelist_count' ? { freelist_count: free } : { page_count: 100 } }),
      exec: (sql) => executed.push(sql),
    }) };
    new PurgeManager({ database, config: { incrementalVacuumFreeRatio: threshold } }).reclaimUnlocked();
    assert.equal(executed.length, expected, `threshold=${threshold}; free=${free}`);
    if (expected) assert.deepEqual(executed, ['PRAGMA incremental_vacuum']);
  }
});
