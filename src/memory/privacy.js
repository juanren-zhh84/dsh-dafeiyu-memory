const AUDIENCES = ['owner', 'pet', 'qq-private', 'qq-group'];
const FIELDS = ['queryText', 'audience', 'conversationKind', 'conversationKey', 'actorKey', 'now'];
const VISIBILITY = ['owner-private', 'conversation', 'group', 'public'];
const hasText = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
export const privileged = (request) => request.audience === 'owner' || request.audience === 'pet';

/** Read data descriptors only: inherited properties and caller getters cannot grant access. */
export function normalizeRequest(input, clock) {
  try {
    if (!input || typeof input !== 'object') return;
    const request = Object.create(null);
    for (const field of FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (descriptor && !Object.hasOwn(descriptor, 'value')) return;
      if (descriptor) request[field] = descriptor.value;
    }
    if (!AUDIENCES.includes(request.audience)) return;
    if (request.queryText === undefined) request.queryText = '';
    if (typeof request.queryText !== 'string' || request.queryText.length > 16000) return;
    if (request.now === undefined) request.now = clock.now();
    if (!Number.isSafeInteger(request.now) || request.now < 0) return;
    if (request.audience === 'qq-private' && (request.conversationKind !== 'private'
      || !hasText(request.conversationKey) || !hasText(request.actorKey))) return;
    if (request.audience === 'qq-group' && (request.conversationKind !== 'group' || !hasText(request.conversationKey))) return;
    return request;
  } catch { return; }
}

/** Parameterized SQL reduces candidate exposure before the independent row-level check. */
export function candidateScope(layer, request) {
  const state = layer === 'short' ? "state IN ('active', 'review-pending')" : layer === 'long' ? "state = 'active'" : '1';
  if (privileged(request)) return { sql: state, params: [] };
  if (layer === 'diary') return { sql: "visibility = 'public'", params: [] };
  if (layer === 'long') {
    const group = request.audience === 'qq-group';
    return { sql: `${state} AND (visibility = 'public' OR (visibility IN (${group ? "'group', 'conversation'" : "'conversation'"}) AND ${group ? 'subject_key = ?' : 'subject_key IN (?, ?)'}))`,
      params: group ? [request.conversationKey] : [request.conversationKey, request.actorKey] };
  }
  if (request.audience === 'qq-group') return {
    sql: `${state} AND conversation_kind = 'group' AND conversation_key = ? AND visibility IN ('group', 'conversation', 'public')`,
    params: [request.conversationKey],
  };
  return { sql: `${state} AND (visibility = 'public' OR (visibility = 'conversation' AND conversation_kind = 'private' AND conversation_key = ? AND (direction = 'outgoing' OR actor_key = ?)))`,
    params: [request.conversationKey, request.actorKey] };
}

export function allowsMemory(layer, row, request) {
  if (!VISIBILITY.includes(row.visibility)) return false;
  if (layer === 'short' && !['active', 'review-pending'].includes(row.state)) return false;
  if (layer === 'long' && row.state !== 'active') return false;
  if (privileged(request)) return true;
  if (layer === 'diary') return row.visibility === 'public';
  if (layer === 'long') return row.visibility === 'public'
    || (request.audience === 'qq-group'
      ? ['group', 'conversation'].includes(row.visibility) && row.subject_key === request.conversationKey
      : row.visibility === 'conversation' && [request.conversationKey, request.actorKey].includes(row.subject_key));
  if (request.audience === 'qq-group') return row.conversation_kind === 'group'
    && row.conversation_key === request.conversationKey && ['group', 'conversation', 'public'].includes(row.visibility);
  return row.visibility === 'public' || (row.visibility === 'conversation' && row.conversation_kind === 'private'
    && row.conversation_key === request.conversationKey && (row.direction === 'outgoing' || row.actor_key === request.actorKey));
}

/** Explicit output fields prevent source, account, reference and internal-ID metadata escaping. */
export function projectMemory(layer, row, request) {
  if (layer === 'short') return { contentText: row.content_text, occurredAt: row.occurred_at };
  if (layer === 'long') return { content: row.content, importance: row.importance, promotedAt: row.promoted_at };
  return privileged(request) ? { title: row.title, body: row.body, writtenAt: row.written_at }
    : { title: row.title, summary: [...row.body].slice(0, 200).join(''), writtenAt: row.written_at };
}
