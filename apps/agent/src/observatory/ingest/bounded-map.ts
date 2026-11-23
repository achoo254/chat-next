// A Map that keeps at most `max` entries, dropping the oldest inserted first.
// The ingest's join state (tool timings, /clear halves, sessions seen) lives
// in these, so an agent running for months never grows without bound; what
// falls out only loses a join the store's own keys make up for (a duplicate
// still merges into one row).
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Sets `key` (moved to the newest place), dropping the oldest entries past the bound. */
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }
}
