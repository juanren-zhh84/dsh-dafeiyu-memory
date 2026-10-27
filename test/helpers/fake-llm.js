export function textStream(text, reason = 'stop') {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: reason } },
  ];
}

export function createFakeLlm(chunks, selection = { provider: 'test', model: 'test-model' }) {
  const requests = [];
  let reads = 0;
  const ctx = {
    agentDefaultModel: {
      currentSelection() { reads++; return selection; },
      saveSelection() { throw new Error('must not save selection'); },
    },
    llm: {
      stream(options) {
        requests.push(options);
        return typeof chunks === 'function' ? chunks(options) : (async function* () { yield* chunks; })();
      },
    },
  };
  return { ctx, requests, selection, get reads() { return reads; } };
}
