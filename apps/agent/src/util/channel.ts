/** Unbounded async queue: producers push, one consumer iterates. */
export class Channel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    this.queue.push(value);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}
