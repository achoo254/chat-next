// Small edits to the text of a JSON document that leave every other byte as
// it was: Claude Code's settings.json belongs to the user, so adding
// Observatory's entries must not reformat it, and taking them out again must
// give back the text from before (settings-json-observatory.ts). The text is
// read into spans (where each value, member and element starts and ends);
// an edit adds one member or element after the last one, in the document's
// own indentation and line ending, or removes one together with the separator
// that came with it. Strict JSON only: anything JSON.parse refuses is refused.

export type JsonNode =
  | { kind: "object"; start: number; end: number; members: JsonMember[] }
  | { kind: "array"; start: number; end: number; elements: JsonNode[] }
  | { kind: "scalar"; start: number; end: number };

export type JsonMember = { key: string; start: number; value: JsonNode };

/** The text could not be read as JSON. */
export class JsonTextError extends Error {
  override readonly name = "JsonTextError";
}

const WS = new Set([" ", "\t", "\n", "\r"]);

class SpanReader {
  i = 0;
  constructor(private readonly text: string) {}

  skip(): void {
    while (this.i < this.text.length && WS.has(this.text.charAt(this.i))) this.i++;
  }

  value(): JsonNode {
    this.skip();
    const c = this.text.charAt(this.i);
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    const start = this.i;
    if (c === '"') this.string();
    else while (this.i < this.text.length && !/[\s,\]}]/.test(this.text.charAt(this.i))) this.i++;
    if (this.i === start) throw new JsonTextError(`unexpected character at ${start}`);
    return { kind: "scalar", start, end: this.i };
  }

  /** Moves past a string; returns its value. */
  string(): string {
    const start = this.i;
    this.i++;
    while (this.i < this.text.length && this.text.charAt(this.i) !== '"') this.i += this.text.charAt(this.i) === "\\" ? 2 : 1;
    this.i++;
    const raw = this.text.slice(start, this.i);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "string") throw new JsonTextError(`not a string at ${start}`);
    return parsed;
  }

  private object(): JsonNode {
    const start = this.i++;
    const members: JsonMember[] = [];
    this.skip();
    if (this.text.charAt(this.i) === "}") return { kind: "object", start, end: ++this.i, members };
    for (;;) {
      this.skip();
      const memberStart = this.i;
      const key = this.string();
      this.skip();
      this.i++; // ":"
      members.push({ key, start: memberStart, value: this.value() });
      this.skip();
      const c = this.text.charAt(this.i++);
      if (c === "}") return { kind: "object", start, end: this.i, members };
      if (c !== ",") throw new JsonTextError(`expected , or } at ${this.i - 1}`);
    }
  }

  private array(): JsonNode {
    const start = this.i++;
    const elements: JsonNode[] = [];
    this.skip();
    if (this.text.charAt(this.i) === "]") return { kind: "array", start, end: ++this.i, elements };
    for (;;) {
      elements.push(this.value());
      this.skip();
      const c = this.text.charAt(this.i++);
      if (c === "]") return { kind: "array", start, end: this.i, elements };
      if (c !== ",") throw new JsonTextError(`expected , or ] at ${this.i - 1}`);
    }
  }
}

