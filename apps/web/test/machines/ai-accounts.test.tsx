// "Tài khoản AI" of a machine: one block per AI that keeps accounts (none for
// an AI without the capability), the AI's own sign-in row named after what the
// AI offers, picking, refreshing usage and removing an account, adding one by
// signing in from a device (Claude) or keeping the account the AI is signed in
// as now (Antigravity), and what a refused switch says. Then the sign-in
// dialog of an AI that signs in from a device.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { AccountStatus, ErrorCode, ErrorReason, FrameSchema, MachineInfoSchema, type AccountListResult, type Frame } from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AiAccountsView } from "../../src/machines/ai-accounts/ai-accounts-screen.tsx";
import { ProviderAccountsSection } from "../../src/machines/ai-accounts/provider-accounts-section.tsx";
import { RemoteError, type MachineLink } from "../../src/machines/link/machine-link.ts";
import { accountsOf, type AccountList, type Profiles } from "../../src/machines/machine-profile.ts";
import { SignInCodeDialog, safeSignInUrl } from "../../src/machines/sign-in-code-dialog.tsx";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;
type Sent = Frame["body"];

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

/** A link that records requests and answers each from `answer`. */
function fakeLink(answer: (body: Sent) => Body) {
	const sent: Sent[] = [];
	const link = {
		request: (body: Body) => {
			const frame = create(FrameSchema, { body });
			sent.push(frame.body);
			return Promise.resolve(create(FrameSchema, { body: answer(frame.body) }));
		},
	} as unknown as MachineLink;
	return { link, sent };
}

const LIST: Body = {
	case: "accountListResult",
	value: {
		selectedByProvider: { claude: "", antigravity: "g2" },
		actions: [
			{ provider: "claude", signIn: true, usage: true },
			{ provider: "antigravity", captureCurrent: true },
		],
		accounts: [
			{ provider: "claude", id: "", email: "owner@example.com", organization: "Org", plan: "max", status: AccountStatus.OK, usage: { fiveHour: { utilization: 30 }, sevenDay: { utilization: 55 } }, usageUpdatedAt: BigInt(Date.UTC(2026, 10, 8, 7, 0)) },
			{ provider: "claude", id: "p2", email: "second@example.com", organization: "Org", plan: "pro", status: AccountStatus.OK, createdAt: 1n },
			{ provider: "antigravity", id: "", email: "", status: AccountStatus.OK },
			{ provider: "antigravity", id: "g2", email: "work@example.com", status: AccountStatus.OK, current: true },
		],
	},
};

/** The AccountListResult `list` carries, as the machine sends it. */
function wholeOf(list: Body): AccountListResult | null {
	const body = create(FrameSchema, { body: list }).body;
	return body.case === "accountListResult" ? body.value : null;
}

/** The accounts of `provider` in LIST, requests going to `link`. */
function profilesFor(link: MachineLink, provider: string, list: Body = LIST): Profiles {
	return {
		provider,
		list: accountsOf(wholeOf(list), provider),
		request: async (body) => {
			await link.request(body);
		},
		reload: () => undefined,
	};
}

