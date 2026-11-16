// What a session hears about its automatic Advisor: the whole text once, a
// reminder after, one "off" line after it is turned off, nothing with a
// command; and the user's words read back without tunelo's note.
import { describe, expect, it } from "vitest";
import {
  ADVISOR_OFF,
  AUTO_INSTRUCTIONS,
  AUTO_REMINDER,
  NOTE_SEPARATOR,
  advisorNote,
  noteStateAfterToggle,
  withNote,
  withoutAdvisorNote,
} from "../src/advisor/advisor-instructions.ts";
import { textForAi, userWords } from "../src/attachments/message-attachments.ts";

describe("advisorNote", () => {
  it("the whole text first, then a reminder", () => {
    const first = advisorNote("fix the bug", true, "none");
    expect(first).toEqual({ note: AUTO_INSTRUCTIONS, state: "briefed" });
    expect(advisorNote("and the test", true, first.state)).toEqual({ note: AUTO_REMINDER, state: "briefed" });
  });

  it("a command or a skill carries nothing and changes nothing", () => {
    expect(advisorNote("/compact", true, "none")).toEqual({ state: "none" });
    expect(advisorNote("  /review src", true, "briefed")).toEqual({ state: "briefed" });
    expect(advisorNote("/compact", false, "off-due")).toEqual({ state: "off-due" });
  });

  it("turned off after a brief: one line says so, then nothing", () => {
    const off = noteStateAfterToggle(false, "briefed");
    expect(off).toBe("off-due");
    const said = advisorNote("next", false, off);
    expect(said).toEqual({ note: ADVISOR_OFF, state: "none" });
    expect(advisorNote("more", false, said.state)).toEqual({ state: "none" });
  });

  it("never briefed: turning off says nothing; on again briefs in full", () => {
    expect(noteStateAfterToggle(false, "none")).toBe("none");
    expect(noteStateAfterToggle(true, "off-due")).toBe("none");
    expect(noteStateAfterToggle(true, "briefed")).toBe("briefed");
  });
});

describe("the note below a message", () => {
  it("is taken off again: the user's words come back exactly", () => {
    const sent = withNote("fix the bug", AUTO_INSTRUCTIONS);
    expect(sent).toContain(NOTE_SEPARATOR);
    expect(withoutAdvisorNote(sent)).toBe("fix the bug");
    expect(withNote("x", undefined)).toBe("x");
  });

  it("userWords drops the note and the list of attached files", () => {
    const files = [{ path: ".tunelo-attachments/a.log", size: 10 }];
    expect(userWords(withNote(textForAi("look at this", files), AUTO_REMINDER))).toBe("look at this");
    expect(userWords(textForAi("look at this", files))).toBe("look at this");
    expect(userWords(textForAi("", files))).toBe("");
    expect(userWords("plain words\n\nwith a blank line")).toBe("plain words\n\nwith a blank line");
  });
});
