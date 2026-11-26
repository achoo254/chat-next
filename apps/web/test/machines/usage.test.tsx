// "Hiệu quả": the route (/ai/<machine>/usage[/<repository key>]), the numbers
// of the page from a machine's report (rows matched by the canonical key,
// totals of 7 and 30 days and the 30 before, the share the app opened; costs,
// models, sessions, rule cards, outcomes and the 5-hour forecast from tunelo
// 3.30.0), and the page over a fake machine: opened from a project's menu,
// the rules' switches, deleting the ledger only after a confirmation in the
// page, an outdated agent, offline.
import { createConnectTransport } from "@connectrpc/connect-web";
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, ProjectSchema, UsageReportSchema, UsageRule, type Frame, type Project } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AgentWorkspaceKind } from "../../src/machines/agent-projects-client.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { MachineLinksProvider } from "../../src/machines/link/connection-provider.tsx";
import MachinesScreen from "../../src/machines/machines-screen.tsx";
import { projectUsagePath, usagePath } from "../../src/machines/usage/usage-paths.ts";
import { dayOf, reportRange, shiftDay, summarize, usageKeyOf } from "../../src/machines/usage/usage-summary.ts";
import { usd } from "../../src/machines/usage/usage-format.ts";
import { OTHER, changeOf, fillsAt, insightsOf, seriesOf } from "../../src/machines/usage/usage-insights.ts";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import { machinesServices } from "../support/machines-services.ts";
import { matchRoute, type MachinesView } from "../../src/router.tsx";
import { FakeMachines } from "../support/fake-machines.ts";
import { routerFetch } from "../support/router-fetch.ts";
import { defaultAnswer, FakeMachine, type Body } from "./fake-machine.ts";

const u = viMachines.usage;
const today = dayOf(new Date());
const REMOTE = "git@github.com:demo/app.git";
const KEY = "github.com/demo/app";

const day = (offset: number, fields: { repoKey?: string; main?: number; sub?: number; app?: number; mean?: number; input?: number } = {}) => ({
	repoKey: fields.repoKey ?? REMOTE,
	day: shiftDay(today, -offset),
	inputTokens: BigInt(fields.input ?? 100),
	cacheReadTokens: 1000n,
	cacheWriteTokens: 10n,
	outputTokens: 50n,
	mainTurns: fields.main ?? 10,
	subagentTurns: fields.sub ?? 2,
	sessions: 1,
	appTurns: fields.app ?? 0,
	meanContext: BigInt(fields.mean ?? 200_000),
	medianContext: 0n,
	p90Context: 0n,
});

const hintAt = (offset: number, rule: UsageRule, value: number, extra: { repoKey?: string; notifiedAt?: number; experimental?: boolean; excessUsd?: number } = {}) => ({
	rule,
	sessionId: `s-${rule}-${offset}-abcdef`,
	repoKey: extra.repoKey ?? REMOTE,
	turn: 12,
	at: BigInt(new Date(`${shiftDay(today, -offset)}T10:00:00`).getTime()),
	value: BigInt(value),
	experimental: extra.experimental ?? false,
	notifiedAt: BigInt(extra.notifiedAt ?? 0),
	excessUsd: extra.excessUsd ?? 0,
});

const modelDay = (offset: number, model: string, cost: number, extra: { repoKey?: string; main?: number } = {}) => ({
	repoKey: extra.repoKey ?? REMOTE,
	day: shiftDay(today, -offset),
	model,
	inputTokens: 100n,
	cacheReadTokens: 1000n,
	cacheWriteTokens: 10n,
	outputTokens: 50n,
	mainTurns: extra.main ?? 10,
	subagentTurns: 0,
	costUsd: cost,
	priced: true,
});

const session = (id: string, cost: number, extra: { repoKey?: string; commits?: number; known?: boolean; main?: number; daysAgo?: number } = {}) => ({
	provider: "claude",
	sessionId: id,
	repoKey: extra.repoKey ?? REMOTE,
	firstAt: BigInt(Date.now() - (extra.daysAgo ?? 1) * 86_400_000),
	lastAt: BigInt(Date.now() - (extra.daysAgo ?? 1) * 86_400_000 + 3_600_000),
	mainTurns: extra.main ?? 40,
	subagentTurns: 2,
	peakContext: 320_000n,
	model: "claude-opus-5-5",
	costUsd: cost,
	unpricedTurns: 0,
	app: true,
	outcomeKnown: extra.known ?? true,
	commits: extra.commits ?? 0,
	filesChanged: (extra.commits ?? 0) * 3,
});

