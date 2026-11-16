// Which room of the office a tool call happens in, and how it is acted out.
// Runs on the machine: a shell command is read here only to pick a room;
// only the room's code ever leaves the machine (docs/office-wire.md, part 4).
import { OfficeAnimGroup, OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { isAdvisorWeigh } from "../advisor/advisor-names.ts";
import type { ToolKind } from "../providers/types.ts";
import { classifyCommand } from "./office-command-room.ts";

export { classifyCommand } from "./office-command-room.ts";

export type OfficePlace = { group: OfficeAnimGroup; room: OfficeRoom };

/** tunelo's own MCP in a session (it messages the user): the lobby, not the post room. */
const TUNELO_MCP_PREFIX = "mcp__tunelo__";

/** A subagent walking in. */
export const ARRIVE: OfficePlace = { group: OfficeAnimGroup.ARRIVE, room: OfficeRoom.LOBBY };
/** A subagent handing in its work. */
export const HAND_IN: OfficePlace = { group: OfficeAnimGroup.HAND_IN, room: OfficeRoom.DIRECTOR };
/** The director thinking or writing the answer. */
export const THINK: OfficePlace = { group: OfficeAnimGroup.THINK, room: OfficeRoom.DIRECTOR };
/** Asking Advisor (advisor_weigh, whatever the AI calls it): at Advisor's seat, the head of the meeting table. */
export const CONSULT: OfficePlace = { group: OfficeAnimGroup.CONSULT, room: OfficeRoom.MEETING };

/** Where and how a tool call is acted out, by its kind, name and (for a shell) command. */
export function classifyActivity(tool: { kind: ToolKind; name: string; command?: string }): OfficePlace {
  // Claude names it as an MCP tool, agy with single underscores (not an MCP name to the core): both ask Advisor.
  if (isAdvisorWeigh(tool.name)) return CONSULT;
  switch (tool.kind) {
    case "read":
    case "search":
      return { group: OfficeAnimGroup.READ, room: OfficeRoom.LIBRARY };
    case "web":
      return { group: OfficeAnimGroup.PHONE, room: OfficeRoom.LIBRARY };
    case "edit":
    case "other":
      return { group: OfficeAnimGroup.TYPE, room: OfficeRoom.WORK };
    case "todo":
      return { group: OfficeAnimGroup.TYPE, room: OfficeRoom.PLANNING };
    case "mcp":
      return { group: OfficeAnimGroup.TYPE, room: tool.name.startsWith(TUNELO_MCP_PREFIX) ? OfficeRoom.LOBBY : OfficeRoom.POST };
    case "shell":
      return { group: OfficeAnimGroup.MACHINE, room: classifyCommand(tool.command ?? "") };
    case "subagent":
      return ARRIVE;
  }
}
