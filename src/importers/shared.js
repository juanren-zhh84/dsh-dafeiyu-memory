import { createHash } from 'node:crypto';
import { snapshotEventInput } from '../memory/repository.js';
import { MEMORY_INPUT_LIMITS as LIMIT, memoryError } from '../contracts.js';
export const DAY = 86400000;
export const fingerprint = value => createHash('sha256').update(value).digest('hex');
export function invalid(code = 'INVALID_SOURCE') { throw memoryError(code, code); }
export function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }
export function text(value, max, fallback) { if (value === undefined && fallback !== undefined) value = fallback; if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid(); return value; }
export function time(value) { if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value + 365 * DAY)) invalid(); return value; }
export function json(bytes) { try { return JSON.parse(bytes.toString('utf8').replace(/^\ufeff/, '')); } catch { invalid(); } }
export function array(value) { if (!Array.isArray(value)) invalid(); return value; }
export function record(type, value, { logical, index, originalTime, stableId, config }) {
  const body = type === 'event' ? value.contentText : type === 'item' ? value.content : value.body;
  if (stableId !== undefined && (typeof stableId !== 'string' && !Number.isSafeInteger(stableId))) invalid();
  if (typeof stableId === 'string') text(stableId, LIMIT.key);
  const contentHash = fingerprint(body);
  const externalKey = fingerprint(JSON.stringify(stableId !== undefined && stableId !== '' ? [type, 'id', String(stableId)] : [type, logical, index, originalTime, contentHash]));
  if (type === 'event') value = snapshotEventInput({ ...value, sourceKey: externalKey }, config);
  else if (type === 'item') {
    text(value.content, LIMIT.itemContent); if (!value.content.trim()) invalid();
    text(value.subjectKey, LIMIT.key); text(value.subjectName, LIMIT.name);
    if (!Number.isFinite(value.importance) || value.importance < 0 || value.importance > 1) invalid();
  } else { text(value.title, LIMIT.diaryTitle); text(value.body, LIMIT.diaryBody); time(value.writtenAt); }
  return { type, value, externalKey, fingerprint: contentHash };
}
export function item(content, { subjectKey = 'import:global', subjectName = '', importance = 0.5 } = {}) {
  return { content, subjectKey, subjectName, importance, visibility: 'owner-private' };
}
