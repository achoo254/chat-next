// The facts a conversation may name, and the topics they allow: only what
// the office already holds as normalized data (the kind and room of the
// opener's last work, how long it took, how many they finished, how long
// their last approval waited, the session's counts of tasks and checks, the
// part of the day). A command, a path or a file name never comes in: the work
// log keeps no activity subject. Pure.
import type { DialogueSlot, TalkTopic } from "./office-dialogue-vi.ts";
import { awakeAct, localHour, type LifeAct, type LifeSlot } from "./office-life-schedule.ts";
import type { AnimGroup } from "./office-state.ts";
import type { RoomCode } from "./office-rooms.ts";
import type { PersonWork, SessionView } from "./office-store.ts";

/** Work counts as "just done" this long after it ended (viewer ms). */
export const RECENT_WORK_MS = 45 * 60_000;
/** An approval wait worth a word: at least this long, decided within RECENT_APPROVAL_MS. */
export const LONG_WAIT_MS = 60_000;
export const RECENT_APPROVAL_MS = 2 * 3_600_000;

const DOING: Readonly<Record<AnimGroup, string>> = {
	read: "đọc tài liệu",
	type: "viết code",
	machine: "chạy máy",
	phone: "liên lạc với bên ngoài",
	arrive: "nhận việc",
	"hand-in": "nộp hồ sơ",
	think: "ngồi nghĩ cách làm",
	consult: "hỏi ý Cố vấn",
};

const WHERE: Readonly<Record<RoomCode, string>> = {
	LOBBY: "ở sảnh",
	DIRECTOR: "ở phòng Giám đốc",
	WORK: "ở phòng làm việc chung",
	SERVER: "ở phòng máy chủ",
	MEETING: "ở phòng họp",
	PANTRY: "ở pantry",
	PLANNING: "ở phòng Kế hoạch",
	LIBRARY: "ở thư viện",
	POST: "ở bưu phòng",
	SECURITY: "ở phòng Bảo vệ",
	AUDIT: "ở phòng Kiểm toán",
	QA: "ở phòng QA",
	DORM: "ở ký túc",
	GYM: "ở phòng gym",
	LOUNGE: "ở phòng giải trí",
};

/** A duration in plain Vietnamese: "chưa tới một phút", "3 phút", "1 tiếng 5 phút". */
export function durationVi(ms: number): string {
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return "chưa tới một phút";
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (h === 0) return `${m} phút`;
	return m === 0 ? `${h} tiếng` : `${h} tiếng ${m} phút`;
}

export interface TalkFactsInput {
	/** The opener's (visitor's) record. */
	readonly work: PersonWork;
	readonly session: SessionView;
	/** Viewer time minus machine time. */
	readonly clockOffset: number;
	readonly now: number;
	/** The part of the day by the plain clock (no personal shift). */
	readonly slot: LifeSlot;
	/** What each of the two does on the living floor, if anything. */
	readonly acts: readonly (LifeAct | null)[];
}

export interface TalkFacts {
	/** Slot values, except the name (filled per line: the one spoken to). */
	readonly values: Readonly<Partial<Record<DialogueSlot, string>>>;
	readonly topics: readonly TalkTopic[];
}

const GYM_ACTS: ReadonlySet<LifeAct> = new Set<LifeAct>(["run", "pushup", "jacks", "punch"]);

export function talkFacts(input: TalkFactsInput): TalkFacts {
	const { work, session, clockOffset, now, slot } = input;
	const values: Partial<Record<DialogueSlot, string>> = {};
	const topics: TalkTopic[] = [];
	const hour = localHour(now);
	values.gio = `${Math.floor(hour)} giờ`;
	if (session.tasksDone > 0) values.xong = String(session.tasksDone);
	const last = work.last;
	if (last !== null && now - (last.at + clockOffset) < RECENT_WORK_MS) {
		values.viec = DOING[last.group];
		values.phong = WHERE[last.room];
		values.lau = durationVi(last.ms);
		if (work.done > 0) values.lan = String(work.done);
		// Facts of their own work weigh double.
		topics.push("workDone", "workDone");
	}
	const approval = work.approval;
	if (approval !== null && approval.waitMs >= LONG_WAIT_MS && now - (approval.at + clockOffset) < RECENT_APPROVAL_MS) {
		values.cho = durationVi(approval.waitMs);
		topics.push("approvalWait", "approvalWait");
	}
	const checks = session.checks;
	if (checks.passed > 0 && checks.lastOk) {
		values.dat = String(checks.passed);
		topics.push("testsPass");
	}
	if (checks.failed > 0 && !checks.lastOk) {
		values.truot = String(checks.failed);
		topics.push("testsFail");
	}
	const acts = input.acts.filter((a): a is LifeAct => a !== null && awakeAct(a));
	if (slot === "breakfast" || slot === "lunch" || acts.includes("eat")) {
		values.bua = slot === "breakfast" ? "bữa sáng" : slot === "lunch" ? "bữa trưa" : "bữa tối";
		topics.push("meal");
	}
	if (acts.some((a) => GYM_ACTS.has(a))) topics.push("gym");
	if (acts.includes("watch") || acts.includes("dance")) topics.push("tv");
	if (slot === "evening") topics.push(hour >= 22.5 ? "goodNight" : "evening");
	if (slot === "dawn" || slot === "breakfast") topics.push("morning");
	topics.push("smallTalk");
	return { values, topics };
}
