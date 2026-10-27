import { tokenize } from './tokenize.js';

/** Lexicographic priorities are deliberately separate; lower priorities never outweigh higher ones. */
export function rankMemories(candidates, request) {
  const query = new Set(tokenize(request.queryText));
  const scored = candidates.map((candidate) => {
    const { row, projection } = candidate;
    const scope = Number(typeof request.conversationKey === 'string' && row.conversation_key === request.conversationKey)
      + Number(typeof request.actorKey === 'string' && row.actor_key === request.actorKey)
      + Number(typeof row.subject_key === 'string' && [request.conversationKey, request.actorKey].includes(row.subject_key));
    const text = [projection.contentText, projection.content, projection.title, projection.body, projection.summary].filter(Boolean).join(' ');
    const tokens = new Set(tokenize(text));
    const relevance = [...query].filter((token) => tokens.has(token)).length;
    return { candidate, score: [scope, relevance, row.importance ?? 0,
      row.occurred_at ?? row.promoted_at ?? row.written_at ?? 0, row.recall_days ?? 0] };
  });
  return scored.sort((a, b) => {
    for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return b.score[i] - a.score[i];
    return a.candidate.row.id < b.candidate.row.id ? -1 : a.candidate.row.id > b.candidate.row.id ? 1 : 0;
  }).map(({ candidate }) => candidate);
}