/** The spans of `text`'s root value; throws JsonTextError for text that is not JSON. */
export function readJsonSpans(text: string): JsonNode {
  try {
    JSON.parse(text);
  } catch (err) {
    throw new JsonTextError(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return new SpanReader(text).value();
}

/** The member `key` of an object node. */
export function memberOf(node: JsonNode | undefined, key: string): JsonMember | undefined {
  return node?.kind === "object" ? node.members.find((m) => m.key === key) : undefined;
}

/** How the document is laid out: its line ending and one level of indentation. */
export type JsonLayout = { eol: string; unit: string };

export function layoutOf(text: string): JsonLayout {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // The shallowest indented key is one level (a root member); deeper ones are several.
  let unit: string | undefined;
  for (const m of text.matchAll(/\n([ \t]+)"/g)) {
    const indent = m[1] ?? "";
    if (unit === undefined || indent.length < unit.length) unit = indent;
  }
  return { eol, unit: unit ?? "  " };
}

/** `value` as JSON text for a place at `depth` levels of indentation (its own lines indented from there). */
export function jsonAt(value: unknown, depth: number, layout: JsonLayout): string {
  const pad = layout.unit.repeat(depth);
  return JSON.stringify(value, null, layout.unit).split("\n").join(`${layout.eol}${pad}`);
}

type Edit = { from: number; to: number; insert: string };

function apply(text: string, e: Edit): string {
  return text.slice(0, e.from) + e.insert + text.slice(e.to);
}

/** The items of a container, their spans, and its depth (of its items). */
type Container = { start: number; end: number; items: { start: number; end: number }[] };

function containerOf(node: JsonNode): Container {
  if (node.kind === "object") return { start: node.start, end: node.end, items: node.members.map((m) => ({ start: m.start, end: m.value.end })) };
  if (node.kind === "array") return { start: node.start, end: node.end, items: node.elements.map((e) => ({ start: e.start, end: e.end })) };
  throw new JsonTextError("not an object or array");
}

/** Adds `item` (already JSON text) after the last item of `node`, whose items sit at `depth`. */
function appendItem(text: string, node: JsonNode, item: string, depth: number, layout: JsonLayout): string {
  const c = containerOf(node);
  const pad = layout.unit.repeat(depth);
  const last = c.items.at(-1);
  if (last) return apply(text, { from: last.end, to: last.end, insert: `,${layout.eol}${pad}${item}` });
  // Into an empty container: right after its opening bracket, keeping what stood inside it (`{ }` stays `{ }` once removed).
  return apply(text, { from: c.start + 1, to: c.start + 1, insert: `${layout.eol}${pad}${item}${closingLine(depth, layout)}` });
}

/** What follows the only item of a container at `depth`: the line its closing bracket starts. */
function closingLine(depth: number, layout: JsonLayout): string {
  return `${layout.eol}${layout.unit.repeat(Math.max(0, depth - 1))}`;
}

/** Adds member `key` with `value` at the end of object `node` (its members at `depth`). */
export function appendMember(text: string, node: JsonNode, key: string, value: unknown, depth: number, layout: JsonLayout): string {
  if (node.kind !== "object") throw new JsonTextError(`cannot add "${key}" to a value that is not an object`);
  return appendItem(text, node, `${JSON.stringify(key)}: ${jsonAt(value, depth, layout)}`, depth, layout);
}

/** Adds `value` at the end of array `node` (its elements at `depth`). */
export function appendElement(text: string, node: JsonNode, value: unknown, depth: number, layout: JsonLayout): string {
  if (node.kind !== "array") throw new JsonTextError("cannot add an element to a value that is not an array");
  return appendItem(text, node, jsonAt(value, depth, layout), depth, layout);
}

/**
 * Removes the item at `index` of `node` (its items at `depth`) with the
 * separator that came with it: the one before it, or for the first item the
 * one after it. The only item goes with the line breaks appendItem put around
 * it, so the container's inside is as it was before (`{}`, `{ }`, `[]`).
 */
export function removeItem(text: string, node: JsonNode, index: number, depth: number, layout: JsonLayout): string {
  const c = containerOf(node);
  const item = c.items[index];
  if (!item) throw new JsonTextError(`no item ${index}`);
  const before = c.items[index - 1];
  const after = c.items[index + 1];
  if (before) return apply(text, { from: before.end, to: item.end, insert: "" });
  if (after) return apply(text, { from: item.start, to: after.start, insert: "" });
  const lead = `${layout.eol}${layout.unit.repeat(depth)}`;
  const tail = closingLine(depth, layout);
  const from = text.slice(c.start + 1, item.start) === lead ? c.start + 1 : item.start;
  const to = text.startsWith(tail, item.end) ? item.end + tail.length : item.end;
  return apply(text, { from, to, insert: "" });
}

/** Replaces a value's text with `value` (at `depth`). */
export function replaceValue(text: string, node: JsonNode, value: unknown, depth: number, layout: JsonLayout): string {
  return apply(text, { from: node.start, to: node.end, insert: jsonAt(value, depth, layout) });
}

/** The JSON value of a node. */
export function valueOf(text: string, node: JsonNode): unknown {
  return JSON.parse(text.slice(node.start, node.end));
}
