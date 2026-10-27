import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, validateCurrentSchema } from '../src/storage/migrations.js';
// Offline inspection only. An active WAL is checked by header instead of creating SQLite sidecars.
export function inspectDatabase(path) {
  if (!existsSync(path)) return { status: 'pending', code: 'DATABASE_NOT_CREATED' };
  if (lstatSync(path).isSymbolicLink()) return { status: 'fail', code: 'DATABASE_LINK_REJECTED' };
  const bytes = readFileSync(path);
  if (bytes.length < 100 || bytes.subarray(0, 16).toString() !== 'SQLite format 3\0' || bytes.readUInt32BE(60) !== SCHEMA_VERSION) {
    return { status: 'fail', code: 'DATABASE_SCHEMA_INVALID' };
  }
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) return { status: 'pending', code: 'DATABASE_ACTIVE_SAFE_HEADER_ONLY', schema: SCHEMA_VERSION };
  // Opening a WAL-mode file with SQLite readOnly can still create -shm/-wal.
  // Deserialize a private byte copy, so inspection never writes any file.
  bytes[18] = 1; bytes[19] = 1;
  const db = new DatabaseSync(':memory:');
  try {
    db.deserialize(bytes); db.exec('PRAGMA query_only=ON');
    if (!validateCurrentSchema(db)) return { status: 'fail', code: 'DATABASE_SCHEMA_INVALID' };
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') return { status: 'fail', code: 'DATABASE_INTEGRITY_FAILED' };
    const counts = {};
    for (const [key, table] of [['events', 'memory_events'], ['items', 'memory_items'], ['diary', 'diary_entries'], ['jobs', 'review_jobs']]) {
      counts[key] = db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
    }
    return { status: 'pass', code: 'DATABASE_OFFLINE_OK', schema: SCHEMA_VERSION, counts };
  } finally { db.close(); }
}
try { process.stdout.write(`${JSON.stringify(inspectDatabase(process.argv[2]))}\n`); }
catch { process.stdout.write(`${JSON.stringify({ status: 'fail', code: 'DATABASE_INSPECTION_FAILED' })}\n`); process.exitCode = 1; }
