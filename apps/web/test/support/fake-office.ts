// The office side of the demo machine (visual harness, browser tests): the
// OfficeWatch exchange of docs/office-wire.md over a scripted session. The
// script plays in steps, every STEP_MS while someone watches, and loops: a
// turn begins, the director reads, runs git and edits, staff of many agent
// types come in (more than the desks hold, so the meeting room shows "+N"), a
// nested subagent works from the meeting room, a background shell runs in the
// server room, tests fail then pass, an approval waits (the chairman in the
// lobby) and is denied, a tool runs over two minutes, a subagent hands in its
// work, and the session goes idle. Every room of the building sees someone;
// the pantry only through this script (a real agent never sends PANTRY: idle
// play picks it on the device). The session "demo-idle" plays an AI that does
// not report its staff (as Antigravity): the director alone. The e2e reads
// it as window.__fakeOffice: step() plays one step, gapNext() drops the next
// event to make a seq gap. The harness opens it with ?at=machine-chat&office
// (the demo machine then reports tunelo 3.6.0) and the session's "Văn phòng"
// switch. Never imported by production code.
import { create } from "@bufbuild/protobuf";
import {
	OfficeActivityEndSchema,
	OfficeActivitySchema,
	OfficeActivityStartSchema,
	OfficeActorLeaveSchema,
	OfficeActorSchema,
	OfficeActorState,
	OfficeAnimGroup,
	OfficeApprovalSchema,
	OfficeApprovalState,
	OfficeChecksSchema,
	OfficeEventSchema,
	OfficeRole,
	OfficeRoom,
	OfficeSessionSchema,
	OfficeTodoCountsSchema,
	OfficeTurnStartSchema,
	OfficeUsageSchema,
	type Frame,
	type OfficeActivity,
	type OfficeActor,
	type OfficeEvent,
	type OfficeSession,
	OfficeServiceKind,
} from "@achoo254/chat-proto/remote/remote";
import type { Body, FakeMachine, FakeSocket } from "../machines/fake-machine.ts";

type Kind = OfficeEvent["kind"];

/** One scripted step every this many milliseconds while watched. */
export const STEP_MS = 2_500;
const EPOCH = 7n;

const { DIRECTOR, EMPLOYEE, MACHINE } = OfficeRole;
const { IDLE, WORKING, DONE } = OfficeActorState;

function activity(id: string, tool: string, group: OfficeAnimGroup, room: OfficeRoom, subject = "", startedAt = Date.now()): OfficeActivity {
	return create(OfficeActivitySchema, { id, tool, group, room, subject, startedAt: BigInt(startedAt) });
}

function employee(id: string, agentType: string, description: string, nested: { parentId: string; spawnDepth: number } = { parentId: "", spawnDepth: 1 }): OfficeActor {
	return create(OfficeActorSchema, { id, role: EMPLOYEE, agentType, description, ...nested, state: WORKING, enteredAt: BigInt(Date.now()), activity: activity("arrive", "", OfficeAnimGroup.ARRIVE, OfficeRoom.LOBBY) });
}

const enter = (actor: OfficeActor): Kind => ({ case: "actorEnter", value: actor });
const update = (actor: OfficeActor): Kind => ({ case: "actorUpdate", value: actor });
const leave = (actorId: string): Kind => ({ case: "actorLeave", value: create(OfficeActorLeaveSchema, { actorId }) });
const turnStart = (): Kind => ({ case: "turnStart", value: create(OfficeTurnStartSchema) });
const approval = (actorId: string, state: OfficeApprovalState): Kind => ({ case: "approval", value: create(OfficeApprovalSchema, { actorId, state }) });
const start = (actorId: string, act: OfficeActivity): Kind => ({ case: "activityStart", value: create(OfficeActivityStartSchema, { actorId, activity: act }) });
const end = (actorId: string, activityId: string, ok = true): Kind => ({ case: "activityEnd", value: create(OfficeActivityEndSchema, { actorId, activityId, ok }) });
const todo = (pending: number, inProgress: number, done: number) => create(OfficeTodoCountsSchema, { pending, inProgress, done });
const checks = (passed: number, failed: number, lastOk: boolean) => create(OfficeChecksSchema, { passed, failed, lastOk });

/** The office of one watched session. */
class Office {
	seq = 0n;
	step = 0;
	actors: OfficeActor[];
	session: OfficeSession;
	gap = false;
	private leaks = 0;

