import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { parseAurabot } from './aurabot.js';
import { parsePet } from './pet.js';
import { parseDouyin, resolveDouyinPath } from './douyin.js';
import { DAY, fingerprint, invalid } from './shared.js';
import { memoryError } from '../contracts.js';
import { syncFile } from '../maintenance/backup.js';

const knownCodes = new Set(['INVALID_SOURCE','BACKUP_FAILED','SOURCE_CHANGED','IMPORT_FAILED','UNSUPPORTED_SCHEMA','CAPACITY_LIMIT']);
const errorCode = error => knownCodes.has(error?.code) ? error.code : 'IMPORT_FAILED';
const reportRow = source => ({ source, status: 'skipped', imported: 0, skipped: 0, failed: 0, planned: 0, code: 'SOURCE_MISSING' });

/** Explicit administrative migration only. Sources are never opened for writing. */
export class ImportManager {
  #pending = Promise.resolve();
  constructor({ database, paths, config, clock = Date, io = fs, sqliteBackup = backup, scan, canGrow = () => true, env = process.env }) {
    Object.assign(this, { database, paths, config, clock, io, sqliteBackup, scan, canGrow, env });
  }
  importExisting(options = {}) {
    let snapshot;
    try {
      const own = (value, fields) => {
        if (!value || typeof value !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw Error();
        const copy = {};
        for (const key of Reflect.ownKeys(value)) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!fields.includes(key) || !Object.hasOwn(descriptor, 'value')) throw Error();
          copy[key] = descriptor.value;
        }
        return copy;
      };
      snapshot = own(options, ['dryRun','sources']);
      if (snapshot.sources !== undefined) snapshot.sources = own(snapshot.sources, ['aurabot','pet','douyin']);
    } catch { return Promise.reject(memoryError('MEMORY_INVALID_INPUT', 'Invalid import options')); }
    const run = this.#pending.then(() => this.#run(snapshot));
    this.#pending = run.catch(() => {});
    return run;
  }
  settle() { return this.#pending; }
  async #run({ dryRun = false, sources } = {}) {
    if (typeof dryRun !== 'boolean' || (sources !== undefined && (!sources || typeof sources !== 'object' || Array.isArray(sources)))) {
      throw memoryError('MEMORY_INVALID_INPUT', 'Invalid import options');
    }
    const startedAt = this.clock.now();
    const home = dirname(this.paths.root);
    const selected = sources ?? { aurabot: join(home, 'plugins-data', 'aurabot'), pet: join(home, 'dsh-pet', 'memory.json'), douyin: undefined };
    if (Object.keys(selected).some(source => !['aurabot', 'pet', 'douyin'].includes(source))
      || Object.values(selected).some(path => path !== undefined && (typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/.test(path)))) {
      throw memoryError('MEMORY_INVALID_INPUT', 'Invalid import sources');
    }
    const report = { ok: true, dryRun, startedAt, finishedAt: startedAt, sources: [] };
    for (const source of Object.keys(selected)) {
      const row = reportRow(source); report.sources.push(row);
      let opened, files = [];
      try {
        const path = selected[source] ?? (source === 'douyin' ? await resolveDouyinPath({ home, io: this.io, env: this.env }) : undefined);
        if (!path) invalid();
        files = await this.#files(source, path);
        if (!files.length) continue;
        if (source === 'douyin') {
          opened = new DatabaseSync(path, { readOnly: true });
          opened.exec('BEGIN');
          files[0].records = parseDouyin(opened, this.config);
          // Installed private-context JSON does not provide reliable source timestamps.
          row.privateContextCode = 'UNSUPPORTED_PRIVATE_CONTEXT';
        } else {
          for (const file of files) {
            try { file.records = (source === 'aurabot' ? parseAurabot : parsePet)(file.bytes, file.logical, this.config); }
            catch { file.code = 'INVALID_SOURCE'; }
          }
        }
        await this.#verify(files);
        if (!dryRun) {
          if (!this.canGrow()) invalid('CAPACITY_LIMIT');
          await this.#snapshot(source, files, opened);
          await this.#verify(files);
        }
        row.code = 'OK'; row.status = dryRun ? 'planned' : 'imported';
        const plannedKeys = new Set();
        for (const file of files) {
          if (file.code) { row.failed++; row.code = file.code; continue; }
          try {
            const count = dryRun ? this.database.read(db => this.#plan(db, source, file.records, plannedKeys))
              : await this.database.write(db => {
                if (!this.canGrow()) invalid('CAPACITY_LIMIT');
                this.#verifySync(files);
                const result = this.#commit(db, source, file.records, startedAt);
                this.#verifySync(files);
                return result;
              });
            row.skipped += count.skipped; row.planned += count.planned;
            if (!dryRun) row.imported += count.planned;
          } catch (error) {
            row.failed += Math.max(1, file.records.length); row.code = errorCode(error);
            if (row.code === 'SOURCE_CHANGED') break;
          }
        }
        await this.#verify(files);
        if (row.failed) row.status = source === 'douyin' ? 'optional-failed' : 'failed';
      } catch (error) {
        row.failed++; row.code = errorCode(error);
        row.status = source === 'douyin' ? (row.code === 'UNSUPPORTED_SCHEMA' ? 'optional-unsupported' : 'optional-failed') : 'failed';
      } finally {
        if (opened) { try { opened.exec('ROLLBACK'); } catch {} try { opened.close(); } catch {} }
        try { await this.#verify(files); } catch {
          row.failed++; row.code = 'SOURCE_CHANGED';
          row.status = source === 'douyin' ? 'optional-failed' : 'failed';
        }
      }
      if (source !== 'douyin' && row.status === 'failed') report.ok = false;
    }
    report.finishedAt = this.clock.now();
    if (!dryRun) {
      // A scan only creates due jobs. It never invokes review models or sends messages.
      if (report.ok && report.sources.some(row => row.imported)) {
        try { await this.scan?.(); } catch { report.scanCode = 'SCAN_FAILED'; }
      }
      try {
        await this.io.mkdir(this.paths.reports, { recursive: true });
        await this.io.writeFile(join(this.paths.reports, `import-${randomUUID()}.json`), JSON.stringify(report), { mode: 0o600 });
      } catch { report.reportCode = 'REPORT_FAILED'; }
    }
    return report;
  }
  async #files(source, path) {
    const files = [];
    const add = async (path, logical, required = false) => {
      try {
        const bytes = await this.io.readFile(path);
        files.push({ path, logical, bytes, sha256: fingerprint(bytes) });
      } catch (error) { if (required || error.code !== 'ENOENT') throw error; }
    };
    if (source === 'aurabot') {
      let names;
      try { names = await this.io.readdir(join(path, 'chatlog')); } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
      for (const name of names.filter(name => name.endsWith('.jsonl')).sort()) {
        // Logical names reveal no arbitrary source filename or account in manifests.
        const safeName = /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) ? name : `${fingerprint(name)}.jsonl`;
        await add(join(path, 'chatlog', name), `chatlog/${safeName}`, true);
      }
      for (const name of ['memories.json','diary.json']) await add(join(path, name), name);
    } else await add(path, source === 'pet' ? 'memory.json' : 'shared.sqlite');
    if (source === 'douyin' && files.length) {
      // The backup API includes WAL state; hash it as well to detect concurrent writers.
      try { files[0].wal = { path: `${path}-wal`, sha256: fingerprint(await this.io.readFile(`${path}-wal`)) }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; files[0].wal = { path: `${path}-wal`, sha256: null }; }
    }
    return files;
  }
  async #verify(files) {
    try {
      for (const file of files) {
        if (fingerprint(await this.io.readFile(file.path)) !== file.sha256) invalid('SOURCE_CHANGED');
        if (file.wal) {
          let hash = null; try { hash = fingerprint(await this.io.readFile(file.wal.path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (hash !== file.wal.sha256) invalid('SOURCE_CHANGED');
        }
      }
    } catch { invalid('SOURCE_CHANGED'); }
  }
  #verifySync(files) {
    try {
      for (const file of files) {
        if (fingerprint(readFileSync(file.path)) !== file.sha256) invalid('SOURCE_CHANGED');
        if (file.wal) {
          let hash = null; try { hash = fingerprint(readFileSync(file.wal.path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (hash !== file.wal.sha256) invalid('SOURCE_CHANGED');
        }
      }
    } catch { invalid('SOURCE_CHANGED'); }
  }
  async #snapshot(source, files, opened) {
    const root = join(this.paths.backups, 'import-sources', randomUUID());
    try {
      await this.io.mkdir(root, { recursive: true });
      const manifest = { source, time: this.clock.now(), protected: true, files: [] };
      for (const file of files) {
        const target = join(root, file.logical);
        await this.io.mkdir(dirname(target), { recursive: true });
        if (opened) await this.sqliteBackup(opened, target);
        else await this.io.writeFile(target, file.bytes, { mode: 0o600 });
        await syncFile(this.io, target);
        const bytes = await this.io.readFile(target);
        if (!opened && fingerprint(bytes) !== file.sha256) invalid('BACKUP_FAILED');
        manifest.files.push({ name: file.logical, sha256: fingerprint(bytes), size: bytes.length });
      }
      const target = join(root, 'manifest.json');
      await this.io.writeFile(target, JSON.stringify(manifest), { mode: 0o600 });
      await syncFile(this.io, target);
    } catch { invalid('BACKUP_FAILED'); }
  }
  #plan(db, source, records, seen) {
    let skipped = 0, planned = 0;
    for (const record of records) {
      const externalKey = record.type === 'event' ? JSON.stringify([record.value.source, record.value.sourceKey]) : null;
      const exists = externalKey && (db.prepare('SELECT 1 FROM memory_events WHERE external_key=?').get(externalKey)
        || db.prepare("SELECT 1 FROM purge_ledger WHERE source_hash=? AND object_kind='event'").get(fingerprint(`event\0${externalKey}`)));
      if (exists || seen.has(record.externalKey) || db.prepare('SELECT 1 FROM import_ledger WHERE source=? AND external_key=?').get(source, record.externalKey)) skipped++;
      else planned++;
      seen.add(record.externalKey);
    }
    return { skipped, planned };
  }
  #commit(db, source, records, now) {
    let skipped = 0, planned = 0;
    for (const record of records) {
      if (db.prepare('SELECT 1 FROM import_ledger WHERE source=? AND external_key=?').get(source, record.externalKey)) { skipped++; continue; }
      const value = record.value;
      let id = randomUUID(), result = 'imported';
      if (record.type === 'event') {
        const externalKey = JSON.stringify([value.source, value.sourceKey]);
        const existing = db.prepare('SELECT id FROM memory_events WHERE external_key=?').get(externalKey);
        const purged = db.prepare("SELECT 1 FROM purge_ledger WHERE source_hash=? AND object_kind='event'").get(fingerprint(`event\0${externalKey}`));
        if (existing || purged) { id = existing?.id ?? null; result = 'skipped'; }
        else db.prepare(`INSERT INTO memory_events(id,source,source_key,conversation_kind,conversation_key,actor_key,actor_name,direction,content_text,occurred_at,visibility,state,review_due_at,external_key,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`).run(id,value.source,value.sourceKey,value.conversationKind,value.conversationKey,value.actorKey,value.actorName,value.direction,value.contentText,value.occurredAt,value.visibility,value.occurredAt+this.config.shortTermDays*DAY,externalKey,now,now);
      } else if (record.type === 'item') db.prepare(`INSERT INTO memory_items(id,kind,subject_key,subject_name,content,importance,confidence,visibility,promoted_at,expires_at,state,source_refs_json,created_at,updated_at)
        VALUES(?,'fact',?,?,?,?,1,?,?,?,'active','[]',?,?)`).run(id,value.subjectKey,value.subjectName,value.content,value.importance,value.visibility,now,now+this.config.longTermDays*DAY,now,now);
      else db.prepare(`INSERT INTO diary_entries(id,title,body,written_at,visibility,source_refs_json,created_at,updated_at)
        VALUES(?,?,?,?,?,'[]',?,?)`).run(id,value.title,value.body,value.writtenAt,value.visibility,now,now);
      db.prepare('INSERT INTO import_ledger(source,external_key,fingerprint,result,target_type,target_id,imported_at) VALUES(?,?,?,?,?,?,?)')
        .run(source,record.externalKey,record.fingerprint,result,record.type,id,now);
      if (result === 'imported') planned++; else skipped++;
    }
    return { skipped, planned };
  }
}
