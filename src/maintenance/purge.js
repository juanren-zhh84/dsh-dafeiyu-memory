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

  runManual(input) {
    let target;
    try { target = snapshotTarget(input); if (!target) throw new Error(); }
    catch { return Promise.reject(maintenanceError('MEMORY_INVALID_INPUT')); }
    return this.database.writeQueue.enqueue(() => this.runUnlocked(target, true));
  }

  async runUnlocked(input, manual = false) {
    try {
      input = snapshotTarget(input);
      const now = this.clock.now();
      if (manual) {
        const table = input.kind === 'event' ? 'memory_events' : 'memory_items';
        const current = this.database.read((db) => db.prepare(`SELECT state,version FROM ${table} WHERE id=?`).get(input.id));
        if (current && (current.state !== 'recycle' || (input.version !== undefined && current.version !== input.version))) throw maintenanceError('MEMORY_CONFLICT');
      }
      const expiry = manual ? '1' : 'purge_due_at <= ?';
      const target = input ? 'WHERE kind = ? AND id = ?' + (input.version === undefined ? '' : ' AND version = ?') : '';
      const params = [...(manual ? [] : [now, now]), ...(input ? [input.kind, input.id, ...(input.version === undefined ? [] : [input.version])] : []), this.config.purgeBatchSize];
      const rows = this.database.read((db) => db.prepare(`SELECT * FROM (SELECT 'event' AS kind, id, external_key AS source_key, version, purge_due_at FROM memory_events
        WHERE state = 'recycle' AND ${expiry}
        UNION ALL SELECT 'item', id, id, version, purge_due_at FROM memory_items WHERE state = 'recycle' AND ${expiry})
        ${target} ORDER BY purge_due_at, kind, id LIMIT ?`).all(...params));
      if (!rows.length) return { deleted: 0 };
      await this.backupManager.createUnlocked('purge');
      const deleted = this.database.transaction((db) => {
        let count = 0;
        for (const row of rows) {
          const table = row.kind === 'event' ? 'memory_events' : 'memory_items';
          const check = [row.id, ...(manual ? [] : [now]), row.version];
          if (!db.prepare(`SELECT id FROM ${table} WHERE id = ? AND state = 'recycle' AND ${expiry} AND version = ?`)
            .get(...check)) continue;
          const hash = createHash('sha256').update(`${row.kind}\0${row.source_key}`).digest('hex');
          db.prepare('INSERT OR IGNORE INTO purge_ledger (source_hash, object_kind, purged_at) VALUES (?, ?, ?)').run(hash, row.kind, now);
          db.prepare('DELETE FROM memory_recall_days WHERE memory_type = ? AND memory_id = ?').run(row.kind, row.id);
          count += Number(db.prepare(`DELETE FROM ${table} WHERE id = ? AND state = 'recycle' AND ${expiry} AND version = ?`).run(...check).changes);
        }
        return count;
      });
      this.reclaimUnlocked();
      return { deleted };
    } catch (error) {
      const code = safeErrorCode(error);
      if (['MEMORY_BACKUP_FAILED', 'MEMORY_INVALID_INPUT', 'MEMORY_CONFLICT'].includes(code)) throw maintenanceError(code);
      throw maintenanceError('MEMORY_PURGE_FAILED');
    }
  }

  reclaimUnlocked() {
    this.database.checkpoint();
    this.database.read((db) => {
      const free = db.prepare('PRAGMA freelist_count').get().freelist_count;
      const pages = db.prepare('PRAGMA page_count').get().page_count;
      const threshold = this.config.incrementalVacuumFreeRatio;
      if (Number.isFinite(threshold) && threshold >= 0.2 && threshold <= 1 && pages > 0 && free / pages >= threshold) {
        db.exec('PRAGMA incremental_vacuum');
      }
    });
  }
}
