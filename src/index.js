import { resolveConfig } from './config.js';
import { resolveMemoryPaths } from './paths.js';
import { DafeiyuMemoryService } from './service.js';

export const name = 'dafeiyu-memory';

/** Assemble dependencies; all resource cleanup belongs to this one effect. */
export function apply(ctx, config = {}, dependencies = {}) {
  const resolvedConfig = resolveConfig(config);
  const paths = resolveMemoryPaths(dependencies);
  const service = new DafeiyuMemoryService(ctx, { config: resolvedConfig, paths });
  ctx.effect(() => () => service.dispose());
}
