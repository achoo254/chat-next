// The sizes of content Observatory keeps (content-excerpt.ts redacts and
// cuts it), and the bounded walks over a value: only the first
// REDACT_WINDOW_CHARS of a value are looked at at all, and a structured value
// (a tool's input or output) is rendered only that far, so a tool result of
// several megabytes costs the same as a short one.

/** How much of a content value is redacted, and kept by the hook process for the agent's second pass; the rest is never read. */
export const REDACT_WINDOW_CHARS = 8 * 1024;
/** How much of it is stored, after both passes. */
export const EXCERPT_MAX_CHARS = 2 * 1024;
/**
 * When a value was cut at the window, this much of its redacted end is left
 * out too: a secret cut by the window is not recognised, and a long secret
 * hidden earlier (shrunk to `[hidden]`) can pull the cut one into the excerpt.
 */
export const WINDOW_TAIL_GUARD_CHARS = 512;
/** Nesting a rendering follows; deeper values show as `…`. */
const MAX_DEPTH = 12;

/** The first `max` UTF-16 units of `text`, never ending inside a surrogate pair. */
export function cutChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

/**
 * `value` as JSON, but at most about `maxChars` of it: strings are cut before
 * they are encoded and the walk stops once the budget is spent, so the work
 * is bounded by `maxChars`, not by the value's size. A string is returned as
 * it is (cut). Only for excerpts: the result may not parse.
 */
export function boundedJson(value: unknown, maxChars: number = REDACT_WINDOW_CHARS): string {
  if (typeof value === "string") return cutChars(value, maxChars);
  const out: string[] = [];
  let budget = maxChars;
  const emit = (s: string): void => {
    out.push(s.length > budget ? cutChars(s, budget) : s);
    budget -= s.length;
  };
  const walk = (node: unknown, depth: number): void => {
    if (budget <= 0) return;
    if (typeof node === "string") return emit(JSON.stringify(cutChars(node, budget)));
    if (typeof node === "number" || typeof node === "boolean" || node === null) return emit(String(node));
    if (typeof node !== "object") return;
    if (depth >= MAX_DEPTH) return emit("…");
    if (Array.isArray(node)) {
      emit("[");
      for (let i = 0; i < node.length && budget > 0; i++) {
        if (i > 0) emit(",");
        walk(node[i], depth + 1);
      }
      return emit("]");
    }
    emit("{");
    let first = true;
    for (const key in node) {
      if (budget <= 0) return;
      if (!Object.hasOwn(node, key)) continue;
      if (!first) emit(",");
      first = false;
      emit(`${JSON.stringify(cutChars(key, 200))}:`);
      walk((node as Record<string, unknown>)[key], depth + 1);
    }
    emit("}");
  };
  walk(value, 0);
  return out.join("");
}

/** Values an approxJsonBytes walk visits at most; past them the count is a lower bound. */
export const MAX_SIZED_NODES = 20_000;

/**
 * About how many bytes `value` takes as JSON (string escapes not counted),
 * stopping as soon as the count passes `stopAbove`, or after
 * MAX_SIZED_NODES values (a huge array): then it is a lower bound. Strings
 * are measured natively, so a value of megabytes costs about a millisecond.
 */
export function approxJsonBytes(value: unknown, stopAbove: number = Number.POSITIVE_INFINITY): number {
  let total = 0;
  let nodes = 0;
  const walk = (node: unknown, depth: number): void => {
    if (total > stopAbove || ++nodes > MAX_SIZED_NODES) return;
    if (typeof node === "string") total += Buffer.byteLength(node, "utf8") + 2;
    else if (typeof node === "number" || typeof node === "boolean" || node === null) total += String(node).length;
    else if (Array.isArray(node) && depth < MAX_DEPTH * 2) {
      total += 2;
      for (let i = 0; i < node.length && total <= stopAbove && nodes <= MAX_SIZED_NODES; i++) {
        walk(node[i], depth + 1);
        total += 1;
      }
    } else if (typeof node === "object" && depth < MAX_DEPTH * 2) {
      total += 2;
      for (const key in node) {
        if (total > stopAbove || nodes > MAX_SIZED_NODES) return;
        if (!Object.hasOwn(node, key)) continue;
        total += Buffer.byteLength(key, "utf8") + 3;
        walk((node as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  walk(value, 0);
  return total;
}
