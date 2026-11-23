// The hook process redacts by pattern and keeps the redacted window (about
// 8 KB) for the agent, which hides the machine's own secret values (the hook
// never knows them) and only then cuts to 2 KB. A machine secret placed
// across the 2 KB mark or across the 8 KB window, at many positions and
// lengths, never reaches the stored text, not even a piece of it.
import { describe, expect, it } from "vitest";
import { excerpt, finalExcerpt, windowExcerpt } from "../../src/observatory/privacy/content-excerpt.ts";
import { filterHookEvent } from "../../src/observatory/privacy/filter-hook-event.ts";
import { redactRecordAgain } from "../../src/observatory/privacy/redact-record-again.ts";
import { EXCERPT_MAX_CHARS, REDACT_WINDOW_CHARS } from "../../src/observatory/privacy/privacy-text.ts";
import { FAKE_HOME, isFakeSensitive } from "./observatory-payloads.ts";

/** A fake machine secret of `length` characters (like the 64-hex OTLP token or a machine secret). */
const secretOf = (length: number): string => "f0e1d2c3b4a59687".repeat(8).slice(0, length);
/** No piece of `secret` (8 characters or more) is in `text`. */
function holdsPiece(text: string, secret: string): boolean {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
}

function storedThroughSpool(stdout: string, secret: string): string {
  const hook = filterHookEvent(
    "PostToolUse",
    { session_id: "s", cwd: "D:\\w", tool_name: "Bash", tool_input: { command: "node show.js" }, tool_response: stdout },
    { home: FAKE_HOME, isSensitive: isFakeSensitive, contentAllowed: true },
    1,
  );
  if (!hook) throw new Error("dropped");
  // What the spool holds: never more than the window, and the secret not yet hidden (the hook does not know it).
  expect((hook.c?.tool_response ?? "").length).toBeLessThanOrEqual(REDACT_WINDOW_CHARS + 1);
  const stored = redactRecordAgain(JSON.parse(JSON.stringify(hook)), [secret]);
  return stored.src === "hook" ? (stored.c?.tool_response ?? "") : "";
}

describe("the two passes", () => {
  it("never store a piece of a machine secret across the 2 KB mark", () => {
    for (const length of [16, 32, 64, 100]) {
      const secret = secretOf(length);
      for (let shift = -length - 5; shift <= 5; shift++) {
        const at = EXCERPT_MAX_CHARS + shift;
        const stored = storedThroughSpool(`${"x".repeat(at)}${secret} tail ${"y".repeat(3_000)}`, secret);
        expect(stored.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1);
        expect(holdsPiece(stored, secret), `length ${length} at ${at}`).toBe(false);
      }
    }
  });

  it("never store a piece of a machine secret across the 8 KB window, even after earlier secrets shrank", () => {
    for (const length of [16, 64, 100]) {
      const secret = secretOf(length);
      for (const shift of [-length - 2, -length / 2, -3, 0, 3]) {
        const at = REDACT_WINDOW_CHARS + Math.round(shift);
        // Many earlier copies are hidden by the agent (each shrinks to "[hidden]"), pulling the window's end toward 2 KB.
        const copies = `${secret} `.repeat(Math.floor((at - 200) / (length + 1)));
        const text = `${copies}${"x".repeat(Math.max(0, at - copies.length))}${secret} ${"z".repeat(500)}`;
        const stored = storedThroughSpool(text, secret);
        expect(holdsPiece(stored, secret), `length ${length} at ${at}`).toBe(false);
      }
    }
  });

  it("keep a value that ends with … of its own whole: only the hook's flag says a value was cut", () => {
    for (const prompt of ["Để mình nghĩ thêm…", `${"x".repeat(600)} rồi sao…`, "chờ chút…"]) {
      const hook = filterHookEvent("UserPromptSubmit", { session_id: "s", cwd: "D:\\w", prompt }, { home: FAKE_HOME, isSensitive: isFakeSensitive, contentAllowed: true }, 1);
      expect(hook?.truncated).toBeUndefined();
      const stored = hook ? redactRecordAgain(hook, []) : undefined;
      expect(stored?.src === "hook" ? stored.c?.prompt : "").toBe(prompt);
    }
    expect(excerpt("chờ chút…")).toBe("chờ chút…");
  });

  it("cut a value the hook truncated to exactly 2 KB after the second pass, and drop the flag", () => {
    const long = "abcdefghij".repeat(2_000);
    const hook = filterHookEvent("UserPromptSubmit", { session_id: "s", cwd: "D:\\w", prompt: long }, { home: FAKE_HOME, isSensitive: isFakeSensitive, contentAllowed: true }, 1);
    expect(hook?.truncated).toEqual({ prompt: true });
    expect(hook?.c?.prompt?.endsWith("…")).toBe(false);
    const stored = hook ? redactRecordAgain(JSON.parse(JSON.stringify(hook)), []) : undefined;
    const kept = stored?.src === "hook" ? (stored.c?.prompt ?? "") : "";
    expect(kept).toBe(`${long.slice(0, EXCERPT_MAX_CHARS)}…`);
    expect(stored && "truncated" in stored).toBe(false);
  });

  it("keep short content whole, and mark cut content", () => {
    expect(finalExcerpt(windowExcerpt("short and plain"))).toBe("short and plain");
    const cut = finalExcerpt(windowExcerpt("a".repeat(REDACT_WINDOW_CHARS * 2)));
    expect(cut.length).toBe(EXCERPT_MAX_CHARS + 1);
    expect(cut.endsWith("…")).toBe(true);
  });
});
