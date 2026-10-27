export const NOW = 1_800_000_000_000;
export const DAY = 86_400_000;

export function eventInput(overrides = {}) {
  return {
    source: 'qq', sourceKey: 'message-1', conversationKind: 'private',
    conversationKey: 'qq:user-1', actorKey: 'user-1', actorName: '测试用户',
    direction: 'incoming', contentText: '我喜欢钓鱼', occurredAt: NOW,
    visibility: 'owner-private', ...overrides,
  };
}
