import { array, object, json, time, text, record, item, invalid } from './shared.js';

/** Schemas verified against dsh-aurabot-qq store, hub and qzone writers. */
export function parseAurabot(bytes, logical, config) {
  if (logical.startsWith('chatlog/')) {
    const lines = bytes.toString('utf8').replace(/^\ufeff/, '').split(/\r?\n/);
    return lines.flatMap((line, index) => {
      if (!line.trim()) return [];
      const row = object(json(Buffer.from(line))), at = time(row.t), chatId = text(row.chatId, 512);
      const kind = /^(group|private|system):.+/.exec(chatId)?.[1]; if (!kind) invalid();
      const outgoing = row.who === 'bot' && !row.uid;
      const value = { source: 'qq', conversationKind: kind, conversationKey: chatId,
        actorKey: outgoing ? 'qq:bot' : `qq:${text(row.uid, 480, 'unknown')}`, actorName: text(row.who, 200, ''),
        direction: outgoing ? 'outgoing' : 'incoming', contentText: text(row.text, 16000), occurredAt: at,
        visibility: kind === 'group' ? 'group' : kind === 'private' && row.owner === true ? 'owner-private' : 'conversation' };
      return [record('event', value, { logical, index, originalTime: at, stableId: row.messageId ?? row.id, config })];
    });
  }
  const root = object(json(bytes));
  if (logical === 'memories.json') return array(root.items).map((raw, index) => {
    const row = object(raw), at = time(row.at);
    const entry = record('item', item(text(row.text, 4000), { subjectKey: `qq:${text(row.about, 480, 'global')}`,
      subjectName: text(row.aboutName, 200, ''), importance: row.importance ?? 0.5 }),
    { logical, index, originalTime: at, stableId: row.id, config });
    // Writer invalidates by adding these fields, and restores by deleting both.
    if (Object.hasOwn(row, 'invalidAt') || Object.hasOwn(row, 'supersededBy')) {
      return { ...entry, inactive: true, value: undefined };
    }
    return entry;
  });
  if (logical === 'diary.json') return array(root.history).map((raw, index) => {
    const row = object(raw), at = time(row.at);
    return record('diary', { title: '导入日记', body: text(row.text, 16000), writtenAt: at, visibility: 'owner-private' },
      { logical, index, originalTime: at, stableId: row.tid || undefined, config });
  });
  invalid();
}
