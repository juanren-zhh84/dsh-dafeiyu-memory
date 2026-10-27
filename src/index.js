import { resolveConfig } from './config.js';
import { resolveMemoryPaths } from './paths.js';
import { DafeiyuMemoryService } from './service.js';
import { MemoryDatabase } from './storage/database.js';

export const name = 'dafeiyu-memory';
export const inject = ['llm', 'agentDefaultModel'];

/** Assemble dependencies; all resource cleanup belongs to this one effect. */
export async function apply(ctx, config = {}, dependencies = {}) {
  const resolvedConfig = resolveConfig(config);
  const paths = resolveMemoryPaths(dependencies);
  const database = await MemoryDatabase.open(paths.database);
  try {
    const { clock, timer, reviewModel } = dependencies;
    const service = new DafeiyuMemoryService(ctx, { config: resolvedConfig, paths, database, clock, timer, reviewModel });
    ctx.effect(() => {
      service.scheduler.start();
      return () => service.dispose();
    });
  } catch (error) {
    await database.close();
    throw error;
  }
}
