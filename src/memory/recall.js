import { memoryError } from '../contracts.js';
import { allowsMemory, candidateScope, normalizeRequest, projectMemory } from './privacy.js';
import { rankMemories } from './rank.js';

const LAYERS = Object.freeze([
  { name: 'short', table: 'memory_events', type: 'event', limit: 8, valid: "state IN ('active', 'review-pending')" },
  { name: 'long', table: 'memory_items', type: 'item', limit: 6, valid: "state = 'active'" },
  { name: 'diary', table: 'diary_entries', type: 'diary', limit: 3, valid: '1' },
]);
const empty = () => ({ short: [], long: [], diary: [], text: '' });

export class RecallEngine {
  constructor({ database, writeQueue = database.writeQueue, clock = Date }) {
    this.database = database;
    this.writeQueue = writeQueue;
    this.clock = clock;
  }

  recall(input) {
    const request = normalizeRequest(input, this.clock);
    if (!request) return empty();
    const result = empty();
    const selected = [];
    try {
      this.database.read((db) => {
        for (const layer of LAYERS) {
          const scope = candidateScope(layer.name, request);
          const candidates = db.prepare(`SELECT m.*, (SELECT count(*) FROM memory_recall_days AS r
            WHERE r.memory_type = '${layer.type}' AND r.memory_id = m.id) AS recall_days
            FROM ${layer.table} AS m WHERE ${scope.sql}`).all(...scope.params)
            .filter((row) => allowsMemory(layer.name, row, request))
            .map((row) => ({ row, projection: projectMemory(layer.name, row, request) }));
          const ranked = rankMemories(candidates, request).slice(0, layer.limit);
          result[layer.name] = ranked.map(({ projection }) => projection);
          selected.push(...ranked.map(({ row }) => ({ layer, id: row.id })));
        }
      });
    } catch { throw memoryError('MEMORY_STORAGE_FAILED', 'Memory storage operation failed'); }
    result.text = [
      result.short.length ? `短期记忆：\n${result.short.map(({ contentText }) => `- ${contentText}`).join('\n')}` : '',
      result.long.length ? `长期记忆：\n${result.long.map(({ content }) => `- ${content}`).join('\n')}` : '',
      result.diary.length ? `日记：\n${result.diary.map(({ title, body, summary }) => `- ${title}：${body ?? summary}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    this.#recordDays(selected, Math.floor(request.now / 86_400_000));
    return result;
  }

  #recordDays(selected, day) {
    if (!selected.length) return;
    try {
      const queued = this.writeQueue.enqueue(() => this.database.transaction((db) => {
        for (const { layer, id } of selected) {
          db.prepare(`INSERT OR IGNORE INTO memory_recall_days (memory_type, memory_id, recalled_day)
            SELECT ?, id, ? FROM ${layer.table} WHERE id = ? AND ${layer.valid}`).run(layer.type, day, id);
        }
      }));
      Promise.resolve(queued).catch(() => {});
    } catch { /* Disposable statistics must never affect retrieval or log private content. */ }
  }
}
