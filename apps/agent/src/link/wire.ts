// What goes on the wire: large tool output, inputs and diffs are shortened;
// `thread.fetchFull` returns the stored item.
import { clone } from "@bufbuild/protobuf";
import { type Item, ItemSchema } from "@achoo254/chat-proto/remote/remote";

export const MAX_OUTPUT = 4000;
export const MAX_INPUT = 2000;
export const MAX_DIFF_LINES = 120;

function cut(s: string, n: number): [string, boolean] {
  return s.length > n ? [s.slice(0, n), true] : [s, false];
}

export function wireItem(item: Item): Item {
  const b = item.body;
  if (b.case === "toolResult" && b.value.output.length > MAX_OUTPUT) {
    const out = clone(ItemSchema, item);
    if (out.body.case === "toolResult") [out.body.value.output, out.body.value.truncated] = cut(b.value.output, MAX_OUTPUT);
    return out;
  }
  if ((b.case === "toolCall" || b.case === "approval") && b.value.input.length > MAX_INPUT) {
    const out = clone(ItemSchema, item);
    if (out.body.case === "toolCall" || out.body.case === "approval") out.body.value.input = cut(b.value.input, MAX_INPUT)[0];
    return out;
  }
  if (b.case === "diff") {
    const lines = b.value.unified.split("\n");
    if (lines.length > MAX_DIFF_LINES) {
      const out = clone(ItemSchema, item);
      if (out.body.case === "diff") {
        out.body.value.unified = lines.slice(0, MAX_DIFF_LINES).join("\n");
        out.body.value.truncated = true;
      }
      return out;
    }
  }
  return item;
}
