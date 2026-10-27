/** Optional unified memory. This thin boundary never logs content or throws into pet chat. */
type MemoryService = {
  recall?: (request: Record<string, string>) => unknown;
  recordEvent?: (event: Record<string, string | number>) => unknown;
};

export function recallForPet(service: unknown, petId: string, text: string): string {
  try {
    const core = service as MemoryService | undefined;
    if (typeof core?.recall !== 'function') return '';
    const result = core.recall({ audience: 'pet', conversationKind: 'pet', conversationKey: `pet:${petId}`,
      actorKey: 'owner', queryText: text });
    if (typeof result === 'string') return result;
    // A mistakenly asynchronous core is not context, and its rejection must not escape.
    void Promise.resolve(result).catch(() => {});
  } catch {}
  return '';
}

export async function recordPetExchange(
  service: unknown, petId: string, userText: string, answer: string,
  stamp: { exchangeId: string; userAt: number; assistantAt: number },
): Promise<string> {
  try {
    const core = service as MemoryService | undefined;
    if (typeof core?.recordEvent !== 'function') return 'PET_MEMORY_UNAVAILABLE';
    if (!stamp.exchangeId || !Number.isSafeInteger(stamp.userAt) || !Number.isSafeInteger(stamp.assistantAt)) {
      return 'PET_MEMORY_RECORD_FAILED';
    }
    const conversationKey = `pet:${petId}`;
    const common = { source: 'pet', conversationKind: 'pet', conversationKey, visibility: 'owner-private' };
    const base = `${conversationKey}:${stamp.exchangeId}`;
    await core.recordEvent({ ...common, sourceKey: `${base}:user`, actorKey: 'owner', actorName: '',
      direction: 'incoming', contentText: userText, occurredAt: stamp.userAt });
    await core.recordEvent({ ...common, sourceKey: `${base}:assistant`, actorKey: conversationKey, actorName: '',
      direction: 'outgoing', contentText: answer, occurredAt: stamp.assistantAt });
    return 'PET_MEMORY_RECORDED';
  } catch { return 'PET_MEMORY_RECORD_FAILED'; }
}
