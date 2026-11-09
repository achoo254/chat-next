// One line of a message for a chat-style list of sessions (ThreadSummary.preview):
// markdown dropped, whitespace folded, at most PREVIEW_MAX characters.

export const PREVIEW_MAX = 140;

/** The text as one plain line, cut with "…" past `max` characters (code points, so emoji stay whole). */
export function previewLine(text: string, max = PREVIEW_MAX): string {
  const plain = text
    // fenced code: keep what is inside, drop the fences and their language
    .replace(/```[^\n]*\n?/g, " ")
    // images and links: their words only
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // headings, quotes, list markers and rules at the start of a line
    .replace(/^[ \t]*(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "")
    .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, " ")
    // emphasis, inline code, strike-through
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...plain];
  return chars.length <= max ? plain : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
