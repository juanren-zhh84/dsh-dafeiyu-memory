import { invalid, publicStatus, string, target, validateFields } from './projection.js';
import { safeErrorCode } from '../maintenance/backup.js';

export const MANAGEMENT_PREFIX = '/dafeiyu-memory/api';
const BODY_LIMIT = 16 * 1024;
const ERRORS = { MEMORY_INVALID_INPUT: 400, MEMORY_BODY_TOO_LARGE: 413, MEMORY_UNSUPPORTED_MEDIA_TYPE: 415,
  MEMORY_METHOD_NOT_ALLOWED: 405, MEMORY_FORBIDDEN: 403, MEMORY_REFERENCE_NOT_FOUND: 404, MEMORY_NOT_FOUND: 404,
  MEMORY_CONFLICT: 409, MEMORY_DISPOSED: 503, MEMORY_BACKUP_FAILED: 503, MEMORY_PURGE_FAILED: 503,
  MEMORY_STORAGE_FAILED: 503, MEMORY_DATABASE_CLOSED: 503, MEMORY_INTERNAL_ERROR: 500 };

function localRequest(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) invalid('MEMORY_FORBIDDEN');
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { invalid('MEMORY_FORBIDDEN'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) || host.username || host.password || host.pathname !== '/') invalid('MEMORY_FORBIDDEN');
  if (req.headers['sec-fetch-site'] === 'cross-site') invalid('MEMORY_FORBIDDEN');
  if (req.headers.origin !== undefined && req.headers.origin !== host.origin) invalid('MEMORY_FORBIDDEN');
}

async function body(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) invalid('MEMORY_UNSUPPORTED_MEDIA_TYPE');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) invalid('MEMORY_BODY_TOO_LARGE');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) invalid('MEMORY_BODY_TOO_LARGE');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { invalid(); }
}

function send(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(value));
}

export function registerManagementRoutes(ctx, service) {
  if (!ctx.webServer?.register) return;
  return ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: MANAGEMENT_PREFIX,
    async handler(req, res) {
      try {
        localRequest(req);
        const path = new URL(req.url, 'http://127.0.0.1').pathname.slice(MANAGEMENT_PREFIX.length);
        if (path === '/status') {
          if (req.method !== 'GET') invalid('MEMORY_METHOD_NOT_ALLOWED');
          return send(res, 200, publicStatus(service));
        }
        if (!['/search', '/detail', '/recycle/restore', '/recycle/purge', '/diary/promote', '/backup', '/review/run'].includes(path)) invalid('MEMORY_NOT_FOUND');
        if (req.method !== 'POST') invalid('MEMORY_METHOD_NOT_ALLOWED');
        const input = await body(req);
        let output;
        if (path === '/search') output = await service.search(input);
        if (path === '/detail') output = await service.detail(input);
        if (path === '/recycle/restore') {
          const result = await service.restoreRecycleItem(target(input));
          output = { id: result.id, code: 'restored' };
        }
        if (path === '/recycle/purge') {
          const data = target(input, ['kind', 'id', 'version', 'confirmation']);
          if (data.confirmation !== `永久删除 ${data.id}`) invalid();
          const { confirmation, ...selected } = data;
          output = await service.purgeRecycleItem(selected, confirmation);
        }
        if (path === '/diary/promote') {
          const data = validateFields(input, ['id']); string(data.id);
          const result = await service.repository.promoteItemToDiary(data);
          output = { id: result.id, code: 'diary-written' };
        }
        if (path === '/backup') {
          validateFields(input, []);
          const result = await service.backup(); output = { code: 'backup-created', time: result.time };
        }
        if (path === '/review/run') {
          validateFields(input, []);
          const result = await service.runDueReviews({ retryFailed: true });
          output = { queued: result.queued, completed: result.completed, retried: result.retried, failed: result.failed };
        }
        return send(res, 200, output);
      } catch (error) {
        const value = safeErrorCode(error);
        const code = typeof value === 'string' && Object.hasOwn(ERRORS, value) ? value : 'MEMORY_INTERNAL_ERROR';
        return send(res, ERRORS[code], { code });
      }
    },
  }));
}
