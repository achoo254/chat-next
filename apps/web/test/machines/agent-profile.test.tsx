// The machine's Claude account seen from a session: the account item and its
// menu (one tap switches the whole machine), the list following what the
// machine announces without asking again, "switches after this turn", the
// limit bar's one-tap switch, and the session column's preview line.
import { create } from "@bufbuild/protobuf";
import {
	AccountListResultSchema,
	AccountStatus,
	AiAccountSchema,
	MachineAccountsSchema,
	ThreadInfoSchema,
	ThreadState,
	type AccountListResult,
	type MachineAccounts,
	type ThreadSummary,
} from "@achoo254/chat-proto/remote/remote";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AccountMenu } from "../../src/machines/account-menu.tsx";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import type { MachineLink } from "../../src/machines/link/machine-link.ts";
import { accountsOf, sessionProfileId, switchPending, usable, useProfiles } from "../../src/machines/machine-profile.ts";
import { LimitBar } from "../../src/machines/session-chat.tsx";
import { rowLine } from "../../src/machines/session-sidebar.tsx";
import { StatusBar } from "../../src/machines/status-bar.tsx";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

const OK = AccountStatus.OK;
const list = (selectedId: string): AccountListResult =>
	create(AccountListResultSchema, {
		selectedByProvider: { claude: selectedId },
		actions: [{ provider: "claude", signIn: true, usage: true }],
		accounts: [
			create(AiAccountSchema, { provider: "claude", id: "", email: "team@example.com", plan: "team", status: OK, usage: { fiveHour: { utilization: 100 }, sevenDay: { utilization: 40 } } }),
			create(AiAccountSchema, { provider: "claude", id: "p2", email: "max@example.com", plan: "max", status: OK, usage: { fiveHour: { utilization: 12 } }, usageUpdatedAt: 1n }),
			create(AiAccountSchema, { provider: "claude", id: "p3", email: "old@example.com", status: AccountStatus.NEEDS_SIGN_IN }),
			// Another AI's account never shows among Claude's.
			create(AiAccountSchema, { provider: "antigravity", id: "", email: "agy@example.com", status: OK }),
		],
	});
const announce = (selectedId: string, sessions: { threadId: string; accountId: string; switchPending?: boolean }[] = []): MachineAccounts =>
	create(MachineAccountsSchema, { accounts: list(selectedId), sessions: sessions.map((s) => ({ ...s, provider: "claude" })) });

/** A link that answers AccountList/AccountSelect with `answer` and records requests. */
const fakeLink = (answer: () => AccountListResult) => {
	const sent: { case: string; value: unknown }[] = [];
	const link = {
		request: (body: { case: string; value: unknown }) => {
			sent.push(body);
			return Promise.resolve({ body: { case: "accountListResult", value: answer() } });
		},
	} as unknown as MachineLink;
	return { link, sent };
};

/** The account menu fed by useProfiles, the announced frame settable from outside. */
function Harness({ link, announced }: { link: MachineLink; announced: MachineAccounts | null }) {
	const profiles = useProfiles(link, announced, true, "claude");
	return <AccountMenu ai="Claude Code" machine="1" link={link} profiles={profiles} current={profiles.list?.selectedId ?? ""} fallbackEmail="" disabled={false} />;
}