	constructor(
		readonly threadId: string,
		readonly reportsStaff: boolean,
		private readonly out: (body: Body) => void,
	) {
		const now = Date.now();
		this.actors = [create(OfficeActorSchema, { id: "director", role: DIRECTOR, state: IDLE, enteredAt: BigInt(now - 40 * 60_000) })];
		this.session = create(OfficeSessionSchema, {
			busy: false,
			startedAt: BigInt(now - 42 * 60_000),
			tasksDone: 12,
			todo: todo(2, 1, 5),
			usage: create(OfficeUsageSchema, { inputTokens: 182_400n, outputTokens: 24_900n, costUsdEstimate: 1.84, hasCost: reportsStaff, available: true }),
			checks: checks(3, 1, true),
		});
	}

	snapshot(): Body {
		return { case: "officeSnapshot", value: { threadId: this.threadId, epoch: EPOCH, seq: this.seq, state: { actors: this.actors, reportsStaff: this.reportsStaff, session: this.session } } };
	}

	private actor(id: string): OfficeActor | undefined {
		return this.actors.find((a) => a.id === id);
	}

	/** Applies `kinds` to the model and sends them as one OfficeEvents frame. */
	private emit(...kinds: Kind[]): void {
		const events: OfficeEvent[] = [];
		for (const kind of kinds) {
			this.seq += 1n;
			this.apply(kind);
			if (this.gap) {
				this.gap = false;
				continue;
			}
			events.push(create(OfficeEventSchema, { seq: this.seq, at: BigInt(Date.now()), kind }));
		}
		if (events.length > 0) this.out({ case: "officeEvents", value: { threadId: this.threadId, epoch: EPOCH, events } });
	}

	private apply(kind: Kind): void {
		const change = (id: string, next: (a: OfficeActor) => OfficeActor): void => {
			this.actors = this.actors.map((a) => (a.id === id ? next(a) : a));
		};
		switch (kind.case) {
			case "actorEnter":
				this.actors = [...this.actors, kind.value];
				break;
			case "actorUpdate":
				change(kind.value.id, () => kind.value);
				break;
			case "actorLeave":
				this.actors = this.actors.filter((a) => a.id !== kind.value.actorId);
				break;
			case "activityStart":
				change(kind.value.actorId, (a) => ({ ...a, activity: kind.value.activity }));
				break;
			case "activityEnd":
				change(kind.value.actorId, (a) => (a.activity?.id === kind.value.activityId ? { ...a, activity: undefined } : a));
				break;
			case "approval":
				change(kind.value.actorId, (a) => ({ ...a, state: kind.value.state === OfficeApprovalState.WAITING ? OfficeActorState.AWAITING_APPROVAL : WORKING }));
				break;
			case "session":
				this.session = kind.value;
				break;
			default:
				break;
		}
	}

	private sessionWith(change: Partial<Omit<OfficeSession, "$typeName" | "$unknown">>): Kind {
		return { case: "session", value: { ...this.session, ...change } };
	}

	private director(state: OfficeActorState): Kind {
		const d = this.actor("director") ?? create(OfficeActorSchema, { id: "director", role: DIRECTOR });
		// Idle: the director drops whatever was still open (no activity_end of its own).
		return update({ ...d, state, activity: state === IDLE ? undefined : d.activity });
	}

	/** A subagent's tool that carries a subject, as an agent that does not keep the contract would send it (the real one only does for the director's tools). */
	leak(actorId: string, subject: string): void {
		this.leaks += 1;
		this.emit(start(actorId, activity(`leak-${this.leaks}`, "Bash", OfficeAnimGroup.MACHINE, OfficeRoom.QA, subject)));
	}

