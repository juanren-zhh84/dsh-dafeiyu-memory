import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG } from '../config.js';
import { memoryError, MEMORY_INPUT_LIMITS } from '../contracts.js';
import { snapshotReviewRequest, validateReviewDecision } from './protocol.js';

const ERROR_CODES = new Set(['MEMORY_CONFLICT', 'MEMORY_STORAGE_FAILED', 'MEMORY_REVIEW_INVALID_INPUT',
  'MEMORY_REVIEW_INVALID_PROTOCOL', 'MEMORY_REVIEW_MODEL_FAILED', 'MEMORY_REVIEW_STREAM_FAILED', 'MEMORY_REVIEW_TIMEOUT']);
export function reviewFailureCode(error) {
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (ERROR_CODES.has(code)) return code;
  } catch {}
  return 'MEMORY_REVIEW_MODEL_FAILED';
}
function safeError(code) { return memoryError(code, code); }
function timestamp(value) {
  if (!Number.isSafeInteger(value)) throw safeError('MEMORY_INVALID_INPUT');
  return value;
}

/** Model calls are outside the serial write queue; every commit carries its lease generation. */
export class ReviewLifecycle {
  #running;
  #disposed = false;
  #controller;
  #closing;

  constructor({ database, repository, reviewModel, config = DEFAULT_CONFIG, clock = Date }) {
    Object.assign(this, { database, repository, reviewModel, config, clock });
  }

  #assertOpen() { if (this.#disposed) throw safeError('MEMORY_DISPOSED'); }

  async scan() {
    this.#assertOpen();
    try {
      return await this.database.write((db) => {
        if (this.#disposed) return { queued: 0 };
        const now = timestamp(this.clock.now());
        const maximum = Math.min(this.config.reviewBatchSize, MEMORY_INPUT_LIMITS.reviewBatch);
        let queued = 0;
        const createJob = (kind, rows) => {
          const ids = rows.map(({ id }) => id);
          const candidates = rows.map(({ id, version }) => ({ id, version }));
          const batchKey = `${kind}:${createHash('sha256').update(JSON.stringify([kind, candidates])).digest('hex')}`;
          const result = db.prepare(`INSERT OR IGNORE INTO review_jobs
            (id,kind,batch_key,source_ids_json,state,due_at,next_attempt_at,created_at,updated_at)
            VALUES (?,?,?,?,'queued',?,?,?,?)`).run(randomUUID(), kind, batchKey, JSON.stringify(ids),
              Math.min(...rows.map((r) => kind === 'short-term' ? r.review_due_at : r.expires_at)), now, now, now);
          if (!result.changes) return;
          queued++;
          if (kind === 'short-term') for (const id of ids) db.prepare(`UPDATE memory_events
            SET state='review-pending', updated_at=? WHERE id=? AND state='active'`).run(now, id);
        };
        let batch = [];
        let group;
        const flush = () => { if (batch.length) createJob('short-term', batch); batch = []; };
        for (const row of db.prepare(`SELECT id, version, conversation_kind, conversation_key, review_due_at FROM memory_events
          WHERE state='active' AND review_due_at<=? AND NOT EXISTS (
            SELECT 1 FROM review_jobs AS job,json_each(job.source_ids_json) AS source
            WHERE job.kind='short-term' AND job.state IN ('queued','leased') AND source.value=memory_events.id
          ) ORDER BY conversation_kind,conversation_key,occurred_at,id`).all(now)) {
          const key = JSON.stringify([row.conversation_kind, row.conversation_key]);
          if (key !== group || batch.length >= maximum) flush();
          group = key; batch.push(row);
        }
        flush();
        for (const row of db.prepare(`SELECT id,version,expires_at FROM memory_items
          WHERE state='active' AND expires_at<=? AND NOT EXISTS (
            SELECT 1 FROM review_jobs AS job,json_each(job.source_ids_json) AS source
            WHERE job.kind='long-term' AND job.state IN ('queued','leased') AND source.value=memory_items.id
          ) ORDER BY expires_at,id`).all(now)) createJob('long-term', [row]);
        return { queued };
      });
    } catch { throw safeError('MEMORY_STORAGE_FAILED'); }
  }

  async #claim() {
    return this.database.write((db) => {
      if (this.#disposed) return;
      const now = timestamp(this.clock.now());
      const job = db.prepare(`SELECT * FROM review_jobs WHERE
        (state='queued' AND COALESCE(next_attempt_at,due_at)<=?) OR (state='leased' AND lease_until<=?)
        ORDER BY due_at,id LIMIT 1`).get(now, now);
      if (!job) return;
      if (job.attempts >= this.config.reviewMaxAttempts) {
        db.prepare(`UPDATE review_jobs SET state='failed',lease_until=NULL,next_attempt_at=NULL,
          last_error_code='MEMORY_REVIEW_TIMEOUT',updated_at=? WHERE id=?`).run(now, job.id);
        return { exhausted: true };
      }
      job.lease_until = timestamp(now + this.config.reviewLeaseMs);
      job.attempts++;
      db.prepare(`UPDATE review_jobs SET state='leased',lease_until=?,attempts=?,updated_at=? WHERE id=?`)
        .run(job.lease_until, job.attempts, now, job.id);
      return job;
    });
  }

  #load(job) {
    return this.database.read((db) => {
      const short = job.kind === 'short-term';
      const table = short ? 'memory_events' : 'memory_items';
      const now = timestamp(this.clock.now());
      const rows = JSON.parse(job.source_ids_json).map((id) => {
        const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
        if (!row || !(short ? ['active', 'review-pending'].includes(row.state) && row.review_due_at <= now
          : row.state === 'active' && row.expires_at <= now)) throw safeError('MEMORY_CONFLICT');
        return row;
      });
      if (short && rows.some((row) => row.conversation_kind !== rows[0].conversation_kind || row.conversation_key !== rows[0].conversation_key)) {
        throw safeError('MEMORY_CONFLICT');
      }
      const request = snapshotReviewRequest({ mode: job.kind, candidates: rows.map((row) => ({ id: row.id, version: row.version,
        content: short ? row.content_text : row.content, visibility: row.visibility })) });
      return { rows, request };
    });
  }

