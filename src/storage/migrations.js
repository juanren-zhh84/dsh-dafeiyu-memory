import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { memoryError } from '../contracts.js';

const [schemaV1, schemaV2] = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').split('-- Schema version 2');

export const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, sql: schemaV1 }),
  Object.freeze({ version: 2, sql: schemaV2 }),
]);
export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

// StatementSync.close() was added after the Node 24.21 runtime embedded in DSH.
// Older runtimes finalize remaining statements when DatabaseSync.close() runs.
export function finalizeStatement(statement) {
  if (typeof statement.close === 'function') statement.close();
}

/** Validate against a fresh database produced by the same canonical migrations, never a second schema list. */
export function validateCurrentSchema(database) {
  const expected = new DatabaseSync(':memory:');
  try {
    migrate(expected);
    const schema = db => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name').all();
    if (queryOne(database, 'PRAGMA user_version').user_version !== SCHEMA_VERSION
      || queryOne(database, 'PRAGMA quick_check').quick_check !== 'ok'
      || JSON.stringify(schema(database)) !== JSON.stringify(schema(expected))) return false;
    const metadata = database.prepare('SELECT key,value FROM schema_meta ORDER BY key').all();
    if (JSON.stringify(metadata.map(x => x.key)) !== JSON.stringify(['migrated_at', 'migration_state', 'schema_version'])) return false;
    const values = Object.fromEntries(metadata.map(x => [x.key, x.value]));
    return values.schema_version === String(SCHEMA_VERSION) && values.migration_state === 'ready'
      && /^\d+$/.test(values.migrated_at) && Number.isSafeInteger(Number(values.migrated_at));
  } catch { return false; }
  finally { expected.close(); }
}

/** One-shot queries also finalize their statements; no handles escape migration setup. */
export function queryOne(database, sql) {
  const statement = database.prepare(sql);
  try { return statement.get(); } finally { finalizeStatement(statement); }
}

/** Caller must finish the pre-upgrade backup before entering this synchronous function. */
export function migrate(database, migrations = MIGRATIONS) {
  const current = queryOne(database, 'PRAGMA user_version').user_version;
  const target = migrations.at(-1)?.version ?? 0;
  if (current > target) throw memoryError('MEMORY_SCHEMA_TOO_NEW', 'Memory database schema is newer than this runtime');
  const pending = migrations.filter((migration) => migration.version > current);
  if (!pending.length) return;
  pending.forEach((migration, index) => {
    if (migration.version !== current + index + 1) {
      throw memoryError('MEMORY_INVALID_MIGRATION', 'Memory database migrations must be consecutive');
    }
  });
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of pending) {
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    const metadata = database.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)');
    try {
      metadata.run('schema_version', String(target));
      metadata.run('migration_state', 'ready');
      metadata.run('migrated_at', String(Date.now()));
    } finally { finalizeStatement(metadata); }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