/** The report of a tunelo 3.30.0+ machine: the same days, with rows per model, sessions and costs. */
function richReport() {
	return create(UsageReportSchema, {
		...reportInit(),
		modelDays: [
			modelDay(40, "claude-opus-5-5", 30),
			modelDay(20, "claude-opus-5-5", 10),
			modelDay(1, "claude-opus-5-5", 8),
			modelDay(1, "claude-sonnet-5-5", 2),
			modelDay(1, "claude-haiku-5-5", 1, { repoKey: "https://example.com/other/repo.git", main: 99 }),
		],
		sessions: [session("s-costly", 9, { commits: 0 }), session("s-good", 6, { commits: 3 }), session("s-old", 50, { daysAgo: 45 }), session("s-plain", 2, { known: false })],
		suggestions: [
			hintAt(40, UsageRule.CONTEXT, 350_000, { excessUsd: 5 }),
			hintAt(2, UsageRule.CONTEXT, 412_000, { notifiedAt: Date.now(), excessUsd: 1.5 }),
			hintAt(1, UsageRule.MECHANICAL, 812, { experimental: true, excessUsd: 0.25 }),
			hintAt(1, UsageRule.TURNS, 320, { repoKey: "https://example.com/other/repo.git" }),
		],
	});
}

/** Last 30 days: 2 days of 10 calls at 300K (6 by the app); the baseline: 1 day of 20 calls at 400K; another repository too. */
function report() {
	return create(UsageReportSchema, reportInit());
}

function reportInit() {
	return {
		...reportRange(today),
		lastScanAt: BigInt(Date.now()),
		shape: { usageRatio: 1 },
		days: [
			day(40, { main: 20, mean: 400_000 }),
			day(20, { mean: 300_000, app: 2 }),
			day(1, { mean: 300_000, app: 4 }),
			day(1, { repoKey: "https://example.com/other/repo.git", main: 99, mean: 900_000 }),
		],
		suggestions: [
			hintAt(40, UsageRule.CONTEXT, 350_000),
			hintAt(2, UsageRule.CONTEXT, 412_000, { notifiedAt: Date.now() }),
			hintAt(1, UsageRule.MECHANICAL, 812, { experimental: true }),
			hintAt(1, UsageRule.TURNS, 320, { repoKey: "https://example.com/other/repo.git" }),
		],
	};
}

describe("the usage route", () => {
	it("opens every repository or one key, under /ai and the old /machines", () => {
		expect(matchRoute("/ai/4/usage")).toEqual({ name: "machines", view: { page: "usage", machine: "4", key: "" } });
		expect(matchRoute(usagePath("4", KEY))).toEqual({ name: "machines", view: { page: "usage", machine: "4", key: KEY } });
		expect(matchRoute(usagePath("4", "local:My Folder"))).toEqual({ name: "machines", view: { page: "usage", machine: "4", key: "local:My Folder" } });
		expect(matchRoute("/machines/4/usage/scratch")).toEqual({ name: "machines", view: { page: "usage", machine: "4", key: "scratch" } });
		expect(usagePath("4", KEY)).toBe("/ai/4/usage/github.com%2Fdemo%2Fapp");
		// A machine id only; a malformed escape is no route.
		expect(matchRoute("/ai/x/usage")).toBeNull();
		expect(matchRoute("/ai/4/usage/%E0%A4%A")).toBeNull();
	});

	it("a project opens on its first online workspace, by its repository or its folder", () => {
		const ws = (dir: string, machine: string | null, online: boolean) => ({ dir, machine, online });
		expect(projectUsagePath({ gitRemote: KEY, workspaces: [ws("/w/app", "1", false), ws("/x/app", "2", true)] })).toBe(usagePath("2", KEY));
		expect(projectUsagePath({ gitRemote: "", workspaces: [ws("/w/notes/", "1", false)] })).toBe(usagePath("1", "local:notes"));
		expect(projectUsagePath({ gitRemote: KEY, workspaces: [ws("/w/app", null, false)] })).toBeNull();
		expect(projectUsagePath({ gitRemote: KEY, workspaces: [] })).toBeNull();
	});
});

