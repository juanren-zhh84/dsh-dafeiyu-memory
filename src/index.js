import { resolveConfig } from './config.js';
import { resolveMemoryPaths } from './paths.js';
import { DafeiyuMemoryService } from './service.js';
import { MemoryDatabase } from './storage/database.js';

export const name = 'dafeiyu-memory';

/** Assemble dependencies; all resource cleanup belongs to this one effect. */
export async function apply(ctx, config = {}, dependencies = {}) {
  const resolvedConfig = resolveConfig(config);
  const paths = resolveMemoryPaths(dependencies);
  const database = await MemoryDatabase.open(paths.database);
  try {
    const service = new DafeiyuMemoryService(ctx, { config: resolvedConfig, paths, database });
    ctx.effect(() => () => service.dispose());
  } catch (error) {
    await database.close();
    throw error;
  }
}
