import { resolveConfig } from './config.js';
import { resolveMemoryPaths } from './paths.js';
import { DafeiyuMemoryService } from './service.js';
import { MemoryDatabase } from './storage/database.js';
import { BackupManager } from './maintenance/backup.js';
import { WriteQueue } from './storage/write-queue.js';
import { registerManagementRoutes } from './management/routes.js';

export const name = 'dafeiyu-memory';
export const inject = ['llm', 'agentDefaultModel'];

/** Assemble dependencies; all resource cleanup belongs to this one effect. */
export async function apply(ctx, config = {}, dependencies = {}) {
  const resolvedConfig = resolveConfig(config);
  const paths = resolveMemoryPaths(dependencies);
  const database = await MemoryDatabase.open(paths.database, { beforeMigrate: async ({ database: source }) => {
    const writeQueue = new WriteQueue();
    const manager = new BackupManager({ paths, config: resolvedConfig, clock: dependencies.clock,
      database: { writeQueue, backupTo: (path, implementation) => implementation(source, path) }, ...dependencies.maintenance });
    try { await manager.create('migration', true); } finally { await writeQueue.close(); }
  } });
  try {
    const { clock, timer, reviewModel, maintenance } = dependencies;
    const service = new DafeiyuMemoryService(ctx, { config: resolvedConfig, paths, database, clock, timer, reviewModel, maintenance });
    ctx.effect(() => {
      service.scheduler.start();
      return () => service.dispose();
    });
    // The optional webserver can appear/disappear without restarting the core.
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (webCtx) => registerManagementRoutes(webCtx, service));
    else registerManagementRoutes(ctx, service);
  } catch (error) {
    await database.close();
    throw error;
  }
}