describe("the usage numbers", () => {
	it("matches the machine's remotes by canonical key and sums 7 days, 30 days and the baseline", () => {
		expect(usageKeyOf(REMOTE)).toBe(KEY);
		expect(usageKeyOf("https://github.com/Demo/App")).toBe(KEY);
		expect(usageKeyOf("local:notes")).toBe("local:notes");
		expect(usageKeyOf("scratch")).toBe("scratch");
		const s = summarize(report(), KEY, today);
		expect(s.empty).toBe(false);
		expect(s.week).toMatchObject({ mainTurns: 10, subagentTurns: 2, input: 100, meanContext: 300_000 });
		expect(s.month).toMatchObject({ mainTurns: 20, subagentTurns: 4, input: 200, cacheRead: 2000, appTurns: 6, meanContext: 300_000 });
		// Day 40 is in the 30 days before the last 30.
		expect(s.previous).toMatchObject({ mainTurns: 20, meanContext: 400_000 });
		expect(s.appPercent).toBe(30);
		// Every repository: the other one's calls too.
		expect(summarize(report(), "", today).month.mainTurns).toBe(119);
		// A key without calls.
		expect(summarize(report(), "local:none", today)).toMatchObject({ empty: true, appPercent: null });
		expect(changeOf(300_000, 400_000)).toBe(-25);
		expect(changeOf(1, null)).toBeNull();
		expect(changeOf(1, 0)).toBeNull();
	});

	it("before tunelo 3.30.0: no costs, models or sessions; rules grouped from the suggestions", () => {
		const i = insightsOf(report(), KEY, today);
		expect(i.rich).toBe(false);
		expect(i.month).toMatchObject({ turns: 24, mainTurns: 20, cost: null });
		expect(i.models).toEqual([]);
		expect(i.repos.map((r) => [r.key, r.cost])).toEqual([[KEY, null]]);
		expect(i.rules.map((r) => [r.rule, r.count, r.excessUsd])).toEqual([
			[UsageRule.CONTEXT, 1, null],
			[UsageRule.MECHANICAL, 1, null],
		]);
		expect(i.outcomes).toBeNull();
	});

	it("from tunelo 3.30.0: costs against the 30 days before, by repository and model, sessions, habit costs and outcomes", () => {
		const i = insightsOf(richReport(), "", today);
		expect(i.rich).toBe(true);
		expect(i.month.cost).toBe(21);
		expect(i.previous.cost).toBe(30);
		expect(i.repos.map((r) => [r.key, r.cost])).toEqual([
			[KEY, 20],
			["example.com/other/repo", 1],
		]);
		expect(i.models.map((m) => m.key)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
		expect(i.models[0]?.share).toBeCloseTo(18 / 21);
		// The session older than 30 days is left out.
		expect(i.sessions.map((s) => s.sessionId)).toEqual(["s-costly", "s-good", "s-plain"]);
		const context = i.rules.find((r) => r.rule === UsageRule.CONTEXT);
		expect(context).toMatchObject({ count: 1, excessUsd: 1.5 });
		expect(i.outcomes).toMatchObject({ sessions: 2, commits: 3, filesChanged: 9, withoutCommit: 0.5 });
		expect(i.outcomes?.costPerCommit).toBe(5);
		expect(i.outcomes?.costly.map((s) => s.sessionId)).toEqual(["s-costly"]);
		// One repository: only its sessions and rules.
		const one = insightsOf(richReport(), KEY, today);
		expect(one.month.cost).toBe(20);
		expect(one.rules.map((r) => r.rule)).toEqual([UsageRule.CONTEXT, UsageRule.MECHANICAL]);
	});

	it("draws 30 days, the biggest bands first and the rest as one", () => {
		const byModel = seriesOf(richReport(), "", today, "model", "cost");
		expect(byModel.days).toHaveLength(30);
		expect(byModel.days[29]).toBe(today);
		expect(byModel.groups).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
		expect(byModel.values[28]).toEqual([8, 2, 1]);
		const many = create(UsageReportSchema, { modelDays: ["a", "b", "c", "d", "e", "f"].map((m, n) => modelDay(1, m, n + 1)) });
		const s = seriesOf(many, "", today, "model", "cost");
		expect(s.groups).toEqual(["f", "e", "d", "c", OTHER]);
		expect(s.values[28]).toEqual([6, 5, 4, 3, 3]);
		// Before tunelo 3.30.0: by repository from the day rows.
		expect(seriesOf(report(), "", today, "repo", "turns").groups).toEqual(["example.com/other/repo", KEY]);
	});

	it("tells when the 5-hour window fills at the pace of the last 3 hours, only before it resets", () => {
		const now = Date.now();
		const resets = now + 2 * 3_600_000;
		const point = (minutesAgo: number, utilization: number, resetsAt = resets) => ({ profileId: "", at: BigInt(now - minutesAgo * 60_000), scheduled: true, fiveHour: { utilization, resetsAt: BigInt(resetsAt) } });
		const at = fillsAt([point(60, 40), point(0, 70)] as never, resets, now);
		expect(at).toBe(now + 60 * 60_000);
		// Filling after the reset, falling, one reading, or another window: nothing to tell.
		expect(fillsAt([point(60, 60), point(0, 62)] as never, resets, now)).toBeNull();
		expect(fillsAt([point(60, 70), point(0, 40)] as never, resets, now)).toBeNull();
		expect(fillsAt([point(0, 70)] as never, resets, now)).toBeNull();
		expect(fillsAt([point(60, 40, 1), point(0, 70)] as never, resets, now)).toBeNull();
	});
});

// ---------------------------------------------------------------- the page

let machine: FakeMachine;
let device: KeyPair;
let projects: Project[];
let usageAnswer: (frame: Frame) => Body[];

vi.mock("../../src/machines/link/device-keys.ts", () => ({
	deviceKeyStore: () => ({
		device: async () => device,
		renew: async () => device,
		seenMachineKey: async () => null,
		rememberMachineKey: async () => undefined,
		forgetMachineKey: async () => undefined,
	}),
}));

const services = machinesServices;
const NativeWebSocket = window.WebSocket;
const WAIT = { timeout: 4000 };
const refusal = (reason: ErrorReason): Body[] => [{ case: "error", value: { code: ErrorCode.INVALID, message: "refused", reason, subject: "" } }];

/** The machine's usage side: a report, the switches (the mechanical rule experimental), deleting. */
function usageSide() {
	const switches = [
		{ rule: UsageRule.CONTEXT, enabled: true, experimental: false },
		{ rule: UsageRule.TURNS, enabled: true, experimental: false },
		{ rule: UsageRule.MECHANICAL, enabled: true, experimental: true },
		{ rule: UsageRule.SUBAGENTS, enabled: true, experimental: false },
	];
	return (frame: Frame): Body[] => {
		switch (frame.body.case) {
			case "usageReportRequest":
				return [{ case: "usageReport", value: report() }];
			case "usageSettingsGet":
				return [{ case: "usageSettings", value: { rules: switches } }];
			case "usageSettingsSet":
				for (const change of frame.body.value.rules) {
					const s = switches.find((x) => x.rule === change.rule);
					if (s !== undefined) s.enabled = change.enabled;
				}
				return [{ case: "usageSettings", value: { rules: switches } }];
			case "usageDelete":
				return [{ case: "ack", value: {} }];
			default:
				return defaultAnswer(frame) ?? [];
		}
	};
}

beforeEach(async () => {
	window.sessionStorage.clear();
	window.localStorage.clear();
	window.history.replaceState(null, "", "/ai");
	projects = [create(ProjectSchema, { id: "p1", name: "app", dir: "/w/app", gitRemote: REMOTE, git: { git: true, branch: "main" } })];
	usageAnswer = usageSide();
	machine = await FakeMachine.create();
	device = await generateKeyPair();
	machine.trusted = [device.publicKey];
	machine.handler = (frame: Frame) => {
		switch (frame.body.case) {
			case "machineInfoRequest":
				return [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", agentVersion: "2.8.0", maxSessions: 3, providers: [{ id: "claude", name: "Claude Code" }] } }];
			case "threadList":
				return [{ case: "threadListResult", value: { threads: [], openSessions: 0, maxSessions: 3 } }];
			case "projectList":
				return [{ case: "projectListResult", value: { projects, suggestions: [] } }];
			default:
				return usageAnswer(frame);
		}
	};
	window.WebSocket = function (url: string) {
		return machine.factory(url);
	} as unknown as typeof WebSocket;
});

afterEach(() => {
	window.WebSocket = NativeWebSocket;
});

function open(view: MachinesView, online = true) {
	const machines = new FakeMachines();
	machines.add({ name: "Mac mini", tunnelUrl: online ? "wss://m-1.tunnel.hoandat.com" : "", lastSeenAt: online ? BigInt(Math.floor(Date.now() / 1000)) : 0n, publicKey: machine.keys.publicKey });
	// The repository's folder, added on the machine: the project "app".
	machines.projects.seed("app", REMOTE, [{ machineId: 1, dir: "/w/app", branch: "main", kind: AgentWorkspaceKind.CLONE }]);
	const transport = createConnectTransport({ baseUrl: "http://localhost/rpc", useBinaryFormat: true, fetch: routerFetch((r) => machines.routes(r)) });
	render(
		<I18nProvider>
			<ServicesContext value={{ ...services, transport } as unknown as Services}>
				<MachineLinksProvider>
					<MachinesScreen view={view} />
				</MachineLinksProvider>
			</ServicesContext>
		</I18nProvider>,
	);
	return machines;
}

const page = () => screen.getByRole("region", { name: u.title });

/** Opens the folded part `summary` ("Chi tiết token", "Luật gợi ý và dữ liệu"). */
async function unfold(summary: string) {
	const el = await screen.findByText(summary, { selector: "summary" }, WAIT);
	await userEvent.click(el);
}

describe("the Hiệu quả page", () => {
	it("an older machine: the overview, the rule cards and the token details, and a line asking to update for costs", async () => {
		open({ page: "usage", machine: "1", key: KEY });
		const overview = await screen.findByRole("region", { name: u.overview.title }, WAIT);
		const tiles = within(overview).getAllByText((_, el) => el?.getAttribute("data-id") === "usage-tile");
		// Calls, context and cache: no cost tile without the machine's costs.
		expect(tiles).toHaveLength(3);
		expect(tiles[1]?.textContent).toContain(u.overview.context);
		expect(tiles[1]?.textContent).toContain(u.overview.down(25));
		expect(screen.getByText(u.richNeedsUpdate)).toBeTruthy();
		const habits = within(page()).getByRole("region", { name: u.habits.title });
		const cards = within(habits).getAllByRole("listitem").filter((li) => li.getAttribute("data-id") === "usage-rule");
		expect(cards.map((c) => c.querySelector("b")?.textContent)).toEqual([u.rules.context.name, u.rules.mechanical.name]);
		expect(cards[1]?.textContent).toContain(u.experimental);
		expect(cards[0]?.textContent).toContain(u.habits.notified);
		await unfold(u.details.title);
		const totals = within(page().querySelector<HTMLElement>("[data-id=usage-totals]") ?? page()).getByRole("table");
		const row = (name: string) => within(totals).getByRole("row", { name: new RegExp(`^${name}`) });
		expect(within(row(u.details.mainTurns)).getAllByRole("cell").map((c) => c.textContent)).toEqual(["10", "20"]);
		// The machine was asked once for every repository of the last 90 days; the page picks the key.
		expect(machine.sent("usageReportRequest")).toEqual([expect.objectContaining({ ...reportRange(today), repoKey: "" })]);
		expect(screen.getByText(u.subtitle(KEY, "Mac mini"))).toBeTruthy();
	});

	it("a tunelo 3.30.0 machine: cost, models and sessions named by their threads, habit costs and outcomes", async () => {
		const answer = usageSide();
		usageAnswer = (frame) => {
			if (frame.body.case === "usageReportRequest") return [{ case: "usageReport", value: richReport() }];
			if (frame.body.case === "sessionList")
				return [{ case: "sessionListResult", value: { sessions: [{ sessionId: "s-costly", dir: "/w/app", title: "Refactor the ledger", updatedAt: 0n, threadId: "t-9" }] } }];
			return answer(frame);
		};
		open({ page: "usage", machine: "1", key: "" });
		const overview = await screen.findByRole("region", { name: u.overview.title }, WAIT);
		await within(overview).findByText(u.overview.cost, undefined, WAIT);
		expect(overview.textContent).toContain(u.overview.down(30));
		expect(screen.queryByText(u.richNeedsUpdate)).toBeNull();
		const where = within(page()).getByRole("region", { name: u.where.title });
		await userEvent.click(within(where).getByRole("button", { name: u.where.sessions }));
		const link = await within(where).findByRole("link", { name: "Refactor the ledger" }, WAIT);
		expect(link.getAttribute("href")).toBe("/ai/1/s/t-9");
		await userEvent.click(within(where).getByRole("button", { name: u.where.models }));
		expect(within(where).getByRole("row", { name: /claude-sonnet-5-5/ })).toBeTruthy();
		const habits = within(page()).getByRole("region", { name: u.habits.title });
		expect(habits.textContent).toContain(u.rules.context.excess(usd(u, 1.5)));
		const outcome = within(page()).getByRole("region", { name: u.outcome.title });
		expect(outcome.textContent).toContain(u.outcome.commits);
		expect(outcome.textContent).toContain("50%");
	});

	it("is opened from the project's menu, on the project's repository", async () => {
		open({ page: "machines" });
		const list = document.querySelector<HTMLElement>(".mx-list") ?? document.body;
		await userEvent.click(await within(list).findByRole("button", { name: viMachines.agent.projects.menu("app") }, WAIT));
		await userEvent.click(within(list).getByRole("menuitem", { name: u.open }));
		expect(window.location.pathname).toBe(usagePath("1", KEY));
	});

	it("switches a rule on the machine and reads the report again", async () => {
		open({ page: "usage", machine: "1", key: KEY });
		await unfold(u.controls);
		const rules = await screen.findByRole("region", { name: u.settingsTitle }, WAIT);
		const mechanical = await within(rules).findByRole("checkbox", { name: new RegExp(u.rules.mechanical.name) }, WAIT);
		expect(mechanical.closest("label")?.textContent).toContain(u.experimental);
		await waitFor(() => expect(machine.sent("usageReportRequest")).toHaveLength(1), WAIT);
		await userEvent.click(mechanical);
		await waitFor(() => expect((mechanical as HTMLInputElement).checked).toBe(false), WAIT);
		expect(machine.sent("usageSettingsSet")).toEqual([expect.objectContaining({ rules: [expect.objectContaining({ rule: UsageRule.MECHANICAL, enabled: false })] })]);
		await waitFor(() => expect(machine.sent("usageReportRequest")).toHaveLength(2), WAIT);
	});

	it("deletes the ledger only after the confirmation in the page", async () => {
		const confirm = vi.spyOn(window, "confirm");
		open({ page: "usage", machine: "1", key: KEY });
		await unfold(u.controls);
		const section = await screen.findByRole("region", { name: u.deleteTitle }, WAIT);
		await waitFor(() => expect(machine.sent("usageReportRequest")).toHaveLength(1), WAIT);
		// Cancel: nothing is sent.
		await userEvent.click(within(section).getByRole("button", { name: u.delete }));
		expect(within(section).getByText(u.deleteAsk)).toBeTruthy();
		await userEvent.click(within(section).getByRole("button", { name: u.cancel }));
		expect(within(section).queryByText(u.deleteAsk)).toBeNull();
		expect(machine.sent("usageDelete")).toHaveLength(0);
		// Confirm: deleted, said, and the report read again.
		await userEvent.click(within(section).getByRole("button", { name: u.delete }));
		await userEvent.click(within(section).getByRole("button", { name: u.deleteYes }));
		await within(section).findByText(u.deleted, undefined, WAIT);
		expect(machine.sent("usageDelete")).toHaveLength(1);
		await waitFor(() => expect(machine.sent("usageReportRequest")).toHaveLength(2), WAIT);
		expect(confirm).not.toHaveBeenCalled();
		confirm.mockRestore();
	});

	it("an agent without the ledger asks to update it, with no controls", async () => {
		usageAnswer = (frame) => (frame.body.case?.startsWith("usage") === true ? refusal(ErrorReason.UNSUPPORTED_REQUEST) : (defaultAnswer(frame) ?? []));
		open({ page: "usage", machine: "1", key: "" });
		expect(await screen.findByText(u.needsUpdate, undefined, WAIT)).toBeTruthy();
		expect(screen.queryByRole("region", { name: u.deleteTitle })).toBeNull();
		expect(screen.queryByRole("region", { name: u.settingsTitle })).toBeNull();
	});

	it("a blocked ledger is said in words, and deleting stays offered", async () => {
		const answer = usageSide();
		usageAnswer = (frame) => (frame.body.case === "usageReportRequest" ? refusal(ErrorReason.USAGE_LEDGER_BLOCKED) : answer(frame));
		open({ page: "usage", machine: "1", key: KEY });
		expect(await screen.findByText(viMachines.errors.reasons.usageLedgerBlocked, undefined, WAIT)).toBeTruthy();
		await unfold(u.controls);
		expect(screen.getByRole("region", { name: u.deleteTitle })).toBeTruthy();
	});

	it("an offline machine says so and asks nothing", async () => {
		open({ page: "usage", machine: "1", key: KEY }, false);
		expect(await screen.findByText(u.offline, undefined, WAIT)).toBeTruthy();
		expect(await screen.findByText(u.subtitle(KEY, "Mac mini"), undefined, WAIT)).toBeTruthy();
		expect(machine.sent("usageReportRequest")).toHaveLength(0);
	});
});
