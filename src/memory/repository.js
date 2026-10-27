import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG } from '../config.js';
import { MEMORY_INPUT_LIMITS as LIMIT, memoryError } from '../contracts.js';

const DAY = 86_400_000;
const VISIBILITY = ['owner-private', 'conversation', 'group', 'public'];
const ERRORS = Object.freeze({
  MEMORY_INVALID_INPUT: 'Invalid memory input',
  MEMORY_STORAGE_FAILED: 'Memory storage operation failed',
  MEMORY_REFERENCE_NOT_FOUND: 'Memory reference was not found',
  MEMORY_CONFLICT: 'Memory state or version changed',
  MEMORY_QUEUE_CLOSED: 'Memory write queue is closed',
  MEMORY_DATABASE_CLOSED: 'Memory database is closed',
});

function fail(code = 'MEMORY_INVALID_INPUT') { throw publicError(code); }
function publicError(code) {
  const safeCode = typeof code === 'string' && Object.hasOwn(ERRORS, code) ? code : 'MEMORY_STORAGE_FAILED';
  return memoryError(safeCode, ERRORS[safeCode]);
}
function sanitize(error) {
  let code;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (descriptor && Object.hasOwn(descriptor, 'value')) code = descriptor.value;
  } catch {}
  return publicError(code);
}

// Inspect descriptors so caller-controlled accessors never execute.
function ownObject(input, fields) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!fields.includes(key) || !Object.hasOwn(descriptor, 'value')) fail();
    result[key] = descriptor.value;
  }
  return result;
}

function text(value, maximum, empty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail();
  return value;
}
function integer(value) { if (!Number.isSafeInteger(value)) fail(); return value; }
function oneOf(value, choices) { if (!choices.includes(value)) fail(); return value; }
function addDays(time, days) { return integer(time + integer(days) * DAY); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function list(input, maximum, minimum = 0) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype
    || input.length < minimum || input.length > maximum) fail();
  if (Reflect.ownKeys(input).length !== input.length + 1) fail();
  const result = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
    result.push(descriptor.value);
  }
  return result;
}
function references(input, minimum = 0) {
  const refs = list(input, LIMIT.sourceRefs, minimum).map((value) => text(value, LIMIT.key));
  if (new Set(refs).size !== refs.length) fail();
  return refs;
}
function unit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail();
  return value;
}
function supersedes(value) { return value === undefined ? null : text(value, LIMIT.key); }
function strictest(rows) { return VISIBILITY[Math.min(...rows.map(({ visibility }) => VISIBILITY.indexOf(visibility)))]; }
function dto(row) {
  if (!row) return undefined;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key === 'source_refs_json' ? 'sourceRefs' : key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
    key === 'source_refs_json' ? JSON.parse(value) : value,
  ]));
}

function mediaReferences(input = []) {
  return list(input, LIMIT.mediaRefs).map((value) => {
    const ref = text(value, LIMIT.mediaRef);
    if (/[\x00-\x1f\x7f]/.test(ref) || /^(?:data|blob|base64):/i.test(ref.trim())) fail();
    return ref;
  });
}

function diaryDecision(input, fromBatch = false) {
  const data = ownObject(input, fromBatch ? ['title', 'body', 'sourceIds', 'supersedesId']
    : ['title', 'body', 'sourceRefs', 'supersedesId', 'visibility']);
  const inputRefs = fromBatch ? data.sourceIds : data.sourceRefs;
  const sourceRefs = references(inputRefs === undefined ? [] : inputRefs, fromBatch ? 1 : 0);
  if (sourceRefs.length && Object.hasOwn(data, 'visibility')) fail();
  return { title: text(data.title, LIMIT.diaryTitle), body: text(data.body, LIMIT.diaryBody), sourceRefs,
    supersedesId: supersedes(data.supersedesId),
    visibility: !sourceRefs.length ? oneOf(data.visibility === undefined ? 'owner-private' : data.visibility, VISIBILITY) : undefined };
}

