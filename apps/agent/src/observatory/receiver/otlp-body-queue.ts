// The receiver's queue of request bodies already answered: bounded (count
// and bytes; a body past either is dropped and counted by the caller), and
// processed one body per turn of the event loop, so a burst of requests
// never holds the agent up for longer than one body's parse and filter.

export class OtlpBodyQueue {
  private queue: Buffer[] = [];
  private bytes = 0;
  private scheduled = false;

  constructor(
    private readonly maxBodies: number,
    private readonly maxBytes: number,
    private readonly process: (body: Buffer) => void,
  ) {}

  get depth(): number {
    return this.queue.length;
  }

  /** Queues `body`; false (nothing queued) when the queue is full. */
  push(body: Buffer): boolean {
    if (this.queue.length >= this.maxBodies || this.bytes + body.length > this.maxBytes) return false;
    this.queue.push(body);
    this.bytes += body.length;
    this.schedule();
    return true;
  }

  /** Processes everything waiting now (on stop). */
  drainAll(): void {
    while (this.queue.length > 0) this.processOne();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.processOne();
      if (this.queue.length > 0) this.schedule();
    });
  }

  private processOne(): void {
    const body = this.queue.shift();
    if (body === undefined) return;
    this.bytes -= body.length;
    this.process(body);
  }
}
