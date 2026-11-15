// One record of a subagent's log (Claude Code's subagents/agent-<id>.jsonl),
// read field by field for the office view: its type and time, its tool
// blocks (ids, names, a result's ok, and a shell's command only, which stays
// on the machine) and the API call it reports. Nothing else of it is decoded.
import type { SessionUsageCall } from "../types.ts";
import { toolKind } from "./tool-map.ts";
import { JsonCursor } from "./usage-json.ts";

const NAME_MAX = 200;
/** Claude's own placeholder replies (no API call behind them), as usage-scan.ts. */
const SYNTHETIC_MODEL = "<synthetic>";

// eslint-disable-next-line no-control-regex
export const clean = (v: string): string => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, NAME_MAX);

export type Block = { type: string; id: string; name: string; command?: string; toolUseId: string; isError: boolean };
/** One record of a subagent's log: its tool blocks, and the API call it reports when it is a reply. */
export type Line = { type: string; at: number; blocks: Block[]; call?: SessionUsageCall };

/** Reads a tool_use's input for a shell's command only; every other field is stepped over. */
function pickInput(c: JsonCursor, block: Block): void {
  c.object((k) => {
    if (k === "command" && c.peek() === '"') block.command = c.string();
  });
}

function pickBlock(c: JsonCursor): Block | undefined {
  if (c.peek() !== "{") return undefined;
  const b: Block = { type: "", id: "", name: "", toolUseId: "", isError: false };
  c.object((k) => {
    if ((k === "type" || k === "id" || k === "name" || k === "tool_use_id") && c.peek() === '"') {
      const v = c.string();
      if (k === "tool_use_id") b.toolUseId = v;
      else b[k] = v;
    } else if (k === "is_error") b.isError = c.scalar() === true;
    else if (k === "input" && c.peek() === "{") pickInput(c, b);
  });
  // The command is kept for a shell only (read on the machine to pick a room, never sent).
  if (b.command !== undefined && (b.type !== "tool_use" || toolKind(b.name) !== "shell")) delete b.command;
  return b;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * The top-level type, time, content blocks (tool calls and results) and API
 * call of one record, in one pass; undefined when it is not one. The call's
 * key is the one usage-scan.ts gives the same reply (message id and request
 * id), so a reply read from two places counts once.
 */
export function parseAgentLine(line: Buffer): Line | undefined {
  const out: Line = { type: "", at: Number.NaN, blocks: [] };
  let sessionId = "";
  let requestId = "";
  const msg = { id: "", model: "", usage: undefined as { input: number; output: number } | undefined };
  try {
    const c = new JsonCursor(line);
    c.object((key) => {
      if ((key === "type" || key === "timestamp" || key === "sessionId" || key === "requestId") && c.peek() === '"') {
        const v = c.string();
        if (key === "type") out.type = v;
        else if (key === "timestamp") out.at = Date.parse(v);
        else if (key === "sessionId") sessionId = v;
        else requestId = v;
      } else if (key === "message" && c.peek() === "{") {
        c.object((k) => {
          if ((k === "id" || k === "model") && c.peek() === '"') msg[k] = c.string();
          else if (k === "usage" && c.peek() === "{") {
            const usage = { input: 0, output: 0 };
            c.object((u) => {
              if (u === "input_tokens") usage.input = count(c.scalar());
              else if (u === "output_tokens") usage.output = count(c.scalar());
            });
            msg.usage = usage;
          } else if (k === "content" && c.peek() === "[") {
            c.array(() => {
              const b = pickBlock(c);
              if (b) out.blocks.push(b);
            });
          }
        });
      }
    });
  } catch {
    return undefined;
  }
  if (out.type !== "assistant" && out.type !== "user") return undefined;
  const id = clean(msg.id);
  if (out.type === "assistant" && msg.usage && id && msg.model !== SYNTHETIC_MODEL && Number.isFinite(out.at) && sessionId) {
    const req = clean(requestId);
    const key = req ? `${id}|${req}` : id;
    out.call = { key, at: out.at, inputTokens: msg.usage.input, outputTokens: msg.usage.output };
  }
  return out;
}
