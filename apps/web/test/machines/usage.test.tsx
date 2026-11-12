// "Hiệu quả": the route (/ai/<machine>/usage[/<repository key>]), the numbers
// of the page from a machine's report (rows matched by the canonical key,
// totals of 7 and 30 days, context against the 60 days before, the share
// the app opened, the suggestions), and the page over a fake machine:
// opened from a project's menu, the rules' switches, deleting the ledger
// only after a confirmation in the page, an outdated agent, offline.
import { createConnectTransport } from "@connectrpc/connect-web";
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, ProjectSchema, UsageReportSchema, UsageRule, type Frame, type Project } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { MachineLinksProvider } from "../../src/machines/link/connection-provider.tsx";
import MachinesScreen from "../../src/machines/machines-screen.tsx";
import { projectUsagePath, usagePath } from "../../src/machines/usage/usage-paths.ts";
import { dayOf, reportRange, shiftDay, summarize, usageKeyOf } from "../../src/machines/usage/usage-summary.ts";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
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

const hintAt = (offset: number, rule: UsageRule, value: number, extra: { repoKey?: string; notifiedAt?: number; experimental?: boolean } = {}) => ({
	rule,
	sessionId: `s-${rule}-${offset}-abcdef`,
	repoKey: extra.repoKey ?? REMOTE,
	turn: 12,
	at: BigInt(new Date(`${shiftDay(today, -offset)}T10:00:00`).getTime()),
	value: BigInt(value),
	experimental: extra.experimental ?? false,
	notifiedAt: BigInt(extra.notifiedAt ?? 0),
});

/** Last 30 days: 2 days of 10 calls at 300K (6 by the app); the baseline: 1 day of 20 calls at 400K; another repository too. */
function report() {
	return create(UsageReportSchema, {
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
	});
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
		expect(s.baseline).toMatchObject({ mainTurns: 20, meanContext: 400_000 });
		expect(s.changePercent).toBe(-25);
		expect(s.appPercent).toBe(30);
		// The last 30 days' suggestions of this repository, newest first.
		expect(s.hints.map((h) => h.rule)).toEqual([UsageRule.MECHANICAL, UsageRule.CONTEXT]);
		// Every repository: the other one's calls and hint count too.
		const all = summarize(report(), "", today);
		expect(all.month.mainTurns).toBe(119);
		expect(all.hints).toHaveLength(3);
		// A key without calls; no baseline means no change.
		expect(summarize(report(), "local:none", today)).toMatchObject({ empty: true, changePercent: null, appPercent: null });
		const recentOnly = create(UsageReportSchema, { days: [day(1)] });
		expect(summarize(recentOnly, KEY, today).changePercent).toBeNull();
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

const services = { toasts: { show: () => undefined } } as unknown as Services;
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

describe("the Hiệu quả page", () => {
	it("shows the repository's totals, context against the baseline, the app's share and the suggestions", async () => {
		open({ page: "usage", machine: "1", key: KEY });
		const totals = await screen.findByRole("table", undefined, WAIT);
		const row = (name: string) => within(totals).getByRole("row", { name: new RegExp(`^${name}`) });
		expect(within(row(u.mainTurns)).getAllByRole("cell").map((c) => c.textContent)).toEqual(["10", "20"]);
		expect(within(row(u.subagentTurns)).getAllByRole("cell").map((c) => c.textContent)).toEqual(["2", "4"]);
		const context = within(page()).getByRole("region", { name: u.contextTitle });
		expect(context.textContent).toContain(u.contextChange(-25));
		expect(within(page()).getByRole("region", { name: u.appShareTitle }).textContent).toContain(u.appShare(30, "6", "20"));
		const hints = within(page()).getByRole("region", { name: u.hintsTitle });
		const items = within(hints).getAllByRole("listitem");
		expect(items.map((i) => i.querySelector("b")?.textContent)).toEqual([u.rules.mechanical.name, u.rules.context.name]);
		expect(items[0]?.textContent).toContain(u.experimental);
		expect(items[0]?.textContent).toContain(u.rules.mechanical.hint("81%"));
		expect(items[1]?.textContent).toContain(u.notified);
		// The machine was asked once for every repository of the last 90 days; the page picks the key.
		expect(machine.sent("usageReportRequest")).toEqual([expect.objectContaining({ ...reportRange(today), repoKey: "" })]);
		expect(screen.getByText(u.subtitle(KEY, "Mac mini"))).toBeTruthy();
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
		expect(screen.getByRole("region", { name: u.deleteTitle })).toBeTruthy();
	});

	it("an offline machine says so and asks nothing", async () => {
		open({ page: "usage", machine: "1", key: KEY }, false);
		expect(await screen.findByText(u.offline, undefined, WAIT)).toBeTruthy();
		expect(await screen.findByText(u.subtitle(KEY, "Mac mini"), undefined, WAIT)).toBeTruthy();
		expect(machine.sent("usageReportRequest")).toHaveLength(0);
	});
});
