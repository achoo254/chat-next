// A JSON reader that takes only the values asked for out of one record and
// steps over everything else without decoding it. A reply record of Claude
// Code can be megabytes of thinking, text and tool input; the usage scan
// needs a few short fields of it, so it never turns the rest into strings
// (which also means a message is never decoded at all). Malformed input
// throws.

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

export class JsonCursor {
  pos = 0;

  constructor(private readonly buf: Buffer) {}

  private fail(what: string): never {
    throw new SyntaxError(`${what} at byte ${this.pos}`);
  }

  private ws(): void {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) return;
      this.pos++;
    }
  }

  private expect(c: number): void {
    this.ws();
    if (this.buf[this.pos] !== c) this.fail(`expected ${String.fromCharCode(c)}`);
    this.pos++;
  }

  /** The kind of the next value: "{", "[", '"', or "" for a number or a literal. */
  peek(): string {
    this.ws();
    const c = this.buf[this.pos];
    if (c === 0x7b) return "{";
    if (c === 0x5b) return "[";
    if (c === QUOTE) return '"';
    if (c === undefined) this.fail("unexpected end");
    return "";
  }

  /** The position of the closing quote of the string whose opening quote is at `start`. */
  private stringEnd(start: number): number {
    const b = this.buf;
    let i = start + 1;
    for (;;) {
      const q = b.indexOf(QUOTE, i);
      if (q < 0) this.fail("unterminated string");
      let slashes = 0;
      for (let j = q - 1; j > start && b[j] === BACKSLASH; j--) slashes++;
      if (slashes % 2 === 0) return q;
      i = q + 1;
    }
  }

  /** Reads a string value. */
  string(): string {
    if (this.peek() !== '"') this.fail("expected a string");
    const start = this.pos;
    const end = this.stringEnd(start);
    this.pos = end + 1;
    if (this.buf.subarray(start + 1, end).indexOf(BACKSLASH) < 0) return this.buf.toString("utf8", start + 1, end);
    const v: unknown = JSON.parse(this.buf.toString("utf8", start, end + 1));
    return v as string;
  }

  /** Reads a number, true, false or null; undefined for anything else (stepped over). */
  scalar(): number | boolean | null | undefined {
    const kind = this.peek();
    if (kind !== "") {
      this.skip();
      return undefined;
    }
    const b = this.buf;
    const start = this.pos;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (c === 0x2c || c === 0x7d || c === 0x5d || c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) break;
      this.pos++;
    }
    const v: unknown = JSON.parse(b.toString("latin1", start, this.pos));
    return v as number | boolean | null;
  }

  /** Steps over the next value, whatever it is, without decoding it. */
  skip(): void {
    const kind = this.peek();
    if (kind === '"') {
      this.pos = this.stringEnd(this.pos) + 1;
      return;
    }
    if (kind === "") {
      this.scalar();
      return;
    }
    const b = this.buf;
    let depth = 0;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (c === QUOTE) {
        this.pos = this.stringEnd(this.pos) + 1;
        continue;
      }
      if (c === 0x7b || c === 0x5b) depth++;
      else if (c === 0x7d || c === 0x5d) {
        depth--;
        if (depth === 0) {
          this.pos++;
          return;
        }
      }
      this.pos++;
    }
    this.fail("unterminated value");
  }

  /** Calls `onKey` for each key of the object; it must read or skip that key's value. */
  object(onKey: (key: string) => void): void {
    this.expect(0x7b);
    this.ws();
    if (this.buf[this.pos] === 0x7d) {
      this.pos++;
      return;
    }
    for (;;) {
      const key = this.string();
      this.expect(0x3a);
      this.ws();
      const before = this.pos;
      onKey(key);
      if (this.pos === before) this.skip();
      this.ws();
      const c = this.buf[this.pos];
      this.pos++;
      if (c === 0x7d) return;
      if (c !== 0x2c) this.fail("expected , or }");
    }
  }

  /** Calls `onItem` for each item of the array; it must read or skip the item. */
  array(onItem: () => void): void {
    this.expect(0x5b);
    this.ws();
    if (this.buf[this.pos] === 0x5d) {
      this.pos++;
      return;
    }
    for (;;) {
      this.ws();
      const before = this.pos;
      onItem();
      if (this.pos === before) this.skip();
      this.ws();
      const c = this.buf[this.pos];
      this.pos++;
      if (c === 0x5d) return;
      if (c !== 0x2c) this.fail("expected , or ]");
    }
  }
}
