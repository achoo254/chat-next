// Per-thread journal: an append-only JSONL file of item revisions. Every
// change (new item or new revision) takes the next seq, so a device that
// last applied seq N gets every change by reading the latest revision of
// each item whose seq is above N.
import { appendFileSync, existsSync, readFileSync, truncateSync } from "node:fs";
import { type MessageInitShape, clone, create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { type Item, ItemSchema } from "@achoo254/chat-proto/remote/remote";
import type { JournalBounds } from "@achoo254/chat-remote-protocol";

export type ItemBody = NonNullable<MessageInitShape<typeof ItemSchema>["body"]>;

export class Journal {
  private items = new Map<string, Item>();
  private lastSeq = 0n;

  constructor(private readonly file: string) {}

  /** Loads the file; a torn last line (crash mid-write) is cut off. */
  load(): void {
    if (!existsSync(this.file)) return;
    const raw = readFileSync(this.file);
    let good = 0;
    let start = 0;
    for (;;) {
      const nl = raw.indexOf(0x0a, start);
      if (nl < 0) break; // a line without its newline was torn
      const line = raw.subarray(start, nl).toString("utf8");
      if (line.trim()) {
        try {
          const item = fromJsonString(ItemSchema, line);
          this.items.set(item.id, item);
          if (item.seq > this.lastSeq) this.lastSeq = item.seq;
        } catch {
          break;
        }
      }
      start = nl + 1;
      good = start;
    }
    if (good < raw.length) truncateSync(this.file, good);
  }

  get(id: string): Item | undefined {
    return this.items.get(id);
  }

  /** Creates the item or a new revision of it; returns the stored copy. */
  put(id: string, body: ItemBody, meta: { provider: string; model: string; now?: number }): Item {
    const prev = this.items.get(id);
    this.lastSeq += 1n;
    const item = create(ItemSchema, {
      id,
      seq: this.lastSeq,
      revision: (prev?.revision ?? 0) + 1,
      at: BigInt(prev ? prev.at : (meta.now ?? Date.now())),
      provider: prev?.provider ?? meta.provider,
      model: prev?.model ?? meta.model,
      body,
    });
    this.items.set(id, item);
    appendFileSync(this.file, `${toJsonString(ItemSchema, item)}\n`);
    return item;
  }

  /** Writes a changed copy of an existing item as its next revision. */
  update(id: string, change: (body: Item["body"]) => void): Item | undefined {
    const prev = this.items.get(id);
    if (!prev) return undefined;
    const next = clone(ItemSchema, prev);
    change(next.body);
    return this.put(id, next.body as ItemBody, { provider: prev.provider, model: prev.model });
  }

  /** Latest revisions changed after `seq`, oldest first. */
  since(seq: bigint): Item[] {
    return [...this.items.values()].filter((i) => i.seq > seq).sort((a, b) => (a.seq < b.seq ? -1 : 1));
  }

  all(): Item[] {
    return this.since(0n);
  }

  bounds(epoch: bigint): JournalBounds {
    return { epoch, firstSeq: 1n, lastSeq: this.lastSeq };
  }
}
