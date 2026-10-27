/** Registered Cordis service name. */
export const MEMORY_SERVICE_NAME = 'dafeiyuMemory';

/** Repository DTOs use camelCase; SQLite columns are an internal detail. */
export const MEMORY_INPUT_LIMITS = Object.freeze({
  eventText: 16000, itemContent: 4000, diaryTitle: 200, diaryBody: 16000,
  name: 200, key: 512, sourceRefs: 100, mediaRefs: 20, mediaRef: 2048, reviewBatch: 40,
});

/**
 * MemoryEventInput: { source, sourceKey?, conversationKind, conversationKey,
 * actorKey, actorName, direction, contentText, occurredAt, visibility, mediaRefs? }.
 * contentText preserves the original text. A missing sourceKey uses SHA-256 of
 * JSON.stringify([source, conversationKey, direction, occurredAt, normalizedText]);
 * only that fingerprint text uses NFKC, trim and whitespace folding.
 * externalKey = JSON.stringify([source, sourceKey]).
 * Only plain objects with own data fields are accepted. Media is a stable text
 * reference, never a data URI, blob, object or binary value.
 *
 * Repository writes return Promises; reads return synchronous camelCase DTOs.
 * insertEvent(input) -> event DTO (including id, version, externalKey).
 * Redelivery of a physically purged event returns
 * { inserted: false, deduplicated: true, purged: true, id: null } without a body.
 * promoteEvents({ jobId, candidates: [{ id, version }], retain, diary, discard })
 *   -> { items: item DTO[], diary: diary DTO[] }.
 * retain: [{ sourceIds, kind, subjectKey, subjectName, content, importance,
 *            confidence? = 1, supersedesId? }].
 * diary: [{ sourceIds, title, body, supersedesId? }]; discard: event ID[].
 * Decisions partition all candidates exactly once. A matching queued/leased
 * short-term job is required. Visibility is derived from sourceIds.
 * appendDiary({ title, body, sourceRefs?, supersedesId?, visibility? }) -> diary DTO.
 * sourceRefs derives visibility and prohibits passing visibility; without refs,
 * trusted manual entries default to owner-private and may specify visibility.
 * moveToRecycle/restoreRecycle({ kind: 'event' | 'item', id, version? }) -> DTO.
 * findDueEvents/findDueItems({ now?, limit? } = {}) -> active DTO[], ordered by
 * due time then id, capped at min(config.reviewBatchSize, 40).
 * getStatusCounts() -> { events: { active, reviewPending, recycle },
 *                       items: { active, recycle }, diary: number }.
 * DTOs decode source_refs_json to sourceRefs; all timestamps are UTC ms.
 */

/**
 * Public service boundary. recall() returns a projection string synchronously;
 * status() returns { state, events, items, diary } while ready and only
 * { state: 'disposed' } after disposal, synchronously. All other
 * methods return Promises. Unimplemented operations reject rather than pretend
 * that memory has been persisted. After disposal only status()/dispose() work.
 */
export const MEMORY_METHODS = Object.freeze([
  'recordEvent', 'recall', 'status', 'search', 'importExisting',
  'runDueReviews', 'backup', 'restoreRecycleItem', 'purgeRecycleItem',
  'promoteToDiary', 'dispose',
]);

export function memoryError(code, message) {
  const error = Object.assign(new Error(message), { code });
  error.stack = `Error: ${message}`;
  return error;
}
/**
 * importExisting({ dryRun = false, sources? } = {}) -> sanitized ImportReport.
 * sources is an optional map of selected source paths: { aurabot?: absoluteDirectory,
 * pet?: absoluteMemoryJson, douyin?: absoluteSqlite }. Omitting the map discovers
 * sources below DSH_HOME plus the verified Douyin runtime-location/env settings.
 * A supplied map imports only its named sources. Source paths never appear in reports.
 * Report: { ok, dryRun, startedAt, finishedAt, sources: [{ source, status,
 * imported, skipped, failed, planned, code, privateContextCode? }], scanCode?, reportCode? }.
 * Source statuses: skipped/planned/imported/failed/optional-unsupported/optional-failed.
 * Imported counts committed targets, skipped counts ledger/target/purge duplicates;
 * failed counts known records in a failed transaction or one unparseable batch.
 * planned counts new targets (including committed targets on actual runs).
 * dryRun writes neither snapshots, target data, ledger, reports nor source files.
 * Global notes and diary default to owner-private. Unsupported Douyin private
 * context stays excluded rather than inventing a source timestamp.
 */
