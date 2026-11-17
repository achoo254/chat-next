// The office's rooms by name (the layout file, the copy and the placement
// speak these); the layout file says which zone each is in. The twelve work
// rooms are the wire's: the OfficeRoom enum carries them and an unknown or
// unset room reads as WORK (docs/office-wire.md). The living rooms (dorm, gym,
// lounge) are the web's own: no tool ever sends anyone there, only the daily
// schedule of off-duty residents (office-life-schedule.ts) does, so they stay
// out of the wire's mapping.
import { OfficeRoom } from "@achoo254/chat-proto/remote/remote";

export const WORK_ROOM_CODES = ["LOBBY", "DIRECTOR", "WORK", "SERVER", "MEETING", "PANTRY", "PLANNING", "LIBRARY", "POST", "SECURITY", "AUDIT", "QA"] as const;

export const LIVING_ROOM_CODES = ["DORM", "GYM", "LOUNGE"] as const;

/** Every room of the office: the work rooms, then the living ones. */
export const ROOM_CODES = [...WORK_ROOM_CODES, ...LIVING_ROOM_CODES] as const;

export type WorkRoomCode = (typeof WORK_ROOM_CODES)[number];
export type LivingRoomCode = (typeof LIVING_ROOM_CODES)[number];
export type RoomCode = WorkRoomCode | LivingRoomCode;

const BY_ENUM: Readonly<Partial<Record<OfficeRoom, WorkRoomCode>>> = {
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
export function roomOf(room: OfficeRoom): WorkRoomCode {
	return BY_ENUM[room] ?? "WORK";
}

export function isRoomCode(value: unknown): value is RoomCode {
	return typeof value === "string" && (ROOM_CODES as readonly string[]).includes(value);
}

export function isLivingRoom(room: RoomCode): room is LivingRoomCode {
	return (LIVING_ROOM_CODES as readonly string[]).includes(room);
}