function retainedDecision(input) {
  const data = ownObject(input, ['sourceIds', 'kind', 'subjectKey', 'subjectName', 'content', 'importance', 'confidence', 'supersedesId']);
  return { sourceRefs: references(data.sourceIds, 1),
    kind: oneOf(data.kind, ['fact', 'preference', 'relationship', 'experience', 'behavior-note']),
    subjectKey: text(data.subjectKey, LIMIT.key), subjectName: text(data.subjectName, LIMIT.name, true),
    content: text(data.content, LIMIT.itemContent), importance: unit(data.importance),
    confidence: unit(data.confidence === undefined ? 1 : data.confidence), supersedesId: supersedes(data.supersedesId) };
}

function reviewLease(input) {
  if (input === undefined) return;
  const lease = ownObject(input, ['attempts', 'leaseUntil']);
  if (integer(lease.attempts) < 1) fail();
  return { attempts: lease.attempts, leaseUntil: integer(lease.leaseUntil) };
}

function assertLease(job, lease, now) {
  if (lease && (job.state !== 'leased' || job.attempts !== lease.attempts || job.lease_until !== lease.leaseUntil
    || lease.leaseUntil <= now)) fail('MEMORY_CONFLICT');
}

function assertTarget(db, table, id) {
  if (id !== null && !db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)) fail('MEMORY_REFERENCE_NOT_FOUND');
}

