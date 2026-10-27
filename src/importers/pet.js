import { array, object, json, time, text, record, invalid } from './shared.js';

/** dsh-pet host stores kind bucket -> instance -> { messages: [{ role,content,ts }] }. */
export function parsePet(bytes, logical, config) {
  const root = object(json(bytes)), records = [];
  for (const [kind, bucket] of Object.entries(root)) for (const [petId, entry] of Object.entries(object(bucket))) {
    array(object(entry).messages).forEach((raw, index) => {
      const row = object(raw), at = time(row.ts); if (!['user', 'assistant'].includes(row.role)) invalid();
      const conversationKey = text(`pet:${kind}:${petId}`, 512);
      records.push(record('event', { source: 'pet', conversationKind: 'pet', conversationKey,
        actorKey: row.role === 'user' ? 'pet:owner' : conversationKey, actorName: '', direction: row.role === 'user' ? 'incoming' : 'outgoing',
        contentText: text(row.content, 16000), occurredAt: at, visibility: 'owner-private' },
      { logical: `${logical}/${kind}/${petId}`, index, originalTime: at, stableId: row.id === undefined ? undefined : `${kind}:${petId}:${row.id}`, config }));
    });
  }
  return records;
}
