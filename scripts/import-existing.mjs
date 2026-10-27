import { lstatSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MemoryDatabase } from '../src/storage/database.js';
import { SCHEMA_VERSION } from '../src/storage/migrations.js';
import { resolveConfig } from '../src/config.js';
import { resolveMemoryPaths } from '../src/paths.js';
import { ImportManager } from '../src/importers/index.js';
import { fingerprint } from '../src/importers/shared.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
function noLinks(path, recursive = false) {
  let current = resolve(path);
  while (true) {
    try { if (lstatSync(current).isSymbolicLink()) fail('IMPORT_LINK_REJECTED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  if (recursive && existsSync(path) && lstatSync(path).isDirectory()) {
    for (const name of readdirSync(path)) noLinks(join(path, name), true);
  }
}

/** Only the two explicitly selected core sources. No optional-source discovery. */
export function snapshotCoreSources(home) {
  const root = join(home, 'plugins-data/aurabot'), files = [];
  noLinks(root); noLinks(join(home, 'dsh-pet/memory.json'));
  const add = (path, source, logical) => {
    noLinks(path);
    if (!existsSync(path)) return;
    if (!lstatSync(path).isFile()) fail('INVALID_SOURCE');
    const bytes = readFileSync(path); files.push({ source, file: logical, size: bytes.length, sha256: fingerprint(bytes) });
  };
  noLinks(join(root, 'chatlog'));
  if (existsSync(join(root, 'chatlog'))) for (const name of readdirSync(join(root, 'chatlog')).filter(x => x.endsWith('.jsonl')).sort()) {
    add(join(root, 'chatlog', name), 'aurabot', `chatlog/${fingerprint(name)}.jsonl`);
  }
  for (const name of ['memories.json', 'diary.json']) add(join(root, name), 'aurabot', name);
  add(join(home, 'dsh-pet/memory.json'), 'pet', 'memory.json');
  return files;
}

function validateExisting(paths) {
  noLinks(paths.root, true);
  if (!existsSync(paths.root)) return false;
  const allowed = new Set(['memory.sqlite', 'memory.sqlite-wal', 'memory.sqlite-shm', 'backups', 'spool', 'reports']);
  if (readdirSync(paths.root).some(x => !allowed.has(x)) || !existsSync(paths.database)) fail('UNKNOWN_TARGET');
  if (existsSync(`${paths.database}-wal`) || existsSync(`${paths.database}-shm`)) fail('TARGET_BUSY');
  const db = offlineCopy(paths.database);
  try {
    if (db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION
      || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('UNKNOWN_TARGET');
    for (const table of ['memory_events', 'memory_items', 'diary_entries', 'review_jobs', 'import_ledger', 'purge_ledger', 'schema_meta']) {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) fail('UNKNOWN_TARGET');
    }
  } finally { db.close(); }
  return true;
}

function offlineCopy(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 100 || bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') fail('UNKNOWN_TARGET');
  // An offline checkpointed WAL-format database can be inspected entirely in memory.
  // Change only this private byte copy's journal flags; never open the source with SQLite.
  bytes[18] = 1; bytes[19] = 1;
  const db = new DatabaseSync(':memory:');
  try { db.deserialize(bytes); db.exec('PRAGMA query_only=ON'); return db; }
  catch (error) { db.close(); throw error; }
}

export async function importCore({ dshHome, apply = false }) {
  if (typeof dshHome !== 'string' || !isAbsolute(dshHome) || /[\0\r\n]/.test(dshHome)) fail('ABSOLUTE_DSH_HOME_REQUIRED');
  const home = resolve(dshHome); noLinks(home);
  if (!existsSync(home) || !lstatSync(home).isDirectory()) fail('DSH_HOME_REQUIRED');
  const paths = resolveMemoryPaths({ dshHome: home }), existing = validateExisting(paths);
  const targetHash = existing ? fingerprint(readFileSync(paths.database)) : null;
  const before = snapshotCoreSources(home), config = resolveConfig();
  const sources = { aurabot: join(home, 'plugins-data/aurabot'), pet: join(home, 'dsh-pet/memory.json') };
  let scratch, database, reader;
  try {
    // Planning reads an existing target without migration/checkpoint or opens a disposable new database.
    if (existing) { reader = offlineCopy(paths.database); database = { read: fn => fn(reader) }; }
    else { scratch = await mkdtemp(join(tmpdir(), 'memory-import-plan-')); database = await MemoryDatabase.open(join(scratch, 'plan.sqlite')); }
    const plan = await new ImportManager({ database, paths, config }).importExisting({ dryRun: true, sources });
    if (!plan.ok) return { ...plan, code: 'IMPORT_PREFLIGHT_FAILED', backupTarget: 'CORE_IMPORT_SOURCES' };
    if (JSON.stringify(snapshotCoreSources(home)) !== JSON.stringify(before)) fail('SOURCE_CHANGED');
    if (existing && fingerprint(readFileSync(paths.database)) !== targetHash) fail('TARGET_CHANGED');
    if (!apply) return { ...plan, code: 'DRY_RUN_OK', backupTarget: 'CORE_IMPORT_SOURCES' };
    if (reader) { reader.close(); reader = undefined; database = undefined; }
    else { await database.close(); database = undefined; }
    // Recheck immediately before creating/opening the real target. Unknown state is never overwritten.
    if (validateExisting(paths) !== existing || (existing && fingerprint(readFileSync(paths.database)) !== targetHash)) fail('TARGET_CHANGED');
    database = await MemoryDatabase.open(paths.database);
    const report = await new ImportManager({ database, paths, config }).importExisting({ dryRun: false, sources });
    if (JSON.stringify(snapshotCoreSources(home)) !== JSON.stringify(before)) fail('SOURCE_CHANGED');
    return { ...report, code: report.ok ? 'IMPORT_OK' : 'IMPORT_FAILED', backupTarget: 'CORE_IMPORT_SOURCES' };
  } finally {
    if (reader) reader.close(); else await database?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[0] !== '--dsh-home' || !['--dry-run', '--apply'].includes(args[2])) fail('IMPORT_USAGE');
    const report = await importCore({ dshHome: args[1], apply: args[2] === '--apply' });
    process.stdout.write(`${JSON.stringify(report)}\n`); if (!report.ok) process.exitCode = 1;
  } catch (error) {
    const codes = new Set(['IMPORT_USAGE', 'ABSOLUTE_DSH_HOME_REQUIRED', 'DSH_HOME_REQUIRED', 'IMPORT_LINK_REJECTED', 'UNKNOWN_TARGET', 'TARGET_CHANGED', 'TARGET_BUSY', 'INVALID_SOURCE', 'SOURCE_CHANGED']);
    process.stdout.write(`${JSON.stringify({ ok: false, code: codes.has(error.code) ? error.code : 'IMPORT_FAILED', time: Date.now() })}\n`);
    process.exitCode = 1;
  }
}
