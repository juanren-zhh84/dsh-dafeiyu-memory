import { Service } from '@deepseek-ai/cordis';
import { MEMORY_SERVICE_NAME, memoryError } from './contracts.js';
import { MemoryRepository } from './memory/repository.js';

export class DafeiyuMemoryService extends Service {
  constructor(ctx, { config, paths, database, repository, clock, idGenerator }) {
    super(ctx, MEMORY_SERVICE_NAME);
    this.config = config;
    this.paths = paths;
    this.database = database;
    this.writeQueue = database.writeQueue;
    this.repository = repository ?? new MemoryRepository({ database, writeQueue: this.writeQueue, config, clock, idGenerator });
    this.state = 'ready';
  }

  recall() {
    if (this.state === 'disposed') throw memoryError('MEMORY_DISPOSED', 'Memory service is disposed');
    return '';
  }

  status() {
    return this.state === 'disposed' ? { state: this.state } : { state: this.state, ...this.repository.getStatusCounts() };
  }

  async recordEvent(input) { assertReady(this); return this.repository.insertEvent(input); }
  async search() { return unavailable(this, 'search'); }
  async importExisting() { return unavailable(this, 'importExisting'); }
  async runDueReviews() { return unavailable(this, 'runDueReviews'); }
  async backup() { return unavailable(this, 'backup'); }
  async restoreRecycleItem(input) { assertReady(this); return this.repository.restoreRecycle(input); }
  async purgeRecycleItem() { return unavailable(this, 'purgeRecycleItem'); }
  async promoteToDiary(input) { assertReady(this); return this.repository.appendDiary(input); }

  async dispose() {
    this.state = 'disposed';
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
