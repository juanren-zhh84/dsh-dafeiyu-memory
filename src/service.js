import { Service } from '@deepseek-ai/cordis';
import { MEMORY_SERVICE_NAME, memoryError } from './contracts.js';
import { MemoryRepository } from './memory/repository.js';
import { RecallEngine } from './memory/recall.js';
import { ReviewModel } from './review/model-client.js';
import { ReviewLifecycle } from './review/lifecycle.js';
import { ReviewScheduler } from './review/scheduler.js';
import { BackupManager } from './maintenance/backup.js';
import { PurgeManager } from './maintenance/purge.js';
import { CapacityManager } from './maintenance/capacity.js';
import { EventSpool } from './maintenance/spool.js';

export class DafeiyuMemoryService extends Service {
  constructor(ctx, { config, paths, database, repository, clock, idGenerator, reviewModel, timer, maintenance = {} }) {
    super(ctx, MEMORY_SERVICE_NAME);
    this.config = config;
    this.paths = paths;
    this.database = database;
    this.writeQueue = database.writeQueue;
    this.repository = repository ?? new MemoryRepository({ database, writeQueue: this.writeQueue, config, clock, idGenerator });
    this.recallEngine = new RecallEngine({ database, writeQueue: this.writeQueue, clock });
    this.reviewModel = reviewModel ?? new ReviewModel(ctx, { config });
    this.reviewLifecycle = new ReviewLifecycle({ database, repository: this.repository, reviewModel: this.reviewModel, config, clock });
    this.backupManager = new BackupManager({ database, paths, config, clock, ...maintenance });
    this.purgeManager = new PurgeManager({ database, backupManager: this.backupManager, config, clock });
    this.capacityManager = new CapacityManager({ database, paths, config, backupManager: this.backupManager, purgeManager: this.purgeManager,
      io: maintenance.capacityIo });
    this.spool = new EventSpool({ paths, config, writeQueue: this.writeQueue, recordEvent: (input) => this.recordEvent(input),
      io: maintenance.io, canGrow: () => this.capacityManager.status().state !== 'degraded' });
    this.state = 'ready';
    this.scheduler = new ReviewScheduler({ lifecycle: {
      runDueReviews: async () => {
        try { return await this.reviewLifecycle.runDueReviews(); }
        finally {
          if (this.state !== 'disposed') {
            try { await this.runMaintenance(); } catch { /* Maintenance cannot disable normal memory operations. */ }
            if (this.state !== 'disposed') try { await this.drainSpool(); } catch { /* Keep the batch for retry. */ }
          }
        }
      },
      dispose: () => this.reviewLifecycle.dispose(),
    }, intervalMs: config.reviewScanIntervalMs, timer });
  }

  recall(request) {
    if (this.state === 'disposed') throw memoryError('MEMORY_DISPOSED', 'Memory service is disposed');
    return this.recallEngine.recall(request).text;
  }

  status() {
    if (this.state === 'disposed') return { state: this.state };
    const maintenance = this.capacityManager.status();
    return { state: maintenance.state === 'degraded' ? 'degraded' : this.state, ...this.repository.getStatusCounts(), maintenance };
  }

  async recordEvent(input) { assertReady(this); return this.repository.insertEvent(input); }
  async search() { return unavailable(this, 'search'); }
  async importExisting() { return unavailable(this, 'importExisting'); }
  async runDueReviews() { assertReady(this); return this.reviewLifecycle.runDueReviews(); }
  async backup() { assertReady(this); return this.backupManager.create(); }
  async restoreRecycleItem(input) { assertReady(this); return this.repository.restoreRecycle(input); }
  async purgeRecycleItem(input) { assertReady(this); return this.purgeManager.run(input); }
  async promoteToDiary(input) { assertReady(this); return this.repository.appendDiary(input); }
  async runMaintenance() { assertReady(this); return this.capacityManager.run(); }
  async enqueueSpool(input) { assertReady(this); return this.spool.enqueue(input); }
  async drainSpool() { assertReady(this); return this.spool.drain(); }

  async dispose() {
    this.state = 'disposed';
    await this.scheduler.dispose();
    await this.spool.settle();
    await this.database.close();
  }
}

function unavailable(service, method) {
  assertReady(service);
  throw memoryError('MEMORY_NOT_IMPLEMENTED', `Memory operation is not implemented: ${method}`);
}

function assertReady(service) {
  if (service.state === 'disposed') throw memoryError('MEMORY_DISPOSED', 'Memory service is disposed');
}
