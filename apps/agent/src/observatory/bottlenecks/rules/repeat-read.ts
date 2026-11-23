// `repeat_read` (FILES, by the file's salted key): the same page of one file
// read `warnReads` times (alert at `alertReads`) with no write of the file
// in between. A Read of another page (its `read_offset` / `read_limit`) is a
// different read, not a repeat; Grep and Glob are not reads of a file; a call
// without a key (no salt, a secret file) is not judged. Two files with the
// same name in two folders have two keys. A shell command run between two
// reads may have changed the file (a script writing its output, then read):
// it starts every count again, as a write does. Closes when the file is
// written (the count starts again) or the session ends.
import { isShellTool } from "../../ingest/tool-classification.ts";
import { isWriteCall } from "../session-model.ts";
import type { Rule, Verdict } from "./rule-types.ts";
import { newest, toolEventId } from "./rule-support.ts";

const READ_TOOLS = new Set(["Read", "NotebookRead"]);

export const repeatRead: Rule = {
  name: "repeat_read",
  evaluate(ctx) {
    // Per file: the reads of each page since the file's last write, in time order.
    const pages = new Map<string, Map<string, string[]>>();
    for (const call of ctx.session.toolCalls) {
      if (call.toolName !== null && isShellTool(call.toolName)) {
        pages.clear();
        continue;
      }
      const key = call.targetKey;
      if (key === null || call.success === false) continue;
      if (isWriteCall(call)) {
        pages.delete(key);
        continue;
      }
      if (!READ_TOOLS.has(call.toolName ?? "")) continue;
      const byPage = pages.get(key) ?? new Map<string, string[]>();
      const page = `${call.readOffset ?? ""}:${call.readLimit ?? ""}`;
      byPage.set(page, [...(byPage.get(page) ?? []), toolEventId(call.toolUseId)]);
      pages.set(key, byPage);
    }
    const out: Verdict[] = [];
    for (const [key, byPage] of pages) {
      const ids = [...byPage.values()].reduce((most, list) => (list.length > most.length ? list : most), []);
      const t = ctx.thresholds.of("repeat_read", key);
      const severity = ids.length >= t.alertReads ? "alert" : ids.length >= t.warnReads ? "warn" : undefined;
      if (!severity) continue;
      out.push({ subkey: key, station: "FILES", severity, value: ids.length, threshold: t.warnReads, n: ids.length, measures: { reads: ids.length }, evidence: newest(ids) });
    }
    return out;
  },
};
