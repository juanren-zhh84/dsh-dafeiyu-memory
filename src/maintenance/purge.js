import { createHash } from 'node:crypto';
import { maintenanceError, safeErrorCode } from './backup.js';

function snapshotTarget(input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw maintenanceError('MEMORY_INVALID_INPUT');
  const copy = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!['kind', 'id', 'version'].includes(key) || !Object.hasOwn(descriptor, 'value')) throw maintenanceError('MEMORY_INVALID_INPUT');
    copy[key] = descriptor.value;
  }
  if (!['event', 'item'].includes(copy.kind) || typeof copy.id !== 'string' || !copy.id || copy.id.length > 512
    || (copy.version !== undefined && (!Number.isSafeInteger(copy.version) || copy.version < 1))) throw maintenanceError('MEMORY_INVALID_INPUT');
  return copy;
}

export class PurgeManager {
  constructor({ database, backupManager, config, clock = Date }) {
    Object.assign(this, { database, backupManager, config, clock });
  }

  run(input) {
    let target;
    try { target = snapshotTarget(input); } catch { return Promise.reject(maintenanceError('MEMORY_INVALID_INPUT')); }
    return this.database.writeQueue.enqueue(() => this.runUnlocked(target));
  }

  async runUnlocked(input) {
    try {
      input = snapshotTarget(input);
      const now = this.clock.now();
      const target = input ? 'WHERE kind = ? AND id = ?' + (input.version === undefined ? '' : ' AND version = ?') : '';
      const params = [now, now, ...(input ? [input.kind, input.id, ...(input.version === undefined ? [] : [input.version])] : []), this.config.purgeBatchSize];
      const rows = this.database.read((db) => db.prepare(`SELECT * FROM (SELECT 'event' AS kind, id, external_key AS source_key, version, purge_due_at FROM memory_events
        WHERE state = 'recycle' AND purge_due_at <= ?
        UNION ALL SELECT 'item', id, id, version, purge_due_at FROM memory_items WHERE state = 'recycle' AND purge_due_at <= ?)
        ${target} ORDER BY purge_due_at, kind, id LIMIT ?`).all(...params));
      if (!rows.length) return { deleted: 0 };
      await this.backupManager.createUnlocked('purge');
      const deleted = this.database.transaction((db) => {
        let count = 0;
        for (const row of rows) {
          const table = row.kind === 'event' ? 'memory_events' : 'memory_items';
          if (!db.prepare(`SELECT id FROM ${table} WHERE id = ? AND state = 'recycle' AND purge_due_at <= ? AND version = ?`)
            .get(row.id, now, row.version)) continue;
          const hash = createHash('sha256').update(`${row.kind}\0${row.source_key}`).digest('hex');
          db.prepare('INSERT OR IGNORE INTO purge_ledger (source_hash, object_kind, purged_at) VALUES (?, ?, ?)').run(hash, row.kind, now);
          db.prepare('DELETE FROM memory_recall_days WHERE memory_type = ? AND memory_id = ?').run(row.kind, row.id);
          count += Number(db.prepare(`DELETE FROM ${table} WHERE id = ? AND state = 'recycle' AND purge_due_at <= ? AND version = ?`).run(row.id, now, row.version).changes);
        }
        return count;
      });
      this.reclaimUnlocked();
      return { deleted };
    } catch (error) {
      const code = safeErrorCode(error);
      if (['MEMORY_BACKUP_FAILED', 'MEMORY_INVALID_INPUT'].includes(code)) throw maintenanceError(code);
      throw maintenanceError('MEMORY_PURGE_FAILED');
    }
  }

  reclaimUnlocked() {
    this.database.checkpoint();
    this.database.read((db) => {
      const free = db.prepare('PRAGMA freelist_count').get().freelist_count;
      const pages = db.prepare('PRAGMA page_count').get().page_count;
      if (pages > 0 && free / pages >= this.config.incrementalVacuumFreeRatio) db.exec('PRAGMA incremental_vacuum');
    });
  }
}
