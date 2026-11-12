// The selective JSON reader agrees with JSON.parse on what it reads, steps
// over everything else whatever it holds, and fails on broken input.
import { describe, expect, it } from "vitest";
import { JsonCursor } from "../../src/providers/claude/usage-json.ts";

/** Reads every value of `text` through the cursor into plain values, as JSON.parse would. */
function readAll(c: JsonCursor): unknown {
  const kind = c.peek();
  if (kind === '"') return c.string();
  if (kind === "") return c.scalar();
  if (kind === "[") {
    const out: unknown[] = [];
    c.array(() => out.push(readAll(c)));
    return out;
  }
  const out: Record<string, unknown> = {};
  c.object((key) => (out[key] = readAll(c)));
  return out;
}

const SAMPLES = [
  '{"a":"plain","b":"quote \\" inside","c":"slash at end \\\\","d":"\\\\\\"mixed\\\\","e":"\\u00e9t\\u00e9 \\n tab\\t","f":"tiếng Việt 中文 🚀"}',
  '{"n":[0,-1,2.5,1e3,-0.25E-2],"t":true,"f":false,"z":null,"empty":{},"none":[]}',
  ' { "nested" : { "deep" : [ { "x" : [ [ "]" , "}" , "{" , "[" ] ] } ] } , "after" : 1 } ',
  '{"message":{"content":[{"type":"text","text":"{\\"type\\":\\"assistant\\"}"},{"type":"tool_use","name":"Bash","input":{"command":"echo \\"}\\""}}]},"type":"assistant"}',
];

describe("reading only what is asked for", () => {
  it.each(SAMPLES)("reads the same values as JSON.parse: %s", (text) => {
    expect(readAll(new JsonCursor(Buffer.from(text)))).toEqual(JSON.parse(text));
  });

  it.each(SAMPLES)("steps over every value and lands on the next key: %s", (text) => {
    const keys: string[] = [];
    new JsonCursor(Buffer.from(text)).object((k) => keys.push(k));
    expect(keys).toEqual(Object.keys(JSON.parse(text) as object));
  });

  it("finds a key placed after a value full of look-alike text", () => {
    const text = SAMPLES[3] as string;
    let type: string | undefined;
    const c = new JsonCursor(Buffer.from(text));
    c.object((k) => {
      if (k === "type") type = c.string();
    });
    expect(type).toBe("assistant");
  });

  it.each(['{"a":"open', '{"a":1', '{"a" 1}', '{"a":[1,2}', '{"a":1,}x', ""])("fails on broken input: %s", (text) => {
    expect(() => readAll(new JsonCursor(Buffer.from(text)))).toThrow();
  });
});