	/** Plays the next step of the script. */
	next(): void {
		const s = this.step;
		this.step = (this.step + 1) % (this.reportsStaff ? 22 : 8);
		const R = OfficeRoom;
		const G = OfficeAnimGroup;
		if (!this.reportsStaff) {
			// The director alone, walking through the rooms of its tools.
			const tools: [string, OfficeAnimGroup, OfficeRoom, string][] = [
				["view_file", G.READ, R.LIBRARY, "office-store.ts"],
				["run_command", G.MACHINE, R.QA, "pnpm"],
				["write_to_file", G.TYPE, R.WORK, "office-2d.tsx"],
				["run_command", G.MACHINE, R.POST, "git"],
				["search_web", G.PHONE, R.LIBRARY, ""],
				["", G.THINK, R.DIRECTOR, ""],
			];
			if (s === 0) return this.emit(turnStart(), this.sessionWith({ busy: true }), this.director(WORKING));
			if (s === 7) return this.emit(this.sessionWith({ busy: false }), this.director(IDLE));
			const [tool, group, room, subject] = tools[(s - 1) % tools.length] ?? tools[0] ?? ["", G.THINK, R.DIRECTOR, ""];
			return this.emit(start("director", activity(`ag-${s}`, tool, group, room, subject)));
		}
		switch (s) {
			case 0:
				return this.emit(turnStart(), this.sessionWith({ busy: true }), this.director(WORKING), start("director", activity("think", "", G.THINK, R.DIRECTOR)));
			case 1:
				return this.emit(start("director", activity("t1", "Read", G.READ, R.LIBRARY, "agent-core.ts")), enter(employee("s-scout", "scout", "Tìm chỗ gọi OfficeWatch")));
			case 2:
				return this.emit(
					start("s-scout", activity("s1-grep", "Grep", G.READ, R.LIBRARY)),
					enter(employee("s-tester", "tester", "Chạy test của web")),
					enter(employee("s-planner", "planner", "Lập kế hoạch cảnh 3D")),
				);
			case 3:
				return this.emit(
					start("director", activity("t2", "Bash", G.MACHINE, R.POST, "git")),
					start("s-tester", activity("s2-test", "Bash", G.MACHINE, R.QA)),
					start("s-planner", activity("s3-todo", "TodoWrite", G.TYPE, R.PLANNING)),
					this.sessionWith({ todo: todo(4, 1, 5) }),
				);
			case 4:
				return this.emit(
					end("s-tester", "s2-test", false),
					// A dev server on port 5173, as the agent labels it on the machine (never the command).
					enter(
						create(OfficeActorSchema, {
							id: "m-dev",
							role: MACHINE,
							agentType: "Bash",
							state: WORKING,
							enteredAt: BigInt(Date.now()),
							activity: activity("m-dev", "Bash", G.MACHINE, R.SERVER),
							service: { kind: OfficeServiceKind.DEV_SERVER, port: 5173, startedAt: BigInt(Date.now()) },
						}),
					),
					this.sessionWith({ checks: checks(3, 2, false), backgroundMachines: 1 }),
				);
			case 5:
				return this.emit(
					start("director", activity("t3", "Edit", G.TYPE, R.WORK, "office-store.ts")),
					enter(employee("s-review", "code-reviewer", "Soát lại thay đổi")),
					enter(employee("s-research", "researcher", "Tra tài liệu Babylon")),
				);
			case 6:
				return this.emit(
					start("s-review", activity("s4-edit", "Edit", G.TYPE, R.WORK)),
					start("s-research", activity("s5-web", "WebSearch", G.PHONE, R.LIBRARY)),
					start("s-tester", activity("s2-test2", "Bash", G.MACHINE, R.QA)),
				);
			case 7:
				return this.emit(
					end("s-tester", "s2-test2", true),
					this.sessionWith({ checks: checks(4, 2, true) }),
					enter(employee("s-gp1", "general-purpose", "Sửa bố cục điện thoại")),
					enter(employee("s-gp2", "general-purpose", "Viết test cho store")),
					enter(employee("s-debug", "debugger", "Tìm lỗi nối lại")),
				);
			case 8:
				return this.emit(
					enter(employee("s-gp3", "general-purpose", "Dọn CSS")),
					enter(employee("s-docs", "docs-manager", "Cập nhật tài liệu")),
					enter(employee("s-sec", "security-auditor", "Rà quyền MCP")),
					start("s-debug", activity("s6-read", "Read", G.READ, R.LIBRARY)),
				);
			case 9:
				// A nested subagent (started by the scout): the meeting room.
				return this.emit(
					enter(employee("s-nested", "Explore", "", { parentId: "s-scout", spawnDepth: 2 })),
					start("s-gp1", activity("g1-edit", "Write", G.TYPE, R.WORK)),
					start("s-sec", activity("sec-read", "Read", G.READ, R.LIBRARY)),
				);
			case 10:
				// An approval waits on the director's command: Security, the chairman in the lobby.
				return this.emit(
					start("director", activity("t4", "Bash", G.MACHINE, R.SERVER, "rm")),
					approval("director", OfficeApprovalState.WAITING),
					this.sessionWith({ waitingForUser: true }),
					// The nested subagent's first tool ends its arrival (as on the machine).
					start("s-nested", activity("n1-grep", "Grep", G.READ, R.LIBRARY)),
				);
			case 11:
				return this.emit(
					approval("director", OfficeApprovalState.DENIED),
					this.sessionWith({ waitingForUser: false }),
					end("director", "t4", false),
					// Between its tools the nested subagent sits in the meeting room.
					end("s-nested", "n1-grep"),
				);
			case 12:
				// The tunelo MCP (a message to the user): the lobby.
				return this.emit(start("director", activity("t5", "mcp", G.TYPE, R.LOBBY, "notify")), start("s-gp2", activity("g2-coffee", "", G.THINK, R.PANTRY)));
			case 13:
				// A tool started over two minutes ago: the hourglass.
				return this.emit(start("s-tester", activity("s2-e2e", "Bash", G.MACHINE, R.QA, "", Date.now() - 130_000)), start("s-docs", activity("d-mcp", "mcp", G.TYPE, R.POST)));
			case 14: {
				const scout = this.actor("s-scout");
				return this.emit(
					update({ ...(scout ?? employee("s-scout", "scout", "")), state: DONE, doneAt: BigInt(Date.now()), activity: activity("hand-in", "", G.HAND_IN, R.DIRECTOR) }),
					this.sessionWith({ tasksDone: 13 }),
					start("s-review", activity("s4-read", "Read", G.READ, R.LIBRARY)),
				);
			}
			case 15:
				return this.emit(end("s-scout", "hand-in"), leave("m-dev"), this.sessionWith({ backgroundMachines: 0 }));
			case 16:
				// A new scout subagent: the scout who finished takes it (one agent type, one employee).
				return this.emit(enter(employee("s-scout-2", "scout", "Tìm test cũ")), end("s-tester", "s2-e2e", true), this.sessionWith({ checks: checks(5, 2, true) }));
			case 17:
				return this.emit(start("s-scout-2", activity("s7-glob", "Glob", G.READ, R.LIBRARY)), start("director", activity("think", "", G.THINK, R.DIRECTOR)));
			case 18:
				return this.emit(this.sessionWith({ usage: create(OfficeUsageSchema, { inputTokens: 240_100n, outputTokens: 31_700n, costUsdEstimate: 2.37, hasCost: true, available: true }) }));
			case 19: {
				const done = ["s-scout-2", "s-tester", "s-planner", "s-review", "s-research", "s-gp1", "s-gp2", "s-gp3", "s-debug", "s-docs", "s-sec", "s-nested"];
				return this.emit(...done.flatMap((id): Kind[] => {
					const a = this.actor(id);
					return a === undefined ? [] : [update({ ...a, state: DONE, doneAt: BigInt(Date.now()), activity: activity("hand-in", "", G.HAND_IN, R.DIRECTOR) })];
				}));
			}
			case 20:
				return this.emit(this.sessionWith({ busy: false, tasksDone: 25 }), this.director(IDLE));
			default: {
				// Everyone goes home before the next turn.
				const leaving = this.actors.filter((a) => a.id !== "director").map((a) => leave(a.id));
				return this.emit(...leaving);
			}
		}
	}
}

