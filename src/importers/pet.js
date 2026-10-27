import { array, object, json, time, text, record, invalid } from './shared.js';

function messageId(row) {
  const descriptor = Object.getOwnPropertyDescriptor(row, 'id');
  if (!descriptor) { if ('id' in row) invalid(); return undefined; }
  if (!Object.hasOwn(descriptor, 'value')) invalid();
  const value = descriptor.value;
  if (typeof value === 'string') {
    text(value, 512); if (!value.trim()) invalid();
    return value;
  }
  if (!Number.isSafeInteger(value)) invalid();
  return String(value);
}

/** dsh-pet host stores kind bucket -> instance -> { messages: [{ role,content,ts }] }. */
export function parsePet(bytes, logical, config) {
  const root = object(json(bytes)), records = [];
  for (const [kind, bucket] of Object.entries(root)) for (const [petId, entry] of Object.entries(object(bucket))) {
    array(object(entry).messages).forEach((raw, index) => {
      const row = object(raw), at = time(row.ts); if (!['user', 'assistant'].includes(row.role)) invalid();
      const conversationKey = text(`pet:${kind}:${petId}`, 512);
      const id = messageId(row);
      records.push(record('event', { source: 'pet', conversationKind: 'pet', conversationKey,
        actorKey: row.role === 'user' ? 'pet:owner' : conversationKey, actorName: '', direction: row.role === 'user' ? 'incoming' : 'outgoing',
        contentText: text(row.content, 16000), occurredAt: at, visibility: 'owner-private' },
      { logical: `${logical}/${kind}/${petId}`, index, originalTime: at, stableId: id === undefined ? undefined : `${kind}:${petId}:${id}`, config }));
    });
  }
  return records;
}
