// What a session hears about its automatic Advisor, and when: the whole text
// with the first message after Advisor is turned on, a one-line reminder with
// each later one, and one line saying it is off with the first message after
// it is turned off. A message that starts with "/" (a command, a skill)
// carries nothing, so it still runs as the command it is.
//
// The note never becomes the user's words. An AI whose adapter takes notes
// beside a message (ProviderCapabilities.sessionNotes; Claude: a
// UserPromptSubmit hook's additionalContext) gets it there. Any other AI
// (agy, whose ACP has no such field) reads it after the user's words, below
// a fixed separator; the journal keeps the user's words only, and reading
// the AI's own transcript back takes the note off again (userWords in
// attachments/message-attachments.ts).

export const AUTO_INSTRUCTIONS = [
  "Advisor is on for this session. Advisor weighs options and returns how likely each is right; it never writes or runs anything.",
  "advisor_weigh is a tool of the tunelo MCP server; its full name may carry a prefix (for example mcp__tunelo__advisor_weigh). If your tool",
  "list shows it by name only, load its definition first (tool search), then call it. Do not skip it because it is not loaded yet.",
  '- When you are unsure between approaches, call advisor_weigh(kind="decision") before acting. If the result is "confident" and the',
  "  chosen action is non-destructive and inside the user's request, follow it. Deleting, pushing, deploying, sending anything outside",
  "  this machine, or going beyond the request still needs the user: ask them, quoting Advisor's probabilities.",
  '  If the result is "unsure", stop and ask the user, quoting the options.',
  '- Before you end every turn, call advisor_weigh(kind="next_steps") with 2-5 short next steps the user could send you, in the user\'s',
  '  language, never starting with "/" or "!".',
  "- Send only a short abstract summary: never keys, passwords, tokens, private paths, personal data or code.",
].join("\n");

export const AUTO_REMINDER =
  'Advisor is on: call the tunelo MCP tool advisor_weigh (load its definition first if it is listed by name only): kind="decision" when unsure, and kind="next_steps" before you end this turn.';

export const ADVISOR_OFF = "Advisor is now off for this session: do not call advisor_weigh.";

/** Starts tunelo's note below the user's words; everything from it on is tunelo's. */
export const NOTE_SEPARATOR = "\n\n[tunelo] The lines below come from tunelo, not from the user:\n";

/**
 * Where a session that takes notes in its messages stands: "none" (nothing
 * said yet, or off and said so), "briefed" (the whole text went), "off-due"
 * (turned off after a brief: the next message says so).
 */
export type NoteState = "none" | "briefed" | "off-due";

/** Where a session stands once Advisor was turned on or off. */
export function noteStateAfterToggle(on: boolean, state: NoteState): NoteState {
  if (on) return state === "briefed" ? "briefed" : "none";
  return state === "briefed" ? "off-due" : "none";
}

/** tunelo's note for a message to the AI (none for a command), and where the session stands after it. */
export function advisorNote(text: string, on: boolean, state: NoteState): { note?: string; state: NoteState } {
  if (text.trimStart().startsWith("/")) return { state };
  if (on) return { note: state === "briefed" ? AUTO_REMINDER : AUTO_INSTRUCTIONS, state: "briefed" };
  if (state === "off-due") return { note: ADVISOR_OFF, state: "none" };
  return { state };
}

/** A message with tunelo's note below the user's words, for an AI that takes no note beside it. */
export function withNote(text: string, note: string | undefined): string {
  return note ? `${text}${NOTE_SEPARATOR}${note}` : text;
}

/** A message as the user wrote it: without tunelo's note. */
export function withoutAdvisorNote(text: string): string {
  const at = text.indexOf(NOTE_SEPARATOR);
  return at < 0 ? text : text.slice(0, at);
}
