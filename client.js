window.__ModuleLoader__.load({
  id: 'dsh-dafeiyu-memory',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const active = new WeakMap();
    const API = '/dafeiyu-memory/api';
    const CSS = `
[data-memory]{width:100%;min-width:0;box-sizing:border-box;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,inherit)}
[data-memory] *{box-sizing:border-box;min-width:0}
[data-memory] h2{font:inherit;font-size:16px;font-weight:600;margin:0}
[data-memory] h3{font:inherit;font-weight:600;margin:0 0 10px}
[data-memory] button,[data-memory] input,[data-memory] select{font:inherit;color:inherit;background:var(--dsw-alias-background-primary,transparent);border:1px solid var(--dsw-alias-border-primary,#8886);border-radius:6px;min-height:34px;padding:6px 10px;max-width:100%}
[data-memory] button{cursor:pointer;flex-shrink:0}[data-memory] button:hover{background:var(--dsw-alias-background-secondary,#8881)}
[data-memory] button:disabled{opacity:.45;cursor:default}[data-memory] :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5786bc);outline-offset:2px}
[data-memory] .memory-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
[data-memory] .memory-header{justify-content:space-between;padding-bottom:16px}
[data-memory] .memory-counts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-block:1px solid var(--dsw-alias-border-primary,#8886)}
[data-memory] .memory-count{padding:14px 12px 14px 0}[data-memory] .memory-count strong{font-size:26px;font-variant-numeric:tabular-nums;display:block;line-height:1.4}
[data-memory] .memory-muted{color:var(--dsw-alias-label-secondary,#81858b);font-size:12px;line-height:1.6}
[data-memory] .memory-section{padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-primary,#8886)}
[data-memory] .memory-metrics{display:flex;flex-wrap:wrap;gap:12px 24px;line-height:1.8;font-variant-numeric:tabular-nums}
[data-memory] .memory-notice{min-height:30px;margin:4px 0 0;overflow-wrap:anywhere;line-height:1.6}
[data-memory] .memory-search{flex:1 1 180px}
[data-memory] .memory-ledger{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-primary,#8884)}
[data-memory] .memory-ledger-top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
[data-memory] .memory-id{overflow-wrap:anywhere;font-variant-numeric:tabular-nums;margin:4px 0 8px}
[data-memory] .memory-body{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.8;margin:12px 0;padding:10px 0;border-block:1px solid var(--dsw-alias-border-primary,#8884)}
[data-memory] .memory-confirm{margin-top:12px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-primary,#8886);overflow-wrap:anywhere}
[data-memory] .memory-confirm input{width:100%;margin:10px 0}
[data-memory] .memory-danger{color:var(--dsw-alias-status-error,#bb4c46)}
@media(max-width:520px){[data-memory] .memory-counts{grid-template-columns:repeat(2,minmax(0,1fr))}[data-memory] .memory-metrics{gap:8px 16px}[data-memory] .memory-ledger-top{align-items:flex-start}[data-memory] .memory-header{align-items:flex-start}}
`;
    const time = (value) => Number.isSafeInteger(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
    const bytes = (value) => Number.isFinite(value) ? `${(value / 1048576).toFixed(1)} MiB` : '—';
    const sources = { qq: 'QQ', pet: '桌宠', douyin: '抖音（可选）', memory: '长期记忆', diary: '日记' };
    const kinds = { event: '短期', item: '长期', diary: '日记' };
    const states = { ready: '正常', warning: '接近容量上限', degraded: '降级', disposed: '已停止', unavailable: '不可用' };
    const codes = { observed: '已观察到记录', unobserved: '尚未观察到记录', 'optional-unobserved': '未接入 / 未观察到记录' };

    function Panel() {
      const [status, setStatus] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [layer, setLayer] = React.useState('all');
      const [list, setList] = React.useState({ items: [], hasMore: false, offset: 0 });
      const [details, setDetails] = React.useState({});
      const [confirm, setConfirm] = React.useState(null);
      const [phrase, setPhrase] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const lifecycle = React.useRef(null);
      const generation = React.useRef(0);
      const statusGeneration = React.useRef(0);

      async function json(path, input, session) {
        const response = await fetch(API + path, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin',
          headers: input === undefined ? {} : { 'content-type': 'application/json' },
          body: input === undefined ? undefined : JSON.stringify(input), signal: session.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.code === 'string' && /^[A-Z_]{1,80}$/.test(data.code) ? data.code : 'MEMORY_REQUEST_FAILED');
        return data;
      }

      async function loadStatus(session) {
        const seq = ++statusGeneration.current;
        try {
          const value = await json('/status', undefined, session);
          if (!session.signal.aborted && seq === statusGeneration.current) setStatus(value);
        } catch (error) {
          if (!session.signal.aborted && seq === statusGeneration.current) throw error;
        }
      }

      React.useEffect(() => {
        const controller = new AbortController();
        lifecycle.current = controller;
        loadStatus(controller).catch(() => { if (!controller.signal.aborted) setNotice('MEMORY_REQUEST_FAILED'); });
        const seq = ++generation.current;
        json('/search', { context: 'management', query: '', layer: 'all' }, controller)
          .then((results) => { if (!controller.signal.aborted && seq === generation.current) setList(results); })
          .catch(() => { if (!controller.signal.aborted && seq === generation.current) setNotice('MEMORY_REQUEST_FAILED'); });
        return () => { controller.abort(); if (lifecycle.current === controller) lifecycle.current = null; };
      }, []);

      async function perform(work) {
        const session = lifecycle.current;
        if (!session || session.signal.aborted || busy) return;
        const seq = ++generation.current;
        setBusy(true); setNotice('');
        const current = () => !session.signal.aborted && seq === generation.current;
        try {
          await work(session, current);
        } catch (error) { if (current()) setNotice(error.message || 'MEMORY_REQUEST_FAILED'); }
        finally { if (current()) setBusy(false); }
      }
      const search = (offset = 0) => perform(async (session, current) => {
        const results = await json('/search', { context: 'management', query, layer, offset }, session);
        if (current()) { setList(results); setDetails({}); setConfirm(null); setPhrase(''); }
      });
      const refresh = (path, input, success) => perform(async (session, current) => {
        await json(path, input, session);
        const [, results] = await Promise.all([loadStatus(session), json('/search', { context: 'management', query, layer }, session)]);
        if (current()) { setList(results); setDetails({}); setConfirm(null); setPhrase(''); setNotice(success); }
      });
      const expand = (item) => {
        const key = `${item.kind}:${item.id}`;
        if (Object.hasOwn(details, key)) { setDetails((value) => { const next = { ...value }; delete next[key]; return next; }); return; }
        perform(async (session, current) => {
          const value = await json('/detail', { context: 'management', kind: item.kind, id: item.id }, session);
          if (current()) setDetails((previous) => ({ ...previous, [key]: value.content }));
        });
      };
      const button = (label, onClick, props = {}) => h('button', { type: 'button', disabled: busy, onClick, ...props }, label);
      return h('section', { 'data-memory': '', 'aria-label': '大肥鱼记忆台账', 'aria-busy': busy },
        h('div', { className: 'memory-row memory-header' }, h('h2', null, '记忆台账'), h('span', { className: 'memory-muted' }, status ? states[status.code] || '不可用' : '正在读取…')),
        h('div', { className: 'memory-counts' }, ...[['short', '短期 · 7 天'], ['long', '长期 · 30 天'], ['diary', '永久日记'], ['recycle', '回收站 · 7 天']].map(([key, label]) =>
          h('div', { className: 'memory-count', key }, h('span', { className: 'memory-muted' }, label), h('strong', null, status?.counts?.[key] ?? '—')))),
        h('section', { className: 'memory-section', 'aria-label': '任务与容量' }, h('h3', null, '任务与容量'),
          h('div', { className: 'memory-metrics' }, h('span', null, `待处理 ${status?.tasks?.pending ?? '—'}`), h('span', null, `失败 ${status?.tasks?.failed ?? '—'}`), h('span', null, `下次整理 ${time(status?.tasks?.nextAt)}`)),
          h('div', { className: 'memory-metrics memory-muted' }, h('span', null, `数据库 ${bytes(status?.capacity?.databaseBytes)}`), h('span', null, `备份 ${bytes(status?.capacity?.backupsBytes)}`), h('span', null, `离线队列 ${bytes(status?.capacity?.spoolBytes)}`), h('span', null, `总计 ${bytes(status?.capacity?.totalBytes)} / ${bytes(status?.capacity?.limitBytes)}`)),
          h('div', { className: 'memory-row', style: { marginTop: 12 } }, button('立即备份', () => refresh('/backup', {}, '备份已完成')), button('立即整理', () => refresh('/review/run', {}, '整理已完成')))),
        h('section', { className: 'memory-section', 'aria-label': '连接器观察状态' }, h('h3', null, '连接器观察状态'),
          ...['qq', 'pet', 'douyin'].map((source) => h('div', { className: 'memory-row', key: source }, h('span', null, sources[source]),
            h('span', { className: 'memory-muted' }, codes[status?.connectors?.[source]?.code] || '读取中…'), h('span', { className: 'memory-muted' }, time(status?.connectors?.[source]?.lastAt))))),
        h('section', { className: 'memory-section', 'aria-label': '搜索记忆' },
          h('form', { className: 'memory-row', onSubmit: (event) => { event.preventDefault(); search(); } },
            h('input', { className: 'memory-search', 'aria-label': '搜索关键字', placeholder: '搜索记忆', maxLength: 200, value: query, onChange: (event) => setQuery(event.target.value) }),
            h('select', { 'aria-label': '记忆层级', value: layer, onChange: (event) => setLayer(event.target.value) }, ...[['all', '全部有效记忆'], ['short', '短期'], ['long', '长期'], ['diary', '日记'], ['recycle', '回收站']].map(([value, text]) => h('option', { key: value, value }, text))),
            h('button', { type: 'submit', disabled: busy }, '搜索')),
          h('div', { className: 'memory-notice', role: 'status', 'aria-live': 'polite' }, notice),
          list.items.length === 0 ? h('p', { className: 'memory-muted' }, status ? '没有匹配记录' : '正在读取…') : null,
          ...list.items.map((item) => {
            const key = `${item.kind}:${item.id}`;
            const open = Object.hasOwn(details, key);
            const deleting = confirm?.id === item.id && confirm?.kind === item.kind;
            return h('article', { key, className: 'memory-ledger', 'aria-label': `${kinds[item.kind]}记录` },
              h('div', { className: 'memory-ledger-top' }, h('div', null, `${kinds[item.kind]} · ${sources[item.source] || '记忆'} · ${item.state === 'recycle' ? '回收站' : '有效'}`), h('time', { className: 'memory-muted' }, time(item.time))),
              h('div', { className: 'memory-id memory-muted' }, `编号 ${item.id} · 身份已隐藏`),
              h('div', { className: 'memory-row' }, button(open ? '收起正文' : '展开正文', () => expand(item), { 'aria-expanded': open }),
                item.state === 'recycle' ? button('恢复', () => refresh('/recycle/restore', { kind: item.kind, id: item.id, version: item.version }, '已恢复')) : null,
                item.kind === 'item' && item.state !== 'recycle' ? button('写入日记', () => refresh('/diary/promote', { id: item.id }, '已写入日记')) : null,
                item.state === 'recycle' ? button('永久删除', () => { setConfirm(item); setPhrase(''); }, { className: 'memory-danger' }) : null),
              open ? h('pre', { className: 'memory-body' }, details[key]) : null,
              deleting ? h('div', { className: 'memory-confirm', role: 'group', 'aria-label': '永久删除二次确认' },
                h('strong', { className: 'memory-danger' }, '确认永久删除此记录'), h('div', { className: 'memory-muted' }, `输入：永久删除 ${item.id}`),
                h('input', { 'aria-label': '永久删除确认短语', value: phrase, autoComplete: 'off', onChange: (event) => setPhrase(event.target.value) }),
                h('div', { className: 'memory-row' }, button('确认永久删除', () => refresh('/recycle/purge', { kind: item.kind, id: item.id, version: item.version, confirmation: phrase }, '已永久删除'), { className: 'memory-danger', disabled: busy || phrase !== `永久删除 ${item.id}` }),
                  button('取消', () => { setConfirm(null); setPhrase(''); }))) : null);
          }),
          h('div', { className: 'memory-row', style: { marginTop: 12 } }, button('上一页', () => search(Math.max(0, list.offset - 50)), { disabled: busy || list.offset === 0 }),
            button('下一页', () => search(list.offset + 50), { disabled: busy || !list.hasMore }))));
    }

    return { inject: ['slots', 'locale'], apply(ctx) {
      if (active.has(ctx)) return;
      const slots = ctx.get('slots');
      const locale = ctx.get('locale');
      ctx.effect(() => {
        let slotDispose;
        const style = document.createElement('style');
        style.setAttribute('data-plugin-css', 'dsh-dafeiyu-memory'); style.textContent = CSS; document.head.appendChild(style);
        const injectionDispose = slots.inject('settings.section', () => {
          slotDispose?.();
          slotDispose = slots.register({ name: 'settings.section', id: 'dafeiyu-memory', order: 35,
            label: typeof locale?.t === 'function' ? locale.t('记忆台账') : '记忆台账' }, () => h(Panel));
        });
        active.set(ctx, true);
        return () => { injectionDispose?.(); slotDispose?.(); style.remove(); active.delete(ctx); };
      });
    } };
  },
});
