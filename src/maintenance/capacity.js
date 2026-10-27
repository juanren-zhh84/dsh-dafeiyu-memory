import * as fs from 'node:fs';
import { join } from 'node:path';
import { safeErrorCode } from './backup.js';

export class CapacityManager {
  constructor({ paths, config, database, backupManager, purgeManager, io = fs }) {
    Object.assign(this, { paths, config, database, backupManager, purgeManager, io });
    this.lastErrorCode = null;
  }

  #size(path) {
    let stat;
    try { stat = this.io.lstatSync(path); } catch (error) { if (safeErrorCode(error) === 'ENOENT') return 0; throw error; }
    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return stat.size;
    if (stat.isDirectory()) return this.io.readdirSync(path).reduce((sum, name) => sum + this.#size(join(path, name)), 0);
    return 0;
  }

  status() {
    try {
      const databaseBytes = ['', '-wal', '-shm'].reduce((sum, suffix) => sum + this.#size(`${this.paths.database}${suffix}`), 0);
      const backupsBytes = this.#size(this.paths.backups);
      const spoolBytes = this.#size(this.paths.spool);
      const reportsBytes = this.#size(this.paths.reports);
      const totalBytes = databaseBytes + backupsBytes + spoolBytes + reportsBytes;
      const ratio = totalBytes / this.config.diskSoftLimitBytes;
      return { state: ratio >= 1 ? 'degraded' : ratio >= this.config.diskWarningRatio ? 'warning' : 'ready',
        totalBytes, databaseBytes, backupsBytes, spoolBytes, reportsBytes, lastErrorCode: this.lastErrorCode };
    } catch { return { state: 'degraded', lastErrorCode: 'MEMORY_CAPACITY_FAILED' }; }
  }

  run() {
    return this.database.writeQueue.enqueue(async () => {
      this.lastErrorCode = null;
      const phases = [
        async () => {
          // Recycle expiry also applies below the disk warning threshold.
          while ((await this.purgeManager.runUnlocked()).deleted) { /* Each bounded round has a new completed backup. */ }
        },
        () => this.backupManager.pruneUnlocked(),
        () => this.purgeManager.reclaimUnlocked(),
      ];
      for (const phase of phases) {
        try { await phase(); } catch (error) {
          this.lastErrorCode ??= ['MEMORY_BACKUP_FAILED', 'MEMORY_PURGE_FAILED'].includes(safeErrorCode(error))
            ? safeErrorCode(error) : 'MEMORY_CAPACITY_FAILED';
        }
      }
      return this.status();
    });
  }
}
