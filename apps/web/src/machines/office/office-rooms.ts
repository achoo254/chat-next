// The building's twelve rooms by name (the layout file, the copy and the
// placement speak these); the layout file says which floor each is on. The wire carries the
// OfficeRoom enum; an unknown or unset room reads as WORK (docs/office-wire.md).
import { OfficeRoom } from "@achoo254/chat-proto/remote/remote";

export const ROOM_CODES = ["LOBBY", "DIRECTOR", "WORK", "SERVER", "MEETING", "PANTRY", "PLANNING", "LIBRARY", "POST", "SECURITY", "AUDIT", "QA"] as const;

export type RoomCode = (typeof ROOM_CODES)[number];

export type FloorLevel = 1 | 2 | 3;

export const FLOOR_LEVELS: readonly FloorLevel[] = [1, 2, 3];

const BY_ENUM: Readonly<Partial<Record<OfficeRoom, RoomCode>>> = {
	[OfficeRoom.LOBBY]: "LOBBY",
	[OfficeRoom.DIRECTOR]: "DIRECTOR",
	[OfficeRoom.WORK]: "WORK",
	[OfficeRoom.SERVER]: "SERVER",
	[OfficeRoom.MEETING]: "MEETING",
	[OfficeRoom.PANTRY]: "PANTRY",
	[OfficeRoom.PLANNING]: "PLANNING",
	[OfficeRoom.LIBRARY]: "LIBRARY",
	[OfficeRoom.POST]: "POST",
	[OfficeRoom.SECURITY]: "SECURITY",
	[OfficeRoom.AUDIT]: "AUDIT",
	[OfficeRoom.QA]: "QA",
};

/** The room of a wire value; WORK for UNSPECIFIED or a room a newer agent added. */
export function roomOf(room: OfficeRoom): RoomCode {
	return BY_ENUM[room] ?? "WORK";
}

export function isRoomCode(value: unknown): value is RoomCode {
	return typeof value === "string" && (ROOM_CODES as readonly string[]).includes(value);
}
