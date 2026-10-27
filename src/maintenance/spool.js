import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshotEventInput } from '../memory/repository.js';
import { maintenanceError, syncFile, safeErrorCode } from './backup.js';

export class EventSpool {
  #draining;
  constructor({ paths, config, writeQueue, recordEvent, canGrow = () => true, io = fs }) {
    Object.assign(this, { paths, config, writeQueue, recordEvent, canGrow, io });
    this.pending = join(paths.spool, 'events.jsonl');
    this.batch = join(paths.spool, 'draining.jsonl');
  }

  async #read(path) {
    try { return await this.io.readFile(path, 'utf8'); } catch (error) { if (safeErrorCode(error) === 'ENOENT') return ''; throw error; }
  }

  async #replace(path, text) {
    const temp = `${path}.tmp`;
    try {
      await this.io.writeFile(temp, text, { mode: 0o600 });
      await syncFile(this.io, temp);
      await this.io.rename(temp, path);
    } finally { await this.io.rm(temp, { force: true }).catch(() => {}); }
  }

  enqueue(input) {
    let line;
    try { line = `${JSON.stringify(snapshotEventInput(input, this.config))}\n`; }
    catch { return Promise.reject(maintenanceError('MEMORY_INVALID_INPUT')); }
    return this.writeQueue.enqueue(async () => {
      try {
        const current = await this.#read(this.pending);
        const draining = await this.#read(this.batch);
        const entries = [current, draining].reduce((n, text) => n + (text ? text.split('\n').filter(Boolean).length : 0), 0);
        if (!this.canGrow() || entries >= this.config.spoolMaxEntries
          || Buffer.byteLength(current + draining + line) > this.config.spoolLimitBytes) throw maintenanceError('MEMORY_SPOOL_FULL');
        await this.io.mkdir(this.paths.spool, { recursive: true });
        await this.#replace(this.pending, current + line);
        return { queued: true };
      } catch (error) { throw maintenanceError(safeErrorCode(error) === 'MEMORY_SPOOL_FULL' ? 'MEMORY_SPOOL_FULL' : 'MEMORY_SPOOL_FAILED'); }
    });
  }

  drain() {
    if (!this.#draining) this.#draining = this.#drain().finally(() => { this.#draining = undefined; });
    return this.#draining;
  }

  async settle() { try { await this.#draining; } catch { /* Durable batch remains available after reload. */ } }

  async #drain() {
    try {
      const text = await this.writeQueue.enqueue(async () => {
        await this.io.mkdir(this.paths.spool, { recursive: true });
        const previous = await this.#read(this.batch);
        const pending = await this.#read(this.pending);
        if (previous) {
          if (!pending) return previous;
          // Publish the merged retry batch before clearing pending. Exact line deduplication
          // makes a crash between these writes safe; repository external keys fence replay.
          const lines = [...new Set([...previous.split('\n'), ...pending.split('\n')].filter(Boolean))];
          const merged = `${lines.join('\n')}\n`;
          await this.#replace(this.batch, merged);
          await this.#replace(this.pending, '');
          return merged;
        }
        if (!pending) return '';
        await this.io.rename(this.pending, this.batch);
        return pending;
      });
      const result = { recorded: 0, retained: 0, invalid: 0 };
      if (!text) return result;
      const failed = [], errors = [];
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      for (const [index, line] of lines.entries()) {
        let input, code;
        try { input = JSON.parse(line); } catch { code = 'MEMORY_SPOOL_INVALID_JSON'; }
        if (!code) {
          try { input = snapshotEventInput(input, this.config); } catch { code = 'MEMORY_SPOOL_INVALID_INPUT'; }
        }
        if (code) { errors.push({ line: index + 1, code }); result.invalid++; continue; }
        try { await this.recordEvent(input); result.recorded++; }
        catch { failed.push(line); result.retained++; }
      }
      await this.writeQueue.enqueue(async () => {
        if (errors.length) {
          await this.io.mkdir(this.paths.reports, { recursive: true });
          await this.#replace(join(this.paths.reports, `spool-${randomUUID()}.json`), JSON.stringify(errors));
        }
        if (failed.length) {
          await this.#replace(this.batch, `${failed.join('\n')}\n`);
          if (!(await this.#read(this.pending))) await this.io.rename(this.batch, this.pending);
        } else {
          // Publication precedes batch removal; a crash replays idempotent events safely.
          if (!(await this.#read(this.pending))) await this.#replace(this.pending, '');
          await this.io.rm(this.batch, { force: true });
        }
      });
      return result;
    } catch { throw maintenanceError('MEMORY_SPOOL_FAILED'); }
  }
}
