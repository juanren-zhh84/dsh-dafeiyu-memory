import { MEMORY_INPUT_LIMITS as LIMIT, memoryError } from '../contracts.js';

const VISIBILITY = ['owner-private', 'conversation', 'group', 'public'];
const KINDS = ['fact', 'preference', 'relationship', 'experience', 'behavior-note'];
const MESSAGES = Object.freeze({
  MEMORY_REVIEW_INVALID_INPUT: 'Memory review input is invalid',
  MEMORY_REVIEW_INVALID_PROTOCOL: 'Memory review protocol is invalid',
  MEMORY_REVIEW_MODEL_FAILED: 'Memory review model failed',
  MEMORY_REVIEW_STREAM_FAILED: 'Memory review stream failed',
  MEMORY_REVIEW_TIMEOUT: 'Memory review timed out',
});
export function reviewError(code) { return memoryError(code, MESSAGES[code]); }
function invalid() { throw reviewError('MEMORY_REVIEW_INVALID_PROTOCOL'); }

// Read descriptors rather than invoke caller-controlled accessors or inherited fields.
function object(input, required, optional = []) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (![...required, ...optional].includes(key) || !field || !Object.hasOwn(field, 'value')) invalid();
    result[key] = field.value;
  }
  if (required.some((key) => !Object.hasOwn(result, key))) invalid();
  return result;
}
function array(input, maximum = LIMIT.reviewBatch, minimum = 0) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum || Reflect.ownKeys(input).length !== length + 1) invalid();
  const result = [];
  for (let index = 0; index < length; index++) {
    const field = Object.getOwnPropertyDescriptor(input, String(index));
    if (!field || !Object.hasOwn(field, 'value')) invalid();
    result.push(field.value);
  }
  return result;
}
function text(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function unit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid();
  return value;
}

/** A detached immutable batch is the only candidate data allowed into the request. */
export function snapshotReviewRequest(input) {
  try {
    const data = object(input, ['mode', 'candidates']);
    if (!['short-term', 'long-term'].includes(data.mode)) invalid();
    const candidates = array(data.candidates, LIMIT.reviewBatch, 1).map((candidate) => {
      const item = object(candidate, ['id', 'version', 'content', 'visibility']);
      if (!Number.isSafeInteger(item.version) || item.version < 1 || !VISIBILITY.includes(item.visibility)) invalid();
      return Object.freeze({ id: text(item.id, LIMIT.key), version: item.version,
        content: text(item.content, data.mode === 'short-term' ? LIMIT.eventText : LIMIT.itemContent), visibility: item.visibility });
    });
    if (new Set(candidates.map(({ id }) => id)).size !== candidates.length) invalid();
    return Object.freeze({ mode: data.mode, candidates: Object.freeze(candidates) });
  } catch { throw reviewError('MEMORY_REVIEW_INVALID_INPUT'); }
}

/** Returns classification only. Repository code remains responsible for visibility and writes. */
export function validateReviewDecision(input, request) {
  try {
    const batch = snapshotReviewRequest(request);
    const data = object(input, batch.mode === 'short-term' ? ['retain', 'diary', 'discard'] : ['diary', 'discard']);
    const ids = new Set(batch.candidates.map(({ id }) => id));
    const seen = new Set();
    const sourceId = (value) => {
      const id = text(value, LIMIT.key);
      if (!ids.has(id) || seen.has(id)) invalid();
      seen.add(id); return id;
    };
    const sources = (value) => array(value, ids.size, 1).map(sourceId);
    const retain = batch.mode === 'short-term' ? array(data.retain, ids.size).map((entry) => {
      const item = object(entry, ['sourceIds', 'kind', 'content', 'importance'], ['confidence']);
      if (!KINDS.includes(item.kind)) invalid();
      return { sourceIds: sources(item.sourceIds), kind: item.kind, content: text(item.content, LIMIT.itemContent),
        importance: unit(item.importance), confidence: Object.hasOwn(item, 'confidence') ? unit(item.confidence) : 1 };
    }) : [];
    const diary = array(data.diary, ids.size).map((entry) => {
      const item = object(entry, ['sourceIds', 'title', 'body']);
      return { sourceIds: sources(item.sourceIds), title: text(item.title, LIMIT.diaryTitle), body: text(item.body, LIMIT.diaryBody) };
    });
    const discard = array(data.discard, ids.size).map(sourceId);
    if (retain.length + diary.length + discard.length > ids.size || seen.size !== ids.size) invalid();
    return batch.mode === 'short-term' ? { retain, diary, discard } : { diary, discard };
  } catch { throw reviewError('MEMORY_REVIEW_INVALID_PROTOCOL'); }
}

// Scan quoted tokens before parsing the document so JSON.parse cannot silently
// overwrite a repeated top-level member (including an escaped spelling).
function rejectDuplicateMembers(raw) {
  const keys = new Set();
  let depth = 0;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === '"') {
      const start = index++;
      while (index < raw.length && raw[index] !== '"') {
        if (raw[index] === '\\') index++;
        index++;
      }
      if (index >= raw.length) invalid();
      if (depth === 1 && /^\s*:/.test(raw.slice(index + 1))) {
        const key = JSON.parse(raw.slice(start, index + 1));
        if (keys.has(key)) invalid();
        keys.add(key);
      }
    } else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') depth--;
  }
}

export function parseReviewDecision(raw, request) {
  try {
    if (typeof raw !== 'string' || raw.length > 1_000_000 || !raw.trim().startsWith('{') || !raw.trim().endsWith('}')) invalid();
    rejectDuplicateMembers(raw);
    return validateReviewDecision(JSON.parse(raw), request);
  } catch { throw reviewError('MEMORY_REVIEW_INVALID_PROTOCOL'); }
}
