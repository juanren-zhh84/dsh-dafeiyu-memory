import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { backup } from 'node:sqlite';
import { memoryError } from '../contracts.js';

export const maintenanceError = (code) => memoryError(code, {
  MEMORY_BACKUP_FAILED: 'Memory backup failed', MEMORY_PURGE_FAILED: 'Memory purge failed',
  MEMORY_CAPACITY_FAILED: 'Memory capacity check failed', MEMORY_SPOOL_FAILED: 'Memory spool operation failed',
  MEMORY_SPOOL_FULL: 'Memory spool is full', MEMORY_INVALID_INPUT: 'Invalid memory input',
}[code] ?? 'Memory maintenance failed');

export function safeErrorCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

// Flush and close our own descriptor after the SQLite backup Promise completes.
export async function syncFile(io, path) {
  const handle = await io.open(path, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

export class BackupManager {
  constructor({ database, paths, config, writeQueue = database?.writeQueue, clock = Date, io = fs, backup: implementation = backup }) {
    Object.assign(this, { database, paths, config, writeQueue, clock, io, implementation });
  }

  create(reason = 'manual', protectedBackup = false) {
    return this.writeQueue.enqueue(() => this.createUnlocked(reason, protectedBackup));
  }

  async readManifest() {
    try {
      const records = JSON.parse(await this.io.readFile(join(this.paths.backups, 'manifest.json'), 'utf8'));
      if (!Array.isArray(records) || records.some((record) => !record || typeof record.id !== 'string'
        || !/^[a-f0-9-]{36}$/.test(record.id) || !Number.isSafeInteger(record.time)
        || !Number.isSafeInteger(record.size) || record.size < 0 || typeof record.protected !== 'boolean'
        || !['manual', 'purge', 'migration'].includes(record.reason) || !/^[a-f0-9]{64}$/.test(record.sha256)
        || Object.keys(record).sort().join(',') !== 'id,protected,reason,sha256,size,time')) throw new Error();
      return records;
    }
    catch (error) { if (safeErrorCode(error) === 'ENOENT') return []; throw error; }
  }

  prune() { return this.writeQueue.enqueue(() => this.pruneUnlocked()); }

  async pruneUnlocked(keepId) {
    try {
      const records = await this.readManifest();
      let total = 0;
      const sizes = new Map();
      const removed = new Set();
      for (const record of records) {
        try {
          const size = (await this.io.stat(join(this.paths.backups, `${record.id}.sqlite`))).size;
          sizes.set(record.id, size); total += size;
        } catch (error) {
          if (safeErrorCode(error) !== 'ENOENT' || record.protected || record.id === keepId) throw error;
          removed.add(record.id);
        }
      }
      const cutoff = this.clock.now() - this.config.backupRetentionDays * 86_400_000;
      const newest = records.at(-1)?.id;
      for (const record of [...records].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))) {
        if (removed.has(record.id) || record.protected || record.id === keepId
          || (record.id === newest && record.time > cutoff)
          || (record.time > cutoff && total <= this.config.backupLimitBytes)) continue;
        await this.io.rm(join(this.paths.backups, `${record.id}.sqlite`), { force: true });
        total -= sizes.get(record.id); removed.add(record.id);
      }
      if (removed.size) await this.saveManifest(records.filter((record) => !removed.has(record.id)));
      return { deleted: removed.size, overLimit: total > this.config.backupLimitBytes };
    } catch { throw maintenanceError('MEMORY_BACKUP_FAILED'); }
  }

  releaseProtectedBackup(id) {
    return this.writeQueue.enqueue(async () => {
      try {
        const records = await this.readManifest();
        if (!records.some((record) => record.id === id)) throw new Error();
        await this.saveManifest(records.map((record) => record.id === id ? { ...record, protected: false } : record));
        return { released: true };
      } catch { throw maintenanceError('MEMORY_BACKUP_FAILED'); }
    });
  }

  async saveManifest(records) {
    const target = join(this.paths.backups, 'manifest.json');
    const temp = `${target}.tmp`;
    try {
      await this.io.writeFile(temp, JSON.stringify(records), { mode: 0o600 });
      await syncFile(this.io, temp);
      await this.io.rename(temp, target);
    } finally { await this.io.rm(temp, { force: true }).catch(() => {}); }
  }

  // Internal methods ending in Unlocked require the caller to hold writeQueue.
  async createUnlocked(reason = 'manual', protectedBackup = false) {
    if (!['manual', 'purge', 'migration'].includes(reason)) throw maintenanceError('MEMORY_INVALID_INPUT');
    const id = randomUUID();
    const target = join(this.paths.backups, `${id}.sqlite`);
    const temp = `${target}.tmp`;
    let published = false;
    let record;
    try {
      await this.io.mkdir(this.paths.backups, { recursive: true });
      const records = await this.readManifest();
      await this.database.backupTo(temp, this.implementation);
      await syncFile(this.io, temp);
      const bytes = await this.io.readFile(temp);
      record = { id, time: this.clock.now(), size: bytes.length, reason,
        sha256: createHash('sha256').update(bytes).digest('hex'), protected: Boolean(protectedBackup) };
      await this.io.rename(temp, target);
      published = true;
      await this.saveManifest([...records, record]);
    } catch {
      if (published) await this.io.rm(target, { force: true }).catch(() => {});
      throw maintenanceError('MEMORY_BACKUP_FAILED');
    } finally { await this.io.rm(temp, { force: true }).catch(() => {}); }
    // Cleanup failure does not turn an already committed, durable snapshot into a failed backup.
    // Keep the latest snapshot even if it alone, or protected snapshots, exceed the cap.
    try {
      const { overLimit } = await this.pruneUnlocked(id);
      await this.io.stat(target);
      return { ...record, overLimit };
    } catch {
      try { await this.io.stat(target); } catch { throw maintenanceError('MEMORY_BACKUP_FAILED'); }
      return { ...record, overLimit: true, cleanupErrorCode: 'MEMORY_BACKUP_FAILED' };
    }
  }
}
