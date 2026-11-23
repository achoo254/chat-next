// The class of a tool call: its Live Map station with the station's flags
// (live-map/station-map.ts), and the MCP server of an `mcp__<server>__<tool>`
// call. The privacy filter works the station out from the raw call and hands
// it on in the record (`station`, `station_flags`); a record without it (a
// spool line an older hook wrote, OpenTelemetry) is placed by the filtered
// target, flagged `estimated`.
import { type Station, type StationPlace, stationOfTarget } from "../live-map/station-map.ts";
import { toolKind } from "../../providers/claude/tool-map.ts";

export type ToolClass = {
  station: Station;
  /** StationFlag bits. */
  stationFlags: number;
  mcpServer?: string;
};

const MCP = /^mcp__(.+?)__.+$/;

const STATIONS: ReadonlySet<string> = new Set<Station>(["CORE", "FILES", "MEMORY", "TESTING", "GIT", "SANDBOX", "MCP", "EXTERNAL", "SKILLS", "ORCHESTRATOR"]);

const isStation = (v: string | undefined): v is Station => v !== undefined && STATIONS.has(v);

/**
 * The class of a call of `toolName`: the filter's station and flags when the
 * record has them (an unknown station name becomes CORE), else the one its
 * filtered `target` suggests.
 */
export function classifyTool(toolName: string, target: string | undefined, filtered?: { station: string | undefined; flags: number | undefined }): ToolClass {
  let place: StationPlace;
  if (filtered?.station !== undefined) place = { station: isStation(filtered.station) ? filtered.station : "CORE", flags: filtered.flags ?? 0 };
  else place = stationOfTarget(toolName, target);
  const server = MCP.exec(toolName)?.[1];
  return { station: place.station, stationFlags: place.flags, ...(server ? { mcpServer: server } : {}) };
}

/** A shell call: placed by its command, so a source without the target (OpenTelemetry) leaves the class to the hooks. */
export function isShellTool(toolName: string): boolean {
  return toolKind(toolName) === "shell";
}