describe("an AI's block on Tài khoản AI", () => {
	it("lists Claude's accounts with the one in use and their usage, picks another and reads usage again", async () => {
		const { link, sent } = fakeLink(() => LIST);
		wrap(<ProviderAccountsSection link={link} online ai="Claude Code" profiles={profilesFor(link, "claude")} />);
		const section = screen.getByRole("region", { name: "Claude Code" });
		const owner = within(section).getByText("owner@example.com").closest("li") as HTMLElement;
		expect(within(owner).getByText("Đang dùng")).toBeTruthy();
		expect(within(owner).getByText(/Mặc định hệ thống/)).toBeTruthy();
		expect(within(owner).getByText("30%")).toBeTruthy();
		expect(within(owner).getByText("55%")).toBeTruthy();
		const second = within(section).getByText("second@example.com").closest("li") as HTMLElement;
		expect(within(second).getByText("Chưa rõ hạn mức")).toBeTruthy();
		await userEvent.click(within(second).getByRole("button", { name: "Chọn" }));
		await waitFor(() => expect(sent.at(-1)).toEqual(expect.objectContaining({ case: "accountSelect", value: expect.objectContaining({ provider: "claude", id: "p2" }) })));
		await userEvent.click(within(owner).getByRole("button", { name: "Làm mới hạn mức" }));
		await waitFor(() => expect(sent.at(-1)).toEqual(expect.objectContaining({ case: "usageRefresh", value: expect.objectContaining({ id: "", provider: "claude" }) })));
		// Claude signs a new account in from this device; it has nothing to capture.
		expect(within(section).getByRole("button", { name: "Thêm tài khoản" })).toBeTruthy();
		expect(within(section).queryByRole("button", { name: "Lưu tài khoản đang đăng nhập" })).toBeNull();
	});

	it("marks a saved account that needs to sign in again, with when its sign-in ended", () => {
		const ended = Date.UTC(2026, 10, 1, 7, 0);
		const list: Body = {
			case: "accountListResult",
			value: {
				selectedByProvider: {},
				actions: [{ provider: "claude", signIn: true, usage: true }],
				accounts: [
					{ provider: "claude", id: "", email: "", status: AccountStatus.NEEDS_SIGN_IN },
					{ provider: "claude", id: "p2", email: "second@example.com", status: AccountStatus.NEEDS_SIGN_IN, loginExpiresAt: BigInt(ended) },
					{ provider: "claude", id: "p3", email: "third@example.com", status: AccountStatus.OK, loginExpiresAt: BigInt(Date.now() + 86_400_000) },
				],
			},
		};
		const { link } = fakeLink(() => list);
		wrap(<ProviderAccountsSection link={link} online ai="Claude Code" profiles={profilesFor(link, "claude", list)} />);
		const second = screen.getByText("second@example.com").closest("li") as HTMLElement;
		expect(within(second).getByText("Cần đăng nhập lại")).toBeTruthy();
		expect(within(second).getByText(/đăng nhập đã hết hạn lúc/)).toBeTruthy();
		expect((within(second).getByRole("button", { name: "Chọn" }) as HTMLButtonElement).disabled).toBe(true);
		const third = screen.getByText("third@example.com").closest("li") as HTMLElement;
		expect(within(third).queryByText("Cần đăng nhập lại")).toBeNull();
		expect(within(third).getByText(/đăng nhập tới/)).toBeTruthy();
		// The AI's own sign-in without an e-mail reads as the system default.
		expect(screen.getByText("Mặc định hệ thống")).toBeTruthy();
	});

	it("removes a saved account after confirming, never the AI's own sign-in", async () => {
		const { link, sent } = fakeLink(() => LIST);
		wrap(<ProviderAccountsSection link={link} online ai="Claude Code" profiles={profilesFor(link, "claude")} />);
		const owner = screen.getByText("owner@example.com").closest("li") as HTMLElement;
		expect(within(owner).queryByRole("button", { name: "Xoá" })).toBeNull();
		const second = screen.getByText("second@example.com").closest("li") as HTMLElement;
		await userEvent.click(within(second).getByRole("button", { name: "Xoá" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(/cấu hình dùng chung của Claude Code/)).toBeTruthy();
		await userEvent.click(within(dialog).getByRole("button", { name: "Xoá" }));
		await waitFor(() => expect(sent.at(-1)).toEqual(expect.objectContaining({ case: "accountRemove", value: expect.objectContaining({ provider: "claude", id: "p2" }) })));
	});

	it("keeps Antigravity's current sign-in as an account, with no device sign-in and no usage refresh", async () => {
		const { link, sent } = fakeLink(() => LIST);
		wrap(<ProviderAccountsSection link={link} online ai="Antigravity" profiles={profilesFor(link, "antigravity")} />);
		const section = screen.getByRole("region", { name: "Antigravity" });
		expect(within(section).getByText("Đăng nhập hiện tại của Antigravity")).toBeTruthy();
		const work = within(section).getByText("work@example.com").closest("li") as HTMLElement;
		expect(within(work).getByText("Đang dùng")).toBeTruthy();
		expect(within(section).queryByRole("button", { name: "Thêm tài khoản" })).toBeNull();
		expect(within(section).queryByRole("button", { name: "Làm mới hạn mức" })).toBeNull();
		expect(within(section).queryByText("Chưa rõ hạn mức")).toBeNull();
		expect(within(section).getByText(/đăng nhập Antigravity bằng tài khoản đó/)).toBeTruthy();
		await userEvent.click(within(section).getByRole("button", { name: "Lưu tài khoản đang đăng nhập" }));
		await waitFor(() => expect(sent.at(-1)).toEqual(expect.objectContaining({ case: "accountCaptureCurrent", value: expect.objectContaining({ provider: "antigravity" }) })));
		expect(await within(section).findByRole("status")).toHaveProperty("textContent", "Đã lưu tài khoản đang đăng nhập.");
	});

	it.each([
		["agy pid 4242", /Antigravity đang mở trên máy \(tiến trình 4242/],
		["Sửa lỗi đăng nhập", /phiên “Sửa lỗi đăng nhập” đang chạy một lượt/],
		["locked", /Keychain của máy đang khoá/],
		["", /Antigravity đang chạy trên máy/],
	])("says what holds the AI when a switch is refused (%s)", async (subject, said) => {
		const link = {
			request: () => Promise.reject(new RemoteError(ErrorCode.INVALID, "blocked", ErrorReason.ACCOUNT_SWITCH_BLOCKED, subject)),
		} as unknown as MachineLink;
		wrap(<ProviderAccountsSection link={link} online ai="Antigravity" profiles={profilesFor(link, "antigravity")} />);
		const own = screen.getByText("Đăng nhập hiện tại của Antigravity").closest("li") as HTMLElement;
		await userEvent.click(within(own).getByRole("button", { name: "Chọn" }));
		expect((await screen.findByRole("alert")).textContent).toMatch(said);
	});

	it("says when the AI's saved accounts cannot be read", () => {
		const list: Body = { case: "accountListResult", value: { actions: [{ provider: "antigravity", captureCurrent: true }], damaged: { antigravity: "bad json" } } };
		const { link } = fakeLink(() => list);
		wrap(<ProviderAccountsSection link={link} online ai="Antigravity" profiles={profilesFor(link, "antigravity", list)} />);
		expect(screen.getByRole("alert").textContent).toMatch(/Danh sách tài khoản Antigravity trên máy bị hỏng/);
	});
});

describe("Tài khoản AI of a machine", () => {
	const accounts = (list: Body | null): AccountList => ({ whole: list === null ? null : wholeOf(list), request: () => Promise.resolve(), reload: () => undefined });
	const providers = create(MachineInfoSchema, {
		providers: [
			{ id: "claude", name: "Claude Code", capabilities: { accounts: true } },
			{ id: "antigravity", name: "Antigravity", capabilities: { accounts: true } },
			{ id: "other", name: "Other AI", capabilities: { accounts: false } },
		],
	}).providers;

	it("shows one block per AI with accounts, in the machine's order, and none for an AI without them", () => {
		const { link } = fakeLink(() => LIST);
		wrap(<AiAccountsView link={link} online providers={providers} known accounts={accounts(LIST)} />);
		expect(screen.getAllByRole("region").map((b) => within(b).getByRole("heading").textContent)).toEqual(["Claude Code", "Antigravity"]);
		expect(screen.queryByRole("region", { name: "Other AI" })).toBeNull();
	});

	it("says so when no AI of the machine keeps accounts", () => {
		const { link } = fakeLink(() => LIST);
		wrap(<AiAccountsView link={link} online providers={providers.filter((p) => p.id === "other")} known accounts={accounts(null)} />);
		expect(screen.queryByRole("region")).toBeNull();
		expect(screen.getByText("Không AI nào trên máy này giữ được nhiều tài khoản.")).toBeTruthy();
	});

	it("asks to connect while the machine is offline", () => {
		const { link } = fakeLink(() => LIST);
		wrap(<AiAccountsView link={link} online={false} providers={[]} known={false} accounts={accounts(null)} />);
		expect(screen.getByText("Kết nối tới máy để xem và đổi tài khoản.")).toBeTruthy();
	});
});

describe("adding a Claude account", () => {
	const prompt: Body = { case: "accountSignInPrompt", value: { attemptId: "a1", url: "https://claude.com/cai/oauth/authorize?code=true&state=s" } };

	it("opens the sign-in page and sends the pasted code to the machine", async () => {
		const added = vi.fn();
		const { link, sent } = fakeLink((b) =>
			b.case === "accountSignInBegin" ? prompt : { case: "accountSignInResult", value: { ok: true, email: "second@example.com", id: "a1" } },
		);
		wrap(<SignInCodeDialog link={link} ai="Claude Code" provider="claude" onAdded={added} onClose={() => undefined} />);
		expect(await screen.findByRole("heading", { name: "Thêm tài khoản Claude Code" })).toBeTruthy();
		const open = await screen.findByRole("link", { name: "Mở trang đăng nhập" });
		expect(open.getAttribute("href")).toBe("https://claude.com/cai/oauth/authorize?code=true&state=s");
		expect(open.getAttribute("rel")).toBe("noopener noreferrer");
		await userEvent.type(screen.getByLabelText("Mã đăng nhập"), "  CODE-1234#state  ");
		await userEvent.click(screen.getByRole("button", { name: "Thêm" }));
		expect(await screen.findByText(/Đã thêm second@example.com/)).toBeTruthy();
		expect(sent.find((b) => b.case === "accountSignInCode")).toEqual(expect.objectContaining({ value: expect.objectContaining({ attemptId: "a1", code: "CODE-1234#state", provider: "claude" }) }));
		expect(added).toHaveBeenCalledOnce();
	});

	it("says when the account is already there", async () => {
		const { link } = fakeLink((b) => (b.case === "accountSignInBegin" ? prompt : { case: "accountSignInResult", value: { ok: false, error: "duplicate" } }));
		wrap(<SignInCodeDialog link={link} ai="Claude Code" provider="claude" onAdded={() => undefined} onClose={() => undefined} />);
		await userEvent.type(await screen.findByLabelText("Mã đăng nhập"), "CODE-1234#state");
		await userEvent.click(screen.getByRole("button", { name: "Thêm" }));
		expect(await screen.findByText("Tài khoản này đã có trên máy.")).toBeTruthy();
	});

	it("says to sign in on the machine when it cannot sign in from a device, naming no command that does not exist", async () => {
		const { link } = fakeLink(() => ({ case: "accountSignInResult", value: { ok: false, error: "sign-in-on-machine" } }));
		const view = wrap(<SignInCodeDialog link={link} ai="Claude Code" provider="claude" onAdded={() => undefined} onClose={() => undefined} />);
		expect(await screen.findByText(/Claude Code trên máy này không đăng nhập từ thiết bị khác được/)).toBeTruthy();
		expect(view.baseElement.textContent).not.toMatch(/tunelo claude/);
	});

	it("cancels the attempt on the machine when closed before the end", async () => {
		const closed = vi.fn();
		const { link, sent } = fakeLink((b) => (b.case === "accountSignInBegin" ? prompt : { case: "ack", value: {} }));
		wrap(<SignInCodeDialog link={link} ai="Claude Code" provider="claude" onAdded={() => undefined} onClose={closed} />);
		await screen.findByLabelText("Mã đăng nhập");
		await userEvent.click(screen.getByRole("button", { name: "Huỷ" }));
		expect(closed).toHaveBeenCalled();
		expect(sent.at(-1)).toEqual(expect.objectContaining({ case: "accountSignInCancel", value: expect.objectContaining({ attemptId: "a1" }) }));
	});

	it("cancels the attempt when closed before the machine sent the link", async () => {
		let answer: (body: Body) => void = () => undefined;
		const sent: Sent[] = [];
		const link = {
			request: (body: Body) => {
				const frame = create(FrameSchema, { body });
				sent.push(frame.body);
				if (frame.body.case !== "accountSignInBegin") return Promise.resolve(create(FrameSchema, { body: { case: "ack", value: {} } }));
				return new Promise((resolve) => (answer = (b) => resolve(create(FrameSchema, { body: b }))));
			},
		} as unknown as MachineLink;
		const view = wrap(<SignInCodeDialog link={link} ai="Claude Code" provider="claude" onAdded={() => undefined} onClose={() => undefined} />);
		await screen.findByText("Máy đang mở trang đăng nhập…");
		view.unmount();
		answer(prompt);
		await waitFor(() => expect(sent.at(-1)).toEqual(expect.objectContaining({ case: "accountSignInCancel", value: expect.objectContaining({ attemptId: "a1" }) })));
	});

	it("opens only Claude's own pages", () => {
		expect(safeSignInUrl("https://claude.ai/oauth/authorize?code=true")).toBe("https://claude.ai/oauth/authorize?code=true");
		expect(safeSignInUrl("https://claude.ai.evil.example/x")).toBeNull();
		expect(safeSignInUrl("javascript:alert(1)")).toBeNull();
		expect(safeSignInUrl("http://claude.ai/x")).toBeNull();
	});
});
