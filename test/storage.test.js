import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MemoryDatabase } from '../src/storage/database.js';
import { migrate } from '../src/storage/migrations.js';
import { WriteQueue } from '../src/storage/write-queue.js';
import { createTempHome } from './helpers/temp-home.js';

test('package metadata requires the Node version that supports explicit statement finalization', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.node, '>=24.22.0');
  assert.equal(lock.packages[''].engines.node, manifest.engines.node);
});

async function openDatabase(t) {
  const path = join(createTempHome(), 'nested', 'memory.sqlite');
  const database = await MemoryDatabase.open(path);
  t.after(() => database.close());
  return { path, database };
}

function insertEvent(db, overrides = {}) {
  const event = {
    id: 'event-1', source: 'qq', source_key: 'message-1', conversation_kind: 'private',
    conversation_key: 'qq:user-1', actor_key: 'user-1', actor_name: '测试', direction: 'incoming',
    content_text: 'hello', occurred_at: 1_700_000_000_000, visibility: 'owner-private', state: 'active',
    review_due_at: 1_700_604_800_000, external_key: 'qq:message-1', ...overrides,
  };
  const columns = Object.keys(event);
  return db.prepare(`INSERT INTO memory_events (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...Object.values(event));
}

test('first open creates all STRICT tables and required connection settings', async (t) => {
  const { database } = await openDatabase(t);
  database.read((db) => {
    const tables = db.prepare('PRAGMA table_list').all().filter((row) => !row.name.startsWith('sqlite_'));
    assert.deepEqual(tables.map((row) => row.name).sort(), [
      'diary_entries', 'import_ledger', 'memory_events', 'memory_items', 'purge_ledger', 'review_jobs', 'schema_meta',
    ]);
    assert.ok(tables.every((row) => row.strict === 1));
    for (const [pragma, value] of [['foreign_keys', 1], ['journal_mode', 'wal'], ['busy_timeout', 5000], ['auto_vacuum', 2], ['user_version', 1]]) {
      assert.equal(Object.values(db.prepare(`PRAGMA ${pragma}`).get())[0], value, pragma);
    }
    const indexes = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all();
    for (const name of ['memory_events_due', 'memory_events_conversation', 'memory_items_due', 'diary_entries_written', 'review_jobs_due']) {
      assert.ok(indexes.some((index) => index.name === name), name);
    }
  });
});

test('reopen preserves rows and does not repeat the migration', async (t) => {
  const { path, database } = await openDatabase(t);
  await database.write((db) => {
    insertEvent(db);
    db.prepare("UPDATE schema_meta SET value = 'sentinel' WHERE key = 'migrated_at'").run();
  });
  await database.close();
  const reopened = await MemoryDatabase.open(path);
  t.after(() => reopened.close());
  reopened.read((db) => {
    assert.equal(db.prepare('SELECT count(*) AS count FROM memory_events').get().count, 1);
    assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key = 'migrated_at'").get().value, 'sentinel');
  });
});

test('event external keys are unique and invalid enum/type values are rejected', async (t) => {
  const { database } = await openDatabase(t);
  database.transaction((db) => insertEvent(db));
  assert.throws(() => database.transaction((db) => insertEvent(db, { id: 'duplicate' })), /UNIQUE/);
  for (const overrides of [
    { state: 'deleted' }, { visibility: 'everyone' }, { source: 'unknown' },
    { conversation_kind: 'unknown' }, { direction: 'unknown' }, { occurred_at: 'yesterday' },
  ]) {
    assert.throws(() => database.transaction((db) => insertEvent(db, { id: 'bad', external_key: 'bad', ...overrides })), /constraint|CHECK|INTEGER/i);
  }
});

test('long-term and diary enforce visibility, state, numeric ranges and supersession references', async (t) => {
  const { database } = await openDatabase(t);
  database.transaction((db) => {
    const sql = `INSERT INTO memory_items (id, kind, subject_key, subject_name, content, importance, confidence, visibility, promoted_at, expires_at, state, source_refs_json, supersedes_id)
      VALUES (?, 'fact', 'user', '测试', 'fact', ?, ?, ?, 1700000000000, 1702592000000, ?, '[]', ?)`;
    const insert = db.prepare(sql);
    insert.run('memory-1', 0, 1, 'owner-private', 'active', null);
    for (const values of [[-0.1, 1, 'public', 'active', null], [1, 1.1, 'public', 'active', null], [0.5, 0.5, 'bad', 'active', null], [0.5, 0.5, 'public', 'bad', null], [0.5, 0.5, 'public', 'active', 'missing']]) {
      assert.throws(() => insert.run('bad', ...values), /CHECK|FOREIGN KEY/);
    }
    const diary = db.prepare("INSERT INTO diary_entries (id, title, body, written_at, visibility, source_refs_json, supersedes_id) VALUES (?, 'title', 'body', 1700000000000, ?, '[]', ?)");
    diary.run('diary-1', 'owner-private', null);
    assert.throws(() => diary.run('bad', 'invalid', null), /CHECK/);
    assert.throws(() => diary.run('bad', 'public', 'missing'), /FOREIGN KEY/);
  });
});

test('control tables enforce job enums and ledger idempotency without retaining purge text', async (t) => {
  const { database } = await openDatabase(t);
  database.transaction((db) => {
    const job = db.prepare("INSERT INTO review_jobs (id, kind, batch_key, source_ids_json, state, due_at, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, 1700000000000, 1700000000000, 1700000000000)");
    job.run('job-1', 'short-term', 'batch-1', 'queued');
    assert.throws(() => job.run('job-2', 'short-term', 'batch-1', 'queued'), /UNIQUE/);
    assert.throws(() => job.run('job-2', 'bad', 'batch-2', 'queued'), /CHECK/);
    assert.throws(() => job.run('job-2', 'long-term', 'batch-2', 'bad'), /CHECK/);
    db.exec("INSERT INTO import_ledger (source, external_key, fingerprint, result, target_type, target_id, imported_at) VALUES ('qq','key','hash','imported','event','event-1',1700000000000)");
    assert.throws(() => db.exec("INSERT INTO import_ledger SELECT * FROM import_ledger"), /UNIQUE/);
    db.exec("INSERT INTO purge_ledger VALUES ('hash','event',1700000000000)");
    assert.throws(() => db.exec("INSERT INTO purge_ledger SELECT * FROM purge_ledger"), /UNIQUE/);
    assert.deepEqual(db.prepare('PRAGMA table_info(purge_ledger)').all().map((row) => row.name), ['source_hash', 'object_kind', 'purged_at']);
  });
});

test('transactions commit results and roll back all writes on exceptions', async (t) => {
  const { database } = await openDatabase(t);
  assert.equal(database.transaction((db) => { insertEvent(db); return 42; }), 42);
  const failure = new Error('abort');
  assert.throws(() => database.transaction((db) => {
    insertEvent(db, { id: 'event-2', external_key: 'event-2' });
    throw failure;
  }), (error) => error === failure);
  assert.equal(database.read((db) => db.prepare('SELECT count(*) AS count FROM memory_events').get().count), 1);
});

for (const result of [Promise.resolve(1), { then() {} }]) {
  test(`transaction rejects ${result instanceof Promise ? 'Promise' : 'thenable'} results and rolls back`, async (t) => {
    const { database } = await openDatabase(t);
    assert.throws(() => database.transaction((db) => { insertEvent(db); return result; }), { code: 'MEMORY_ASYNC_TRANSACTION' });
    assert.equal(database.read((db) => db.prepare('SELECT count(*) AS count FROM memory_events').get().count), 0);
    assert.equal(database.transaction(() => 'usable'), 'usable');
  });
}

test('rejected async transactions cannot write through captured statements after await', async (t) => {
  const { database } = await openDatabase(t);
  let continuationError;
  assert.throws(() => database.transaction(async (db) => {
    insertEvent(db);
    const statement = db.prepare("INSERT INTO schema_meta VALUES ('escaped', 'must not persist')");
    await Promise.resolve();
    try { statement.run(); } catch (error) { continuationError = error; }
  }), { code: 'MEMORY_ASYNC_TRANSACTION' });
  await Promise.resolve();
  assert.equal(continuationError?.code, 'MEMORY_TRANSACTION_FINISHED');
  assert.equal(database.read((db) => db.prepare("SELECT count(*) AS count FROM schema_meta WHERE key = 'escaped'").get().count), 0);
  assert.equal(database.read((db) => db.prepare('SELECT count(*) AS count FROM memory_events').get().count), 0);
});

test('captured write iterators cannot execute after transaction rollback', async (t) => {
  const { database } = await openDatabase(t);
  database.transaction((db) => db.exec('CREATE TABLE iterator_probe (id INTEGER PRIMARY KEY) STRICT'));
  let iterator;
  assert.throws(() => database.transaction((db) => {
    iterator = db.prepare('INSERT INTO iterator_probe VALUES (1) RETURNING id').iterate();
    throw new Error('abort iterator transaction');
  }), /abort iterator transaction/);
  for (const operation of [() => iterator.next(), () => iterator.return(), () => iterator.throw(new Error('stop')), () => iterator[Symbol.iterator]()]) {
    assert.throws(operation, { code: 'MEMORY_TRANSACTION_FINISHED' });
  }
  assert.equal(database.read((db) => db.prepare('SELECT count(*) AS count FROM iterator_probe').get().count), 0);
});

test('transaction iterators support normal iteration and early return within their scope', async (t) => {
  const { database } = await openDatabase(t);
  let iterator;
  database.transaction((db) => {
    db.exec('CREATE TABLE normal_iterator_probe (id INTEGER PRIMARY KEY) STRICT');
    assert.deepEqual(Array.from(db.prepare('INSERT INTO normal_iterator_probe VALUES (1) RETURNING id').iterate(), (row) => row.id), [1]);
    assert.deepEqual(Array.from(db.prepare("SELECT value FROM json_each('[1,2,3]')").iterate(), (row) => row.value), [1, 2, 3]);
    iterator = db.prepare("SELECT value FROM json_each('[4,5,6]')").iterate();
    for (const row of iterator) {
      assert.equal(row.value, 4);
      break;
    }
    assert.equal(iterator.next().done, true);
    const interrupted = db.prepare("SELECT value FROM json_each('[7,8]')").iterate();
    const interruption = new Error('stop scoped iteration');
    assert.throws(() => interrupted.throw(interruption), (error) => error === interruption);
    assert.equal(interrupted.next().done, true);
  });
  assert.equal(database.read((db) => db.prepare('SELECT count(*) AS count FROM normal_iterator_probe').get().count), 1);
  assert.throws(() => iterator.next(), { code: 'MEMORY_TRANSACTION_FINISHED' });
});

test('partially consumed SELECT iterators are closed before commit and release checkpoint locks', async (t) => {
  const { database } = await openDatabase(t);
  let iterator;
  database.transaction((db) => {
    iterator = db.prepare("SELECT value FROM json_each('[1,2,3]')").iterate();
    assert.equal(iterator.next().value.value, 1);
  });
  for (const operation of [() => iterator.next(), () => iterator.return(), () => iterator.throw(new Error('stop')), () => iterator[Symbol.iterator]()]) {
    assert.throws(operation, { code: 'MEMORY_TRANSACTION_FINISHED' });
  }
  assert.equal(database.checkpoint().busy, 0);
  await database.close();
});

test('partially consumed INSERT RETURNING commits the entire executed statement without locks', async (t) => {
  const { database } = await openDatabase(t);
  database.transaction((db) => db.exec('CREATE TABLE partial_insert_probe (id INTEGER PRIMARY KEY) STRICT'));
  let iterator;
  database.transaction((db) => {
    iterator = db.prepare('INSERT INTO partial_insert_probe VALUES (1), (2) RETURNING id').iterate();
    assert.equal(iterator.next().value.id, 1);
  });
  assert.equal(database.read((db) => db.prepare('SELECT count(*) AS count FROM partial_insert_probe').get().count), 2);
  for (const operation of [() => iterator.next(), () => iterator.return(), () => iterator.throw(new Error('stop'))]) {
    assert.throws(operation, { code: 'MEMORY_TRANSACTION_FINISHED' });
  }
  assert.equal(database.checkpoint().busy, 0);
  await database.close();
});

test('partially consumed INSERT RETURNING is closed before rollback with no rows or locks left', async (t) => {
  const { database } = await openDatabase(t);
  database.transaction((db) => db.exec('CREATE TABLE partial_rollback_probe (id INTEGER PRIMARY KEY) STRICT'));
  let iterator;
  const failure = new Error('abort partial write');
  assert.throws(() => database.transaction((db) => {
    iterator = db.prepare('INSERT INTO partial_rollback_probe VALUES (1), (2) RETURNING id').iterate();
    assert.equal(iterator.next().value.id, 1);
    throw failure;
  }), (error) => error === failure);
  assert.equal(database.read((db) => db.prepare('SELECT count(*) AS count FROM partial_rollback_probe').get().count), 0);
  for (const operation of [() => iterator.next(), () => iterator.return(), () => iterator.throw(new Error('stop'))]) {
    assert.throws(operation, { code: 'MEMORY_TRANSACTION_FINISHED' });
  }
  assert.equal(database.checkpoint().busy, 0);
  await database.close();
});

test('automatic iterator cleanup failure rolls back instead of committing and throws a stable error', async (t) => {
  const { database } = await openDatabase(t);
  database.transaction((db) => db.exec('CREATE TABLE cleanup_failure_probe (id INTEGER PRIMARY KEY) STRICT'));
  const raw = new DatabaseSync(':memory:');
  const statement = raw.prepare('SELECT 1');
  const iterator = statement.iterate();
  const prototype = Object.getPrototypeOf(iterator);
  const nativeReturn = prototype.return;
  iterator.return();
  statement.close();
  raw.close();
  // Inject the otherwise exceptional native reset failure after releasing its resources.
  t.mock.method(prototype, 'return', function (...args) {
    nativeReturn.apply(this, args);
    throw new Error('native iterator cleanup failed');
  });
  try {
    assert.throws(() => database.transaction((db) => {
      const pending = db.prepare('INSERT INTO cleanup_failure_probe VALUES (1), (2) RETURNING id').iterate();
      pending.next();
      // Failure on the first iterator must not skip releasing the other active statement.
      const pendingRead = db.prepare("SELECT value FROM json_each('[1,2,3]')").iterate();
      pendingRead.next();
    }), { code: 'MEMORY_ITERATOR_CLEANUP_FAILED', message: 'Memory transaction iterator cleanup failed' });
  } finally { t.mock.restoreAll(); }
  assert.equal(database.read((db) => db.prepare('SELECT count(*) AS count FROM cleanup_failure_probe').get().count), 0);
  assert.equal(database.transaction(() => 'usable'), 'usable');
  assert.equal(database.checkpoint().busy, 0);
  await database.close();
});

test('database open redacts native directory initialization errors', async () => {
  const home = createTempHome();
  const blockedDirectory = join(home, 'blocked');
  writeFileSync(blockedDirectory, 'blocks the database directory');
  await assert.rejects(MemoryDatabase.open(join(blockedDirectory, 'memory.sqlite')), (error) => {
    assert.equal(error.code, 'MEMORY_DATABASE_OPEN_FAILED');
    assert.equal(error.message, 'Memory database could not be opened');
    assert.equal(String(error.stack), 'Error: Memory database could not be opened');
    assert.equal(error.message.includes(home), false);
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ['code', 'message', 'stack']);
    assert.equal(JSON.stringify(error).includes(home), false);
    return true;
  });
});

test('database open redacts native SQLite open errors', async () => {
  const home = createTempHome();
  await assert.rejects(MemoryDatabase.open(home), (error) => {
    assert.equal(error.code, 'MEMORY_DATABASE_OPEN_FAILED');
    assert.equal(error.message, 'Memory database could not be opened');
    assert.equal(String(error.stack), 'Error: Memory database could not be opened');
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ['code', 'message', 'stack']);
    assert.equal(error.message.includes(home), false);
    return true;
  });
});

test('prepared statements are reused and finalized when the database closes', async (t) => {
  const { database } = await openDatabase(t);
  const statement = database.read((db) => db.prepare('SELECT 1 AS n'));
  assert.equal(database.read((db) => db.prepare('SELECT 1 AS n')), statement);
  await database.close();
  await database.close();
  assert.throws(() => statement.get(), /finalized/i);
  assert.throws(() => database.read(() => 1), { code: 'MEMORY_DATABASE_CLOSED' });
  await assert.rejects(database.write(() => 1), { code: 'MEMORY_DATABASE_CLOSED' });
});

test('checkpoint flushes a live WAL database', async (t) => {
  const { database } = await openDatabase(t);
  database.transaction((db) => insertEvent(db));
  const result = database.checkpoint();
  assert.equal(result.busy, 0);
  assert.equal(result.log, 0);
});

test('queue runs async jobs in submission order and survives a failed job', async () => {
  const queue = new WriteQueue();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue.enqueue(async () => { order.push('first-start'); await gate; order.push('first-end'); return 1; });
  const second = queue.enqueue(() => { order.push('second'); throw new Error('expected'); });
  const failure = assert.rejects(second, /expected/);
  const third = queue.enqueue(() => { order.push('third'); return 3; });
  await Promise.resolve();
  assert.deepEqual(order, ['first-start']);
  release();
  assert.deepEqual(await Promise.all([first, third]), [1, 3]);
  await failure;
  await queue.drain();
  assert.deepEqual(order, ['first-start', 'first-end', 'second', 'third']);
  await queue.close();
});

test('queue close rejects new submissions and waits for every accepted job', async () => {
  const queue = new WriteQueue();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let completed = false;
  const first = queue.enqueue(() => gate);
  const second = queue.enqueue(() => { completed = true; });
  const closing = queue.close();
  await assert.rejects(queue.enqueue(() => {}), { code: 'MEMORY_QUEUE_CLOSED' });
  assert.equal(completed, false);
  release();
  await closing;
  await Promise.all([first, second]);
  assert.equal(completed, true);
  await queue.close();
});

test('database close waits for already queued short transactions', async (t) => {
  const { path, database } = await openDatabase(t);
  const writes = [1, 2, 3].map((id) => database.write((db) => insertEvent(db, { id: `event-${id}`, external_key: `event-${id}` })));
  const closing = database.close();
  await assert.rejects(database.write(() => {}), { code: 'MEMORY_DATABASE_CLOSED' });
  await closing;
  await Promise.all(writes);
  const reopened = await MemoryDatabase.open(path);
  t.after(() => reopened.close());
  assert.equal(reopened.read((db) => db.prepare('SELECT count(*) AS count FROM memory_events').get().count), 3);
});

test('migration failure rolls back schema, rows and user_version together', async (t) => {
  const path = join(createTempHome(), 'existing.sqlite');
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec("CREATE TABLE original (value TEXT) STRICT; INSERT INTO original VALUES ('preserved')");
  assert.throws(() => migrate(db, [
    { version: 1, sql: 'CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; CREATE TABLE added (value TEXT) STRICT' },
    { version: 2, sql: "DELETE FROM original; INSERT INTO missing VALUES ('fail')" },
  ]), /missing/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  assert.equal(db.prepare('SELECT value FROM original').get().value, 'preserved');
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'added'").get().count, 0);
});

test('opening a corrupt file fails without replacing its bytes', async (t) => {
  const path = join(createTempHome(), 'corrupt.sqlite');
  const bytes = Buffer.from('original invalid database bytes');
  writeFileSync(path, bytes);
  await assert.rejects(MemoryDatabase.open(path));
  assert.deepEqual(readFileSync(path), bytes);
});

test('opening a future schema fails without downgrading or replacing its data', async (t) => {
  const path = join(createTempHome(), 'future.sqlite');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE original (value TEXT) STRICT; INSERT INTO original VALUES ('preserved'); PRAGMA user_version=99");
  db.close();
  await assert.rejects(MemoryDatabase.open(path), { code: 'MEMORY_SCHEMA_TOO_NEW' });
  const check = new DatabaseSync(path);
  t.after(() => check.close());
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99);
  assert.equal(check.prepare('SELECT value FROM original').get().value, 'preserved');
});

test('existing legacy databases require a completed backup before any migration DDL', async (t) => {
  const path = join(createTempHome(), 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE original (value TEXT) STRICT; INSERT INTO original VALUES ('preserved')");
  legacy.close();
  await assert.rejects(MemoryDatabase.open(path), { code: 'MEMORY_MIGRATION_BACKUP_REQUIRED' });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let backupStarted = false;
  const opening = MemoryDatabase.open(path, { beforeMigrate: async (context) => {
    assert.equal(context.path, path);
    assert.equal(context.currentVersion, 0);
    assert.equal(context.targetVersion, 1);
    assert.equal(context.database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'memory_events'").get().count, 0);
    backupStarted = true;
    await gate;
  } });
  assert.equal(backupStarted, true);
  const observer = new DatabaseSync(path);
  assert.equal(observer.prepare('PRAGMA user_version').get().user_version, 0);
  assert.equal(observer.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'memory_events'").get().count, 0);
  observer.close();
  release();
  const database = await opening;
  t.after(() => database.close());
  assert.equal(database.read((db) => db.prepare('SELECT value FROM original').get().value), 'preserved');
  assert.equal(database.read((db) => db.prepare('PRAGMA auto_vacuum').get().auto_vacuum), 2);
});

test('backup failure preserves existing database contents and never starts migration', async (t) => {
  const path = join(createTempHome(), 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE original (value TEXT) STRICT; INSERT INTO original VALUES ('preserved')");
  legacy.close();
  const bytes = readFileSync(path);
  await assert.rejects(MemoryDatabase.open(path, { beforeMigrate: async () => {
    throw Object.assign(new Error(`backup failed at ${path}`), { path, cause: new Error(path) });
  } }), (error) => {
    assert.equal(error.code, 'MEMORY_DATABASE_OPEN_FAILED');
    assert.equal(error.message, 'Memory database could not be opened');
    assert.equal(String(error.stack), 'Error: Memory database could not be opened');
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ['code', 'message', 'stack']);
    assert.equal(error.message.includes(path), false);
    return true;
  });
  assert.deepEqual(readFileSync(path), bytes);
});

test('open migration failure retains the original database instead of creating an empty replacement', async (t) => {
  const path = join(createTempHome(), 'collision.sqlite');
  const original = new DatabaseSync(path);
  original.exec("CREATE TABLE memory_events (original TEXT) STRICT; INSERT INTO memory_events VALUES ('preserved')");
  original.close();
  let backedUp = false;
  await assert.rejects(MemoryDatabase.open(path, { beforeMigrate: () => { backedUp = true; } }), { code: 'MEMORY_DATABASE_OPEN_FAILED' });
  assert.equal(backedUp, true);
  const check = new DatabaseSync(path);
  t.after(() => check.close());
  assert.equal(check.prepare('SELECT original FROM memory_events').get().original, 'preserved');
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 0);
  assert.equal(check.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'schema_meta'").get().count, 0);
});

test('migrations advance sequentially from the current version and reject gaps before mutation', (t) => {
  const db = new DatabaseSync(join(createTempHome(), 'sequence.sqlite'));
  t.after(() => db.close());
  db.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; PRAGMA user_version=1');
  migrate(db, [
    { version: 1, sql: 'THIS ALREADY APPLIED MIGRATION MUST NOT RUN' },
    { version: 2, sql: 'CREATE TABLE second (value TEXT) STRICT' },
    { version: 3, sql: "INSERT INTO second VALUES ('ordered')" },
  ]);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare('SELECT value FROM second').get().value, 'ordered');
  assert.throws(() => migrate(db, [{ version: 5, sql: 'DROP TABLE second' }]), { code: 'MEMORY_INVALID_MIGRATION' });
  assert.equal(db.prepare('SELECT value FROM second').get().value, 'ordered');
});