  async #settleFailure(job, error, release = false) {
    const code = reviewFailureCode(error);
    return this.database.write((db) => {
      const now = timestamp(this.clock.now());
      const failed = !release && job.attempts >= this.config.reviewMaxAttempts;
      const delay = Math.min(this.config.retryBaseMs * 2 ** Math.min(job.attempts - 1, 52), this.config.retryMaxMs);
      const result = db.prepare(`UPDATE review_jobs SET state=?,lease_until=NULL,next_attempt_at=?,last_error_code=?,updated_at=?
        WHERE id=? AND state='leased' AND attempts=? AND lease_until=?`).run(failed ? 'failed' : 'queued',
          failed ? null : timestamp(now + (release ? 0 : delay)), release ? null : code, now, job.id, job.attempts, job.lease_until);
      return result.changes ? (failed ? 'failed' : release ? 'released' : 'retried') : 'stale';
    });
  }

  async #process(job) {
    const controller = this.#controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(this.config.reviewTimeoutMs, this.config.reviewLeaseMs))]);
    let onAbort;
    try {
      const { rows, request } = this.#load(job);
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(safeError('MEMORY_REVIEW_TIMEOUT'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      const raw = await Promise.race([Promise.resolve().then(() => {
        signal.throwIfAborted(); return this.reviewModel.review(request, { signal });
      }), aborted]);
      signal.throwIfAborted();
      const decision = validateReviewDecision(raw, request);
      const input = { jobId: job.id, candidates: request.candidates.map(({ id, version }) => ({ id, version })),
        lease: { attempts: job.attempts, leaseUntil: job.lease_until }, ...decision };
      if (job.kind === 'short-term') {
        // Account identifiers and actor-provided display names never become model instructions or subject names.
        input.retain = decision.retain.map((item) => ({ ...item, subjectKey: rows[0].conversation_key,
          subjectName: rows[0].conversation_kind === 'group' ? '群聊' : rows[0].conversation_kind === 'private' ? '私聊' : '会话' }));
        await this.repository.promoteEvents(input);
      } else await this.repository.completeLongTermReview(input);
      return 'completed';
    } catch (error) {
      return this.#settleFailure(job, error, this.#disposed);
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.#controller = undefined;
    }
  }

  runDueReviews() {
    if (this.#disposed) return Promise.reject(safeError('MEMORY_DISPOSED'));
    if (!this.#running) {
      this.#running = this.#run().finally(() => { this.#running = undefined; });
    }
    return this.#running;
  }

  async #run() {
    try {
      const summary = { ...(await this.scan()), completed: 0, retried: 0, failed: 0 };
      while (!this.#disposed) {
        const job = await this.#claim();
        if (!job) break;
        if (job.exhausted) { summary.failed++; continue; }
        if (this.#disposed) { await this.#settleFailure(job, undefined, true); break; }
        const result = await this.#process(job);
        if (Object.hasOwn(summary, result)) summary[result]++;
      }
      return summary;
    } catch { throw safeError('MEMORY_STORAGE_FAILED'); }
  }

  dispose() {
    if (!this.#closing) {
      this.#disposed = true;
      this.#controller?.abort();
      this.#closing = Promise.resolve(this.#running).then(() => undefined, () => undefined);
    }
    return this.#closing;
  }
}
