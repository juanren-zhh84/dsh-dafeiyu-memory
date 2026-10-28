import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ModuleSpool, freezeEvent } from './spool.mjs';

const text = (value, limit = 512) => typeof value === 'string' ? value.slice(0, limit) : '';
const validId = value => (typeof value === 'string' && value.length <= 512 && !!value.trim()
  && !/[\x00-\x1f\x7f]/.test(value)) || Number.isSafeInteger(value);
const SEND_LISTENERS = Symbol.for('dafeiyu-memory.onebot-send-listeners.v1');
const placeholders = { image: '[图片]', record: '[语音]', face: '[表情]', mface: '[表情包]',
  video: '[视频]', file: '[文件]', forward: '[合并转发]', json: '[卡片消息]', xml: '[卡片消息]',
  at: '[@]', poke: '[戳一戳]', reply: '' };
function ownValue(object, key) {
  if (!object || typeof object !== 'object') return;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function sentText(message) {
  if (typeof message === 'string') return message.replace(/\[CQ:(\w+)[^\]]*\]/g, (_, kind) => placeholders[kind] ?? '[消息]');
  if (!Array.isArray(message)) return;
  // Read text only. Media metadata, paths, buffers and quoted content are never inspected.
  let content = '';
  for (let index = 0; index < ownValue(message, 'length'); index++) {
    const segment = ownValue(message, String(index)), kind = ownValue(segment, 'type');
    if (typeof kind !== 'string') return;
    if (kind === 'text') {
      const value = ownValue(ownValue(segment, 'data'), 'text');
      if (typeof value !== 'string') return;
      content += value;
    } else content += Object.hasOwn(placeholders, kind) ? placeholders[kind] : '[消息]';
  }
  return content.slice(0, 16000);
}
function safeInboundMessage(message) {
  if (typeof message === 'string') return sentText(message);
  if (!Array.isArray(message)) return;
  const safe = [];
  for (let index = 0; index < ownValue(message, 'length'); index++) {
    const segment = ownValue(message, String(index)), kind = ownValue(segment, 'type');
    if (typeof kind !== 'string') continue;
    if (kind === 'text') {
      const content = ownValue(ownValue(segment, 'data'), 'text');
      if (typeof content === 'string') safe.push({ type: 'text', data: { text: text(content, 16000) } });
      continue;
    }
    if (kind === 'at') {
      const data = ownValue(segment, 'data'), qq = ownValue(data, 'qq'), name = ownValue(data, 'name');
      if (validId(qq)) safe.push({ type: 'at', data: { qq, name: text(name, 200) } });
      continue;
    }
    // Keep quoting metadata out of memory; no lookup or quoted body is needed.
    safe.push({ type: 'text', data: { text: Object.hasOwn(placeholders, kind) ? placeholders[kind] : '[消息]' } });
  }
  return safe;
}
function inboundSnapshot(event) {
  const safe = Object.create(null);
  for (const key of ['post_type', 'message_type', 'user_id', 'group_id', 'message_id', 'self_id', 'time']) safe[key] = ownValue(event, key);
  if (safe.post_type !== 'message' || !['private', 'group'].includes(safe.message_type)) return;
  const sender = ownValue(event, 'sender');
  safe.sender = Object.create(null);
  for (const key of ['card', 'nickname', 'role']) {
    const value = ownValue(sender, key);
    if (typeof value === 'string') safe.sender[key] = value;
  }
  const senderId = ownValue(sender, 'user_id');
  if (validId(senderId)) safe.sender.user_id = senderId;
  if (!validId(safe.user_id ?? senderId)
    || (safe.message_type === 'group' && !validId(safe.group_id))
    || (safe.message_id !== undefined && safe.message_id !== null && safe.message_id !== '' && !validId(safe.message_id))) return;
  // Never pass caller objects or fields the parser does not need.
  if (!validId(safe.self_id)) safe.self_id = undefined;
  safe.message = safeInboundMessage(ownValue(event, 'message'));
  return safe.message === undefined ? undefined : safe;
}
function observeSuccessfulSends(onebot, listener) {
  if (!onebot || typeof onebot.call !== 'function') return () => {};
  // Registry and async ancestry belong to this gateway, including detached
  // boundaries a third-party forwarder may still call after a later reload.
  let state = ownValue(onebot, SEND_LISTENERS);
  if (!state || state.onebot !== onebot) {
    state = { onebot, listeners: new Set(), boundaries: new WeakMap(), calls: new AsyncLocalStorage() };
    Object.defineProperty(onebot, SEND_LISTENERS, { value: state, configurable: true });
  }
  if (!state.boundaries.has(onebot.call)) {
    const original = onebot.call;
    const wrapper = async function (...args) {
      const parent = state.calls.getStore();
      if (!state.listeners.size && !parent) return Reflect.apply(original, this, args);
      const isSend = args[0] === 'send_group_msg' || args[0] === 'send_private_msg';
      if (parent && isSend) parent.children++;
      const call = { children: 0 };
      let snapshot;
      try {
        const [action, params] = args;
        const kind = action === 'send_group_msg' ? 'group' : action === 'send_private_msg' ? 'private' : undefined;
        const id = kind && ownValue(params, kind === 'group' ? 'group_id' : 'user_id');
        const content = kind && validId(id) ? sentText(ownValue(params, 'message')) : undefined;
        if (typeof content === 'string') {
          snapshot = { kind: 'out', chatId: `${kind}:${id}`, text: content };
        }
      } catch { /* Observation must never alter a gateway call. */ }
      const result = await state.calls.run(call, () => Reflect.apply(original, this, args));
      // Nested boundaries are actual deeper sends. Each leaf settles once;
      // its ancestors cannot publish an earlier version of the same params.
      if (snapshot && !call.children) {
        try {
          const id = ownValue(result, 'message_id');
          snapshot.sourceKey = `aurabot:out:send:${randomUUID()}`;
          if ((typeof id === 'string' || Number.isSafeInteger(id)) && String(id).trim() && String(id).length <= 480) {
            snapshot.sourceKey = `aurabot:out:onebot:${id}`;
          }
          Object.freeze(snapshot);
          for (const notify of [...state.listeners]) { try { notify(snapshot); } catch {} }
        } catch { /* A successful send stays successful even if observation fails. */ }
      }
      return result;
    };
    state.boundaries.set(wrapper, original);
    onebot.call = wrapper;
  }
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
    if (!state.listeners.size) while (state.boundaries.has(onebot.call)) onebot.call = state.boundaries.get(onebot.call);
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
        const snapshot = inboundSnapshot(event);
        if (!snapshot) return;
        const cfg = api.config(), self = String(snapshot.self_id || api.core?.hub?.selfId || cfg.botQQ || '');
        const parsed = parseMessageEvent(snapshot, self);
        if (!parsed.userId || (parsed.kind === 'group' && !parsed.groupId) || parsed.userId === self) return;
        if (checkAllowed(cfg, parsed).allowed !== true) return;
        const dto = capture({ ...parsed, raw: { time: snapshot.time } }, false);
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
