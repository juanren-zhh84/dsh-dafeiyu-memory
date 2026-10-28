import { randomUUID } from 'node:crypto';
import { ModuleSpool, freezeEvent } from './spool.mjs';

const text = (value, limit = 512) => typeof value === 'string' ? value.slice(0, limit) : '';
const validId = value => (typeof value === 'string' && value.length <= 512 && !!value.trim()
  && !/[\x00-\x1f\x7f]/.test(value)) || Number.isSafeInteger(value);
const SEND_LISTENERS = Symbol.for('dafeiyu-memory.onebot-send-listeners.v1');
const placeholders = { image: '[图片]', record: '[语音]', face: '[表情]', mface: '[表情包]',
  video: '[视频]', file: '[文件]', forward: '[合并转发]', json: '[卡片消息]', xml: '[卡片消息]',
  at: '[@]', poke: '[戳一戳]', reply: '' };
function sentText(message) {
  if (typeof message === 'string') return message.replace(/\[CQ:(\w+)[^\]]*\]/g, (_, kind) => placeholders[kind] ?? '[消息]');
  if (!Array.isArray(message)) return '';
  // Read text only. Media metadata, paths, buffers and quoted content are never inspected.
  return message.map(segment => segment?.type === 'text' ? text(segment.data?.text, 16000)
    : placeholders[segment?.type] ?? '[消息]').join('').slice(0, 16000);
}
function safeInboundMessage(message) {
  if (typeof message === 'string') return sentText(message);
  if (!Array.isArray(message)) return;
  return message.map(segment => {
    const kind = segment?.type;
    if (kind === 'text') return { type: 'text', data: { text: text(segment.data?.text, 16000) } };
    if (kind === 'at') return { type: 'at', data: { qq: segment.data?.qq, name: segment.data?.name } };
    // Keep quoting metadata out of memory; no lookup or quoted body is needed.
    return { type: 'text', data: { text: placeholders[kind] ?? '[消息]' } };
  });
}
function observeSuccessfulSends(onebot, listener) {
  if (!onebot || typeof onebot.call !== 'function') return () => {};
  let state = onebot.call[SEND_LISTENERS];
  if (!state || state.onebot !== onebot) {
    const original = onebot.call;
    state = { onebot, listeners: new Set(), original };
    const wrapper = async function (...args) {
      let snapshot;
      try {
        const [action, params] = args;
        const kind = action === 'send_group_msg' ? 'group' : action === 'send_private_msg' ? 'private' : undefined;
        const id = kind && params?.[kind === 'group' ? 'group_id' : 'user_id'];
        if (kind && (typeof id === 'string' || Number.isSafeInteger(id)) && String(id).trim()) {
          snapshot = { kind: 'out', chatId: `${kind}:${id}`, text: sentText(params.message),
            sourceKey: `aurabot:out:send:${randomUUID()}` };
        }
      } catch { /* Observation must never alter a gateway call. */ }
      const result = await Reflect.apply(original, this, args);
      if (snapshot) {
        try {
          const id = result?.message_id;
          if ((typeof id === 'string' || Number.isSafeInteger(id)) && String(id).trim() && String(id).length <= 480) {
            snapshot.sourceKey = `aurabot:out:onebot:${id}`;
          }
          Object.freeze(snapshot);
          for (const notify of [...state.listeners]) { try { notify(snapshot); } catch {} }
        } catch { /* A successful send stays successful even if observation fails. */ }
      }
      return result;
    };
    Object.defineProperty(wrapper, SEND_LISTENERS, { value: state });
    state.wrapper = wrapper;
    onebot.call = wrapper;
  }
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
    if (!state.listeners.size && onebot.call === state.wrapper) onebot.call = state.original;
  };
}

export function setupConnector(api, { clock = Date } = {}) {
  let disposed = false, pending = Promise.resolve(), lastWarning;
  const latestText = new Map(), offs = [];
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
    const originalText = text(event.text, 16000);
    const contentText = originalText.trim() ? originalText : '[空消息]';
    const dto = { source: 'qq', conversationKind: mapped.conversationKind, conversationKey: mapped.conversationKey,
      actorKey: outbound ? 'qq:bot' : mapped.actorKey, actorName: outbound ? '大肥鱼' : text(event.nickname, 200),
      direction: outbound ? 'outgoing' : 'incoming', contentText, occurredAt, visibility: mapped.visibility };
    if (outbound) {
      dto.sourceKey = event.sourceKey;
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

  try {
    const { parseMessageEvent } = api.lib('chat/inbound.js');
    const { checkAllowed } = api.lib('chat/access.js');
    offs.push(api.on('onebot', (event) => {
      if (disposed) return;
      try {
        if (event?.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) return;
        if (!validId(event.user_id ?? event.sender?.user_id)
          || (event.message_type === 'group' && !validId(event.group_id))
          || (event.message_id !== undefined && event.message_id !== null && event.message_id !== '' && !validId(event.message_id))) return;
        const cfg = api.config(), self = String(event.self_id || api.core?.hub?.selfId || cfg.botQQ || '');
        const message = safeInboundMessage(event.message);
        if (message === undefined) return;
        const parsed = parseMessageEvent({ ...event, message }, self);
        if (!parsed.userId || (parsed.kind === 'group' && !parsed.groupId) || parsed.userId === self) return;
        if (checkAllowed(cfg, parsed).allowed !== true) return;
        const dto = capture({ ...parsed, raw: { time: event.time } }, false);
        if (!dto) return;
        // Bound the per-chat query cache; this is the latest input, not another history.
        latestText.delete(dto.conversationKey); latestText.set(dto.conversationKey, dto.contentText);
        if (latestText.size > 1000) latestText.delete(latestText.keys().next().value);
        void schedule(() => record(dto));
      } catch { warn('MEMORY_INVALID_EVENT'); }
    }));
  } catch { warn('MEMORY_CONNECTOR_FAILED'); }
  try {
    offs.push(observeSuccessfulSends(api.core?.onebot, (sent) => {
      if (disposed) return;
      try { const dto = capture(sent, true); if (dto) void schedule(() => record(dto)); }
      catch { warn('MEMORY_INVALID_EVENT'); }
    }));
  } catch { warn('MEMORY_CONNECTOR_FAILED'); }
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
