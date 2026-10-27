import { readFileSync } from 'node:fs';
import { memoryError } from '../contracts.js';

const [schemaV1, schemaV2] = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').split('-- Schema version 2');

export const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, sql: schemaV1 }),
  Object.freeze({ version: 2, sql: schemaV2 }),
]);
export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

/** One-shot queries also finalize their statements; no handles escape migration setup. */
export function queryOne(database, sql) {
  const statement = database.prepare(sql);
  try { return statement.get(); } finally { statement.close(); }
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
    } finally { metadata.close(); }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
