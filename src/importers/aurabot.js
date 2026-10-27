import { array, object, json, time, text, record, item, invalid } from './shared.js';

function ownObject(value) {
  object(value);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const copy = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}
function ownArray(value) {
  array(value);
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const copy = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    copy.push(descriptor.value);
  }
  return copy;
}

/** Schemas verified against dsh-aurabot-qq store, hub and qzone writers. */
export function parseAurabot(bytes, logical, config) {
  if (logical.startsWith('chatlog/')) {
    const lines = bytes.toString('utf8').replace(/^\ufeff/, '').split(/\r?\n/);
    return lines.flatMap((line, index) => {
      if (!line.trim()) return [];
      const row = ownObject(json(Buffer.from(line))), at = time(row.t), chatId = text(row.chatId, 512);
      // qzone-social calls hub.logChat('qzone', ...): this is a feed, not a private/group conversation.
      // Keep an inactive ledger receipt, never infer an audience or import its body.
      const nonChat = chatId === 'qzone';
      const kind = nonChat ? 'system' : /^(group|private|system):.+/.exec(chatId)?.[1]; if (!kind) invalid();
      const outgoing = row.who === 'bot' && !row.uid;
      const originalText = text(row.text, 16000);
      const value = { source: 'qq', conversationKind: kind, conversationKey: chatId,
        actorKey: outgoing ? 'qq:bot' : `qq:${text(row.uid, 480)}`, actorName: text(row.who, 200, ''),
        direction: outgoing ? 'outgoing' : 'incoming', contentText: originalText.trim() ? originalText : '[空消息]', occurredAt: at,
        visibility: kind === 'group' ? 'group' : kind === 'private' && row.owner === true ? 'owner-private' : 'conversation' };
      const entry = record('event', value, { logical, index, originalTime: at, stableId: row.messageId ?? row.id, config });
      return [nonChat ? { ...entry, inactive: true, value: undefined } : entry];
    });
  }
  const root = ownObject(json(bytes));
  if (logical === 'memories.json') return ownArray(root.items).map((raw, index) => {
    const row = ownObject(raw), at = time(row.at);
    const entry = record('item', item(text(row.text, 4000), { subjectKey: `qq:${text(row.about, 480, 'global')}`,
      subjectName: text(row.aboutName, 200, ''), importance: row.importance ?? 0.5 }),
    { logical, index, originalTime: at, stableId: row.id, config });
    // Writer invalidates by adding these fields, and restores by deleting both.
    if (Object.hasOwn(row, 'invalidAt') || Object.hasOwn(row, 'supersededBy')) {
      return { ...entry, inactive: true, value: undefined };
    }
    return entry;
  });
  if (logical === 'diary.json') return ownArray(root.history).map((raw, index) => {
    const row = ownObject(raw), at = time(row.at);
    return record('diary', { title: '导入日记', body: text(row.text, 16000), writtenAt: at, visibility: 'owner-private' },
      { logical, index, originalTime: at, stableId: row.tid || undefined, config });
  });
  invalid();
}
