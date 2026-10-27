import { isAbsolute, join, dirname, normalize } from 'node:path';
import { time, text, record, item, invalid } from './shared.js';

// Verified dsh-douyin-browser-local runtime-paths.mjs precedence. No plugin code is executed.
export async function resolveDouyinPath({ home, io, env = process.env }) {
  const absolute = value => { if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value)) invalid(); return normalize(value); };
  const location = env.DOUYIN_RUNTIME_LOCATION_FILE || join(home, 'douyin-browser', 'runtime-location.json');
  let stored = {};
  try {
    stored = JSON.parse(await io.readFile(absolute(location), 'utf8'));
    if (!stored || stored.version !== 1 || typeof stored.stateDir !== 'string') invalid();
    absolute(stored.stateDir);
    if (stored.memoryDir !== undefined) stored.memoryDir = absolute(stored.memoryDir);
    if (stored.memoryDbPath !== undefined) stored.memoryDbPath = absolute(stored.memoryDbPath);
    if (stored.memoryDir && stored.memoryDbPath && dirname(stored.memoryDbPath) !== stored.memoryDir) invalid();
  } catch (error) { if (error.code !== 'ENOENT') invalid(); }
  if (env.DEEPSEEK_SHARED_MEMORY_DB?.trim()) return absolute(env.DEEPSEEK_SHARED_MEMORY_DB);
  if (stored.memoryDbPath) return stored.memoryDbPath;
  if (stored.memoryDir) return join(stored.memoryDir, 'shared.sqlite');
  const legacy = 'D:/codex分局/大肥鱼/memory/shared.sqlite';
  try { if ((await io.stat(legacy)).isFile()) return legacy; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return join(home, 'douyin-browser', 'memory', 'shared.sqlite');
}

/** Only the explicitly verified durable note subset. Video observations and QQ mirrors are excluded. */
export function parseDouyin(db, config) {
  const columns = db.prepare('PRAGMA table_info(memory_entries)').all();
  const required = ['id','kind','content','source','sources_json','video_id','url','author','title','metadata_json','created_at','updated_at','origin','status'];
  if (!required.every(name => columns.some(column => column.name === name
    && column.type.toUpperCase() === (['id','created_at','updated_at'].includes(name) ? 'INTEGER' : 'TEXT')))
    || !columns.some(column => column.name === 'id' && column.pk === 1)) invalid('UNSUPPORTED_SCHEMA');
  return db.prepare("SELECT * FROM memory_entries WHERE origin='video' AND kind='note' AND status='recorded-note' ORDER BY id").all().map((row, index) => {
    const at = time(row.created_at); time(row.updated_at);
    // The verified writer has no public visibility field; global notes remain owner-private.
    return record('item', item(text(row.content, 4000), { subjectKey: 'import:douyin' }),
      { logical: 'shared.sqlite/memory_entries', index, originalTime: at, stableId: row.external_key ?? row.id, config });
  });
}