describe("machine profile", () => {
	it("reads a session's profile and pending switch from what the machine announced, else from the session", () => {
		const announced = announce("p2", [{ threadId: "t", accountId: "", switchPending: true }]);
		expect(sessionProfileId(announced, "t", undefined, accountsOf(announced.accounts ?? null, "claude"))).toBe("");
		expect(switchPending(announced, "t", undefined)).toBe(true);
		const info = create(ThreadInfoSchema, { threadId: "t", accountId: "p2", accountSwitchPending: false, account: { email: "max@example.com" } });
		expect(sessionProfileId(null, "t", info, null)).toBe("p2");
		expect(switchPending(null, "t", info)).toBe(false);
		expect(sessionProfileId(null, "t", undefined, accountsOf(list("p3"), "claude"))).toBe("p3");
		expect(accountsOf(list(""), "claude")?.accounts.map((a) => a.email)).toEqual(["team@example.com", "max@example.com", "old@example.com"]);
		expect(accountsOf(list(""), "codex")).toBeNull();
		expect(usable(list("").accounts[2] ?? create(AiAccountSchema))).toBe(false);
		expect(usable(create(AiAccountSchema, { id: "", status: AccountStatus.NEEDS_SIGN_IN }))).toBe(true);
	});

	it("switches the whole machine in one tap from the account menu", async () => {
		const user = userEvent.setup();
		const { link, sent } = fakeLink(() => list("p2"));
		wrap(<Harness link={link} announced={announce("")} />);
		await user.click(screen.getByRole("button", { name: /Tài khoản Claude Code: team@example.com · Team/ }));
		const menu = screen.getByRole("menu", { name: "Tài khoản Claude Code của máy" });
		const items = within(menu).getAllByRole("menuitemradio");
		expect(items[0]?.getAttribute("aria-checked")).toBe("true");
		expect(within(items[0] as HTMLElement).getByText("100%")).toBeTruthy();
		expect((items[2] as HTMLButtonElement).disabled).toBe(true);
		expect(within(items[2] as HTMLElement).getByText("Cần đăng nhập lại")).toBeTruthy();
		await user.click(within(menu).getByRole("menuitemradio", { name: "Chuyển cả máy sang max@example.com" }));
		expect(sent).toEqual([{ case: "accountSelect", value: { id: "p2", provider: "claude" } }]);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("follows what the machine announces without asking the list again", () => {
		const { link, sent } = fakeLink(() => list(""));
		function Live() {
			const [frame, setFrame] = useState(announce(""));
			return (
				<>
					<button type="button" onClick={() => setFrame(announce("p2"))}>
						push
					</button>
					<Harness link={link} announced={frame} />
				</>
			);
		}
		wrap(<Live />);
		expect(screen.getByRole("button", { name: /team@example.com/ })).toBeTruthy();
		act(() => screen.getByRole("button", { name: "push" }).click());
		expect(screen.getByRole("button", { name: /Tài khoản Claude Code: max@example.com · Max/ })).toBeTruthy();
		expect(sent).toEqual([]);
	});

	it("asks the list once from a machine that does not announce it (tunelo 2.0.1)", async () => {
		const { link, sent } = fakeLink(() => list("p2"));
		wrap(<Harness link={link} announced={null} />);
		expect(await screen.findByRole("button", { name: /max@example.com/ })).toBeTruthy();
		expect(sent).toEqual([{ case: "accountList", value: {} }]);
	});

	it("says a running session switches after its turn", () => {
		const link = fakeLink(() => list("")).link;
		wrap(<StatusBar answered="" ai="Claude Code" dir="" machine={null} provider="claude" model="" context={null} info={undefined} link={link} threadId="t" online switchingTo="max@example.com" />);
		expect(screen.getByRole("status").textContent).toBe("Sẽ chuyển sang max@example.com sau lượt này");
	});

	it("offers the account with usage left when the session's ran out, in one tap", async () => {
		const user = userEvent.setup();
		const onSwitch = vi.fn(() => Promise.resolve());
		wrap(<LimitBar from="team@example.com · Team" to="max@example.com" left={88} onSwitch={onSwitch} ai="Claude Code" />);
		expect(screen.getByRole("alert").textContent).toContain("team@example.com · Team hết hạn mức. max@example.com còn 88%.");
		await user.click(screen.getByRole("button", { name: "Chuyển cả máy sang max@example.com" }));
		expect(onSwitch).toHaveBeenCalledTimes(1);
	});
});

describe("session column preview", () => {
	const t = viMachines;
	const row = (fields: Partial<ThreadSummary>): ThreadSummary =>
		({ id: "t", title: "t", dir: "~/x", provider: "claude", model: "", state: ThreadState.IDLE, pending: 0, updatedAt: 0n, open: true, preview: "", previewTool: "", ...fields }) as ThreadSummary;

	it("shows the tool running, else the last message, else the state; waiting comes first", () => {
		expect(rowLine(t, row({ state: ThreadState.WAITING, preview: "x", previewTool: "Bash" }), null)).toBe("Chờ bạn duyệt");
		expect(rowLine(t, row({ state: ThreadState.RUNNING, preview: "x", previewTool: "Bash" }), null)).toBe("Đang chạy: Bash");
		expect(rowLine(t, row({ preview: "Đã sửa xong 3 file" }), null)).toBe("Đã sửa xong 3 file");
		expect(rowLine(t, row({ state: ThreadState.RUNNING }), null)).toBe("Đang làm…");
		expect(rowLine(t, row({ open: false }), null)).toBe("Đã tạm tắt");
		expect(rowLine(t, row({ title: "", open: false }), null)).toBe("Chưa có tin nhắn");
		expect(rowLine(enMachines, row({ state: ThreadState.RUNNING, previewTool: "Bash" }), null)).toBe("Running: Bash");
	});
});
