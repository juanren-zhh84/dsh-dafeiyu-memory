import { Service } from '@deepseek-ai/cordis';
import { MEMORY_SERVICE_NAME, memoryError } from './contracts.js';

export class DafeiyuMemoryService extends Service {
  constructor(ctx, { config, paths, database }) {
    super(ctx, MEMORY_SERVICE_NAME);
    this.config = config;
    this.paths = paths;
    this.database = database;
    this.writeQueue = database.writeQueue;
    this.state = 'ready';
  }

  recall() {
    if (this.state === 'disposed') throw memoryError('MEMORY_DISPOSED', 'Memory service is disposed');
    return '';
  }

  status() {
    return { state: this.state };
  }

  async recordEvent() { return unavailable(this, 'recordEvent'); }
  async search() { return unavailable(this, 'search'); }
  async importExisting() { return unavailable(this, 'importExisting'); }
  async runDueReviews() { return unavailable(this, 'runDueReviews'); }
  async backup() { return unavailable(this, 'backup'); }
  async restoreRecycleItem() { return unavailable(this, 'restoreRecycleItem'); }
  async purgeRecycleItem() { return unavailable(this, 'purgeRecycleItem'); }
  async promoteToDiary() { return unavailable(this, 'promoteToDiary'); }

  async dispose() {
    this.state = 'disposed';
    await this.database.close();
  }
}

function unavailable(service, method) {
  if (service.state === 'disposed') throw memoryError('MEMORY_DISPOSED', 'Memory service is disposed');
  throw memoryError('MEMORY_NOT_IMPLEMENTED', `Memory operation is not implemented: ${method}`);
}
