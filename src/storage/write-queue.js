import { memoryError } from '../contracts.js';

/** A rejected job settles its own caller without poisoning subsequent submissions. */
export class WriteQueue {
  #tail = Promise.resolve();
  #closed = false;

  enqueue(job) {
    if (this.#closed) return Promise.reject(memoryError('MEMORY_QUEUE_CLOSED', 'Memory write queue is closed'));
    const result = this.#tail.then(() => job());
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  drain() { return this.#tail; }

  close() {
    this.#closed = true;
    return this.drain();
  }
}