function appendDiaryRow(db, entry, id, now) {
  assertTarget(db, 'diary_entries', entry.supersedesId);
  db.prepare(`INSERT INTO diary_entries (id, title, body, written_at, visibility, source_refs_json,
    supersedes_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, entry.title, entry.body, now, entry.visibility, JSON.stringify(entry.sourceRefs), entry.supersedesId, now, now);
  return dto(db.prepare('SELECT * FROM diary_entries WHERE id = ?').get(id));
}

function normalizeEvent(input, config) {
  const data = ownObject(input, ['source', 'sourceKey', 'conversationKind', 'conversationKey', 'actorKey', 'actorName',
    'direction', 'contentText', 'occurredAt', 'visibility', 'mediaRefs']);
  const source = oneOf(data.source, ['qq', 'pet', 'douyin']);
  const conversationKind = oneOf(data.conversationKind, ['private', 'group', 'pet', 'system']);
  const conversationKey = text(data.conversationKey, LIMIT.key);
  const actorKey = text(data.actorKey, LIMIT.key);
  const actorName = text(data.actorName, LIMIT.name, true);
  const direction = oneOf(data.direction, ['incoming', 'outgoing']);
  const occurredAt = integer(data.occurredAt);
  const visibility = oneOf(data.visibility, VISIBILITY);
  const originalText = text(data.contentText, LIMIT.eventText, true);
  const normalizedText = originalText.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const refs = mediaReferences(data.mediaRefs);
  const contentText = text([originalText, ...refs.map((ref) => `[media:${ref}]`)].filter(Boolean).join('\n'), LIMIT.eventText);
  const sourceKey = data.sourceKey === undefined
    ? hash(JSON.stringify([source, conversationKey, direction, occurredAt, normalizedText]))
    : text(data.sourceKey, LIMIT.key);
  return { source, sourceKey, conversationKind, conversationKey, actorKey, actorName, direction,
    occurredAt, visibility, contentText, reviewDueAt: addDays(occurredAt, config.shortTermDays),
    externalKey: JSON.stringify([source, sourceKey]) };
}

/** A validated minimal DTO for offline persistence, without retaining caller objects. */
export function snapshotEventInput(input, config = DEFAULT_CONFIG) {
  const fields = ['source', 'sourceKey', 'conversationKind', 'conversationKey', 'actorKey', 'actorName', 'direction',
    'contentText', 'occurredAt', 'visibility', 'mediaRefs'];
  const data = ownObject(input, fields);
  if (Object.hasOwn(data, 'mediaRefs')) data.mediaRefs = mediaReferences(data.mediaRefs);
  const normalized = normalizeEvent(data, config);
  const snapshot = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(data, key);
    if (descriptor) snapshot[key] = key === 'mediaRefs' ? mediaReferences(descriptor.value) : descriptor.value;
  }
  snapshot.sourceKey = normalized.sourceKey;
  return snapshot;
}

export class MemoryRepository {
  constructor({ database, writeQueue = database.writeQueue, config = DEFAULT_CONFIG, clock = Date, idGenerator = randomUUID }) {
    this.database = database;
    this.writeQueue = writeQueue;
    this.config = config;
    this.clock = clock;
    this.idGenerator = idGenerator;
  }

  async #mutate(prepare) {
    try {
      const transaction = prepare();
      return await this.writeQueue.enqueue(() => this.database.transaction(transaction));
    } catch (error) { throw sanitize(error); }
  }

  #read(operation) {
    try { return operation(); } catch (error) { throw sanitize(error); }
  }

  insertEvent(input) {
    return this.#mutate(() => {
      const event = normalizeEvent(input, this.config);
      return (db) => {
        const existing = db.prepare('SELECT * FROM memory_events WHERE external_key = ?').get(event.externalKey);
        if (existing) return dto(existing);
        const id = text(this.idGenerator(), LIMIT.key);
        const now = integer(this.clock.now());
        db.prepare(`INSERT INTO memory_events (id, source, source_key, conversation_kind, conversation_key,
          actor_key, actor_name, direction, content_text, occurred_at, visibility, state, review_due_at,
          external_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
          .run(id, event.source, event.sourceKey, event.conversationKind, event.conversationKey, event.actorKey,
            event.actorName, event.direction, event.contentText, event.occurredAt, event.visibility,
            event.reviewDueAt, event.externalKey, now, now);
        return dto(db.prepare('SELECT * FROM memory_events WHERE id = ?').get(id));
      };
    });
  }

  appendDiary(input) {
    return this.#mutate(() => {
      const entry = diaryDecision(input);
      return (db) => {
        if (entry.sourceRefs.length) {
          const sources = entry.sourceRefs.map((id) => {
            for (const table of ['memory_events', 'memory_items', 'diary_entries']) {
              const row = db.prepare(`SELECT visibility FROM ${table} WHERE id = ?`).get(id);
              if (row) return row;
            }
            fail('MEMORY_REFERENCE_NOT_FOUND');
          });
          entry.visibility = strictest(sources);
        }
        return appendDiaryRow(db, entry, text(this.idGenerator(), LIMIT.key), integer(this.clock.now()));
      };
    });
  }

  promoteEvents(input) {
    return this.#mutate(() => {
      const data = ownObject(input, ['jobId', 'candidates', 'retain', 'diary', 'discard', 'lease']);
      const jobId = text(data.jobId, LIMIT.key);
      const lease = reviewLease(data.lease);
      const maximum = Math.min(this.config.reviewBatchSize, LIMIT.reviewBatch);
      const candidates = list(data.candidates, maximum, 1).map((candidate) => {
        const item = ownObject(candidate, ['id', 'version']);
        const version = integer(item.version);
        if (version < 1) fail();
        return { id: text(item.id, LIMIT.key), version };
      });
      const ids = candidates.map(({ id }) => id);
      if (new Set(ids).size !== ids.length) fail();
      const retain = list(data.retain, maximum).map(retainedDecision);
      const diary = list(data.diary, maximum).map((entry) => diaryDecision(entry, true));
      const discard = references(data.discard);
      const partition = [...retain.flatMap(({ sourceRefs }) => sourceRefs), ...diary.flatMap(({ sourceRefs }) => sourceRefs), ...discard];
      if (partition.length !== ids.length || new Set(partition).size !== ids.length || partition.some((id) => !ids.includes(id))) fail();
      return (db) => {
        const job = db.prepare('SELECT * FROM review_jobs WHERE id = ?').get(jobId);
        if (!job) fail('MEMORY_REFERENCE_NOT_FOUND');
        const now = integer(this.clock.now());
        assertLease(job, lease, now);
        const jobIds = references(JSON.parse(job.source_ids_json), 1);
        if (job.kind !== 'short-term' || !['queued', 'leased'].includes(job.state)
          || jobIds.length !== ids.length || jobIds.some((id) => !ids.includes(id))) fail('MEMORY_CONFLICT');
        const sources = new Map(candidates.map(({ id, version }) => {
          const row = db.prepare('SELECT * FROM memory_events WHERE id = ?').get(id);
          if (!row || !['active', 'review-pending'].includes(row.state) || row.version !== version
            || (lease && row.review_due_at > now)) fail('MEMORY_CONFLICT');
          return [id, row];
        }));
        const expiresAt = addDays(now, this.config.longTermDays);
        const purgeDueAt = addDays(now, this.config.recycleDays);
        const items = retain.map((item) => {
          assertTarget(db, 'memory_items', item.supersedesId);
          const id = text(this.idGenerator(), LIMIT.key);
          const visibility = strictest(item.sourceRefs.map((ref) => sources.get(ref)));
          db.prepare(`INSERT INTO memory_items (id, kind, subject_key, subject_name, content, importance, confidence,
            visibility, promoted_at, expires_at, state, source_refs_json, supersedes_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
            .run(id, item.kind, item.subjectKey, item.subjectName, item.content, item.importance, item.confidence,
              visibility, now, expiresAt, JSON.stringify(item.sourceRefs), item.supersedesId, now, now);
          return dto(db.prepare('SELECT * FROM memory_items WHERE id = ?').get(id));
        });
        const diaryEntries = diary.map((entry) => appendDiaryRow(db, { ...entry,
          visibility: strictest(entry.sourceRefs.map((ref) => sources.get(ref))),
        }, text(this.idGenerator(), LIMIT.key), now));
        for (const { id, version } of candidates) {
          db.prepare(`UPDATE memory_events SET state = 'recycle', purge_due_at = ?, version = version + 1,
            updated_at = ? WHERE id = ? AND version = ?`).run(purgeDueAt, now, id, version);
        }
        db.prepare(`UPDATE review_jobs SET state = 'completed', lease_until = NULL, last_error_code = NULL,
          updated_at = ? WHERE id = ?`).run(now, jobId);
        return { items, diary: diaryEntries };
      };
    });
  }

  completeLongTermReview(input) {
    return this.#mutate(() => {
      const data = ownObject(input, ['jobId', 'candidates', 'diary', 'discard', 'lease']);
      const jobId = text(data.jobId, LIMIT.key);
      const lease = reviewLease(data.lease);
      const maximum = Math.min(this.config.reviewBatchSize, LIMIT.reviewBatch);
      const candidates = list(data.candidates, maximum, 1).map((candidate) => {
        const item = ownObject(candidate, ['id', 'version']);
        const version = integer(item.version);
        if (version < 1) fail();
        return { id: text(item.id, LIMIT.key), version };
      });
      const ids = candidates.map(({ id }) => id);
      if (new Set(ids).size !== ids.length) fail();
      const diary = list(data.diary, maximum).map((entry) => diaryDecision(entry, true));
      const discard = references(data.discard);
      const partition = [...diary.flatMap(({ sourceRefs }) => sourceRefs), ...discard];
      if (partition.length !== ids.length || new Set(partition).size !== ids.length || partition.some((id) => !ids.includes(id))) fail();
      return (db) => {
        const now = integer(this.clock.now());
        const job = db.prepare('SELECT * FROM review_jobs WHERE id=?').get(jobId);
        if (!job) fail('MEMORY_REFERENCE_NOT_FOUND');
        assertLease(job, lease, now);
        const jobIds = references(JSON.parse(job.source_ids_json), 1);
        if (job.kind !== 'long-term' || !['queued', 'leased'].includes(job.state)
          || jobIds.length !== ids.length || jobIds.some((id) => !ids.includes(id))) fail('MEMORY_CONFLICT');
        const sources = new Map(candidates.map(({ id, version }) => {
          const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(id);
          if (!row || row.state !== 'active' || row.version !== version || row.expires_at > now) fail('MEMORY_CONFLICT');
          return [id, row];
        }));
        const diaryEntries = diary.map((entry) => appendDiaryRow(db, { ...entry,
          visibility: strictest(entry.sourceRefs.map((id) => sources.get(id))),
        }, text(this.idGenerator(), LIMIT.key), now));
        const purgeDueAt = addDays(now, this.config.recycleDays);
        for (const { id, version } of candidates) db.prepare(`UPDATE memory_items SET state='recycle',purge_due_at=?,
          version=version+1,updated_at=? WHERE id=? AND version=?`).run(purgeDueAt, now, id, version);
        db.prepare(`UPDATE review_jobs SET state='completed',lease_until=NULL,last_error_code=NULL,updated_at=? WHERE id=?`).run(now, jobId);
        return { diary: diaryEntries };
      };
    });
  }

  moveToRecycle(input) { return this.#changeRecycle(input, false); }
  restoreRecycle(input) { return this.#changeRecycle(input, true); }

  #changeRecycle(input, restore) {
    return this.#mutate(() => {
      const data = ownObject(input, ['kind', 'id', 'version']);
      const kind = oneOf(data.kind, ['event', 'item']);
      const table = kind === 'event' ? 'memory_events' : 'memory_items';
      const id = text(data.id, LIMIT.key);
      const version = data.version === undefined ? undefined : integer(data.version);
      if (version !== undefined && version < 1) fail();
      return (db) => {
        const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
        if (!row) fail('MEMORY_REFERENCE_NOT_FOUND');
        const allowedStates = restore ? ['recycle'] : kind === 'event' ? ['active', 'review-pending'] : ['active'];
        if (!allowedStates.includes(row.state) || (version !== undefined && row.version !== version)) fail('MEMORY_CONFLICT');
        const now = integer(this.clock.now());
        const purgeDueAt = restore ? null : addDays(now, this.config.recycleDays);
        db.prepare(`UPDATE ${table} SET state = ?, purge_due_at = ?, version = version + 1, updated_at = ? WHERE id = ?`)
          .run(restore ? 'active' : 'recycle', purgeDueAt, now, id);
        return dto(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
      };
    });
  }

  findDueEvents(options = {}) { return this.#findDue('memory_events', 'review_due_at', options); }
  findDueItems(options = {}) { return this.#findDue('memory_items', 'expires_at', options); }

  #findDue(table, dueColumn, options) {
    return this.#read(() => {
      const data = ownObject(options, ['now', 'limit']);
      const now = integer(data.now === undefined ? this.clock.now() : data.now);
      const maximum = Math.min(this.config.reviewBatchSize, LIMIT.reviewBatch);
      const limit = data.limit === undefined ? maximum : integer(data.limit);
      if (limit < 1 || limit > maximum) fail();
      return this.database.read((db) => db.prepare(`SELECT * FROM ${table} WHERE state = 'active' AND ${dueColumn} <= ?
        ORDER BY ${dueColumn}, id LIMIT ?`).all(now, limit).map(dto));
    });
  }

  getStatusCounts() {
    return this.#read(() => this.database.read((db) => {
      const counts = (table, initial) => {
        for (const { state, count } of db.prepare(`SELECT state, count(*) AS count FROM ${table} GROUP BY state`).all()) {
          initial[state === 'review-pending' ? 'reviewPending' : state] = count;
        }
        return initial;
      };
      return { events: counts('memory_events', { active: 0, reviewPending: 0, recycle: 0 }),
        items: counts('memory_items', { active: 0, recycle: 0 }),
        diary: db.prepare('SELECT count(*) AS count FROM diary_entries').get().count };
    }));
  }
}