/** The office exchange of the demo machine: answers OfficeWatch and plays the script to the watching socket. */
export class FakeOffice {
	private readonly offices = new Map<string, { office: Office; timer: ReturnType<typeof setInterval> | null }>();
	/** Steps play on their own every STEP_MS (false: only step() moves them). */
	auto = true;

	constructor(private readonly machine: FakeMachine) {}

	handle(frame: Frame, socket: FakeSocket): Body[] | undefined {
		if (frame.body.case !== "officeWatch") return undefined;
		const { threadId, on } = frame.body.value;
		const was = this.offices.get(threadId);
		if (!on) {
			// Like the agent, which rebuilds the office from the thread's journal on the next watch: the script stays where it was.
			if (was !== undefined && was.timer !== null) clearInterval(was.timer);
			if (was !== undefined) this.offices.set(threadId, { office: was.office, timer: null });
			return [{ case: "ack", value: {} }];
		}
		const office = was?.office ?? new Office(threadId, threadId !== "demo-idle", (body) => this.machine.send(socket, body));
		if (was !== undefined && was.timer !== null) clearInterval(was.timer);
		const timer = this.auto ? setInterval(() => office.next(), STEP_MS) : null;
		this.offices.set(threadId, { office, timer });
		return [office.snapshot()];
	}

	/** Stops the steps playing on their own (step() still plays them). */
	pause(): void {
		this.auto = false;
		for (const entry of this.offices.values()) {
			if (entry.timer !== null) clearInterval(entry.timer);
			entry.timer = null;
		}
	}

	/** Plays one step in every watched office. */
	step(): void {
		for (const { office } of this.offices.values()) office.next();
	}

	/** A subagent's tool with a subject in every watched office (see Office.leak). */
	leakSubject(actorId: string, subject: string): void {
		for (const { office } of this.offices.values()) office.leak(actorId, subject);
	}

	/** The next event of every watched office is lost on the way (a seq gap). */
	gapNext(): void {
		for (const { office } of this.offices.values()) office.gap = true;
	}
}
