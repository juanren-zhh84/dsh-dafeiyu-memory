import { memoryError } from '../contracts.js';

export function invalid(code = 'MEMORY_INVALID_INPUT') { throw memoryError(code, 'Memory management request failed'); }

export function validateFields(input, fields) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!fields.includes(key) || !Object.hasOwn(descriptor, 'value')) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

export function string(value, max = 512, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}

export function target(input, fields = ['kind', 'id', 'version']) {
  const data = validateFields(input, fields);
  if (!['event', 'item'].includes(data.kind)) invalid();
  string(data.id);
  if (data.version !== undefined && (!Number.isSafeInteger(data.version) || data.version < 1)) invalid();
  return data;
}

const tables = { event: 'memory_events', item: 'memory_items', diary: 'diary_entries' };
const columns = { event: ['source', 'occurred_at', 'content_text'], item: ["'memory'", 'promoted_at', 'content'], diary: ["'diary'", 'written_at', "title || ' ' || body"] };
const safeNumber = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
export function publicStatus(service) {
  const status = service.status();
  if (status.state === 'disposed') return { code: 'disposed' };
  const maintenance = status.maintenance;
  return service.database.read((db) => {
    const task = db.prepare(`SELECT sum(state IN ('queued','leased')) AS pending, sum(state='failed') AS failed,
      min(CASE WHEN state='queued' THEN coalesce(next_attempt_at,due_at) WHEN state='leased' THEN lease_until END) AS next_at FROM review_jobs`).get();
    const nextDue = db.prepare(`SELECT min(time) AS time FROM (
      SELECT min(review_due_at) AS time FROM memory_events WHERE state='active'
      UNION ALL SELECT min(expires_at) FROM memory_items WHERE state='active')`).get().time;
    const times = [task.next_at, nextDue].filter(Number.isSafeInteger);
    const connectors = {};
    for (const source of ['qq', 'pet', 'douyin']) {
      const time = db.prepare('SELECT max(occurred_at) AS time FROM memory_events WHERE source=?').get(source).time;
      connectors[source] = { code: time === null ? (source === 'douyin' ? 'optional-unobserved' : 'unobserved') : 'observed', lastAt: time };
    }
    return { code: ['ready', 'degraded'].includes(status.state) ? status.state : 'unavailable',
      counts: { short: safeNumber(status.events?.active) + safeNumber(status.events?.reviewPending), long: safeNumber(status.items?.active),
        diary: safeNumber(status.diary), recycle: safeNumber(status.events?.recycle) + safeNumber(status.items?.recycle) },
      tasks: { pending: safeNumber(task.pending), failed: safeNumber(task.failed), nextAt: times.length ? Math.min(...times) : null },
      capacity: { code: ['ready', 'warning', 'degraded'].includes(maintenance?.state) ? maintenance.state : 'unavailable',
        databaseBytes: safeNumber(maintenance?.databaseBytes), backupsBytes: safeNumber(maintenance?.backupsBytes),
        spoolBytes: safeNumber(maintenance?.spoolBytes), totalBytes: safeNumber(maintenance?.totalBytes), limitBytes: service.config.diskSoftLimitBytes }, connectors };
  });
}

export function managementSearch(database, input) {
  const data = validateFields(input, ['context', 'query', 'layer', 'offset']);
  if (data.context !== 'management') invalid();
  const query = string(data.query ?? '', 200, true);
  const layer = data.layer ?? 'all';
  if (!['all', 'short', 'long', 'diary', 'recycle'].includes(layer)) invalid();
  const offset = data.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) invalid();
  const selected = layer === 'short' ? ['event'] : layer === 'long' ? ['item'] : layer === 'diary' ? ['diary'] : layer === 'recycle' ? ['event', 'item'] : Object.keys(tables);
  const sql = selected.map((kind) => {
    const [source, time, content] = columns[kind];
    const state = kind === 'diary' ? "'active'" : 'state';
    const scope = kind === 'diary' ? '1' : layer === 'recycle' ? "state='recycle'" : "state != 'recycle'";
    return `SELECT id,'${kind}' AS kind,${source} AS source,${state} AS state,${time} AS time,version FROM ${tables[kind]} WHERE ${scope} AND instr(lower(${content}),lower(?)) > 0`;
  }).join(' UNION ALL ');
  return database.read((db) => {
    const rows = db.prepare(`SELECT * FROM (${sql}) ORDER BY time DESC,kind,id LIMIT 51 OFFSET ?`).all(...selected.map(() => query), offset);
    return { items: rows.slice(0, 50).map((row) => ({ ...row, actor: '已隐藏' })), hasMore: rows.length > 50, offset };
  });
}

export function managementDetail(database, input) {
  const data = validateFields(input, ['context', 'kind', 'id']);
  if (data.context !== 'management' || !Object.hasOwn(tables, data.kind)) invalid();
  string(data.id);
  return database.read((db) => {
    const content = data.kind === 'event' ? 'content_text' : data.kind === 'item' ? 'content' : "title || char(10) || body";
    const row = db.prepare(`SELECT ${content} AS content FROM ${tables[data.kind]} WHERE id=?`).get(data.id);
    if (!row) invalid('MEMORY_REFERENCE_NOT_FOUND');
    return { id: data.id, kind: data.kind, content: row.content };
  });
}
