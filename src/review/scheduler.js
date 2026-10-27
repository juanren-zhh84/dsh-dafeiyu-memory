/** One recursive timer, including catch-up, belongs to the plugin effect. */
export class ReviewScheduler {
  #started;
  #disposed = false;
  #timer;
  #closing;

  constructor({ lifecycle, intervalMs, timer = globalThis }) {
    Object.assign(this, { lifecycle, intervalMs, timer });
  }

  async #tick() {
    if (this.#disposed) return;
    try { await this.lifecycle.runDueReviews(); } catch { /* Review failures do not disable record/recall. */ }
    if (!this.#disposed) {
      this.#timer = this.timer.setTimeout(() => this.#tick(), this.intervalMs);
      this.#timer?.unref?.();
    }
  }

  start() {
    if (!this.#started && !this.#disposed) this.#started = this.#tick();
    return this.#started ?? Promise.resolve();
  }

  dispose() {
    if (!this.#closing) {
      this.#disposed = true;
      if (this.#timer !== undefined) this.timer.clearTimeout(this.#timer);
      this.#closing = this.lifecycle.dispose();
    }
    return this.#closing;
  }
}
