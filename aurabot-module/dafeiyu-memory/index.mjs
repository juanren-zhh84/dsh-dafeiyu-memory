import { randomUUID } from 'node:crypto';
import { ModuleSpool, freezeEvent } from './spool.mjs';

const text = (value, limit = 512) => typeof value === 'string' ? value.slice(0, limit) : '';

export function setupConnector(api, { clock = Date } = {}) {
  let disposed = false, pending = Promise.resolve(), lastWarning, lastMillis = -1, sequence = 0;
  const latestText = new Map(), offs = [], instanceKey = randomUUID();
  const warn = (code, line) => {
    if (disposed) return;
    const now = clock.now();
    if (lastWarning !== undefined && now - lastWarning < 300000) return;
    lastWarning = now;
    try { if (line === undefined) api.log.warn(code); else api.log.warn(code, line); } catch { /* Never interrupt QQ. */ }
  };
  const spool = new ModuleSpool(api.dataDir(), { active: () => !disposed, warn });
  const service = () => {
    try { return api.dsh.get('dafeiyuMemory', false); }
    catch { warn('MEMORY_SERVICE_UNAVAILABLE'); return undefined; }
  };
  const schedule = (fn) => {
    pending = pending.then(() => disposed ? undefined : fn()).catch(() => { warn('MEMORY_CONNECTOR_FAILED'); });
    return pending;
  };
  const owner = (userId) => {
    try { return !!userId && api.isOwner(userId) === true; } catch { return false; }
  };
  const scope = (chat, outbound = false) => {
    const chatId = text(chat?.chatId);
    const kind = chat?.kind === 'out' ? /^(group|private|system):.+/.exec(chatId)?.[1] : chat?.kind;
    if (!['private', 'group', 'system'].includes(kind) || !chatId.startsWith(kind + ':') || !chatId.slice(kind.length + 1)) return;
    const userId = text(chat.userId) || (outbound && kind === 'private' ? chatId.slice(8) : '');
    const isOwner = kind === 'private' && owner(userId);
    return { conversationKind: kind, conversationKey: chatId, actorKey: `qq:${userId || 'unknown'}`,
      visibility: kind === 'group' ? 'group' : isOwner ? 'owner-private' : 'conversation',
      audience: kind === 'group' ? 'qq-group' : isOwner ? 'owner' : 'qq-private' };
  };
  const capture = (event, outbound) => {
    const mapped = scope(event, outbound);
    if (!mapped) { warn('MEMORY_INVALID_EVENT'); return; }
    const now = clock.now();
    const seconds = event.raw?.time;
    const occurredAt = !outbound && Number.isSafeInteger(seconds) && seconds >= 0 && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : now;
    const originalText = text(outbound ? (event.reply || event.text) : event.text, 16000);
    const contentText = originalText.trim() ? originalText : '[空消息]';
    const dto = { source: 'qq', conversationKind: mapped.conversationKind, conversationKey: mapped.conversationKey,
      actorKey: outbound ? 'qq:bot' : mapped.actorKey, actorName: outbound ? '大肥鱼' : text(event.nickname, 200),
      direction: outbound ? 'outgoing' : 'incoming', contentText, occurredAt, visibility: mapped.visibility };
    if (outbound) {
      sequence = now === lastMillis ? sequence + 1 : 0; lastMillis = now;
      dto.sourceKey = `aurabot:out:${instanceKey}:${now}:${sequence}`;
    } else if (event.messageId !== undefined && event.messageId !== null && String(event.messageId).trim()) {
      dto.sourceKey = String(event.messageId).slice(0, 512);
    }
    return freezeEvent(dto);
  };
  const record = async (dto) => {
    const current = service();
    if (current && typeof current.recordEvent === 'function') {
      try { await spool.drain(current); }
      catch { warn('MEMORY_SPOOL_FAILED'); }
      if (disposed) return;
      try { await current.recordEvent(dto); return; }
      catch { warn('MEMORY_RECORD_FAILED'); }
    } else warn('MEMORY_SERVICE_UNAVAILABLE');
    if (!disposed) spool.append(dto);
  };

  offs.push(api.on('message', (message) => {
    if (disposed) return false;
    let dto;
    try {
      dto = capture(message, false);
      if (dto) {
        // Bound the per-chat query cache; this is only the latest input, not a second history.
        latestText.delete(dto.conversationKey); latestText.set(dto.conversationKey, dto.contentText);
        if (latestText.size > 1000) latestText.delete(latestText.keys().next().value);
      }
    } catch { warn('MEMORY_INVALID_EVENT'); }
    if (dto) void schedule(() => record(dto));
    return false;
  }));
  offs.push(api.on('activity', (activity) => {
    if (disposed || activity?.kind !== 'out') return;
    try { const dto = capture(activity, true); if (dto) void schedule(() => record(dto)); }
    catch { warn('MEMORY_INVALID_EVENT'); }
  }));
  offs.push(api.context(({ chat }) => {
    if (disposed || chat?.kind === 'system') return '';
    try {
      const mapped = scope(chat);
      if (!mapped) return '';
      const current = service();
      if (!current) { warn('MEMORY_SERVICE_UNAVAILABLE'); return ''; }
      void schedule(() => spool.drain(service()));
      const result = current.recall({ audience: mapped.audience, conversationKind: mapped.conversationKind,
        conversationKey: mapped.conversationKey, actorKey: mapped.actorKey,
        queryText: latestText.get(mapped.conversationKey) ?? '', now: clock.now() });
      return typeof result === 'string' ? result : '';
    } catch { warn('MEMORY_RECALL_FAILED'); return ''; }
  }));
  offs.push(api.every(30000, () => schedule(() => spool.drain(service())), 'dafeiyu-memory-spool'));
  api.onDispose(() => {
    if (disposed) return;
    disposed = true;
    latestText.clear();
    for (const off of offs) { try { off(); } catch { /* Continue unregistering. */ } }
  });
}

export default {
  id: 'dafeiyu-memory', name: '大肥鱼统一记忆', api: 1, version: '0.1.0',
  description: '通过公开模块 API 记录 QQ 消息并同步召回统一记忆。',
  setup: setupConnector,
};
