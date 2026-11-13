// The Claude accounts of a machine on its page: the list with the account in
// use and last usage, picking and removing one, and adding one with the code
// of the sign-in page (only a Claude page opens; a machine that cannot sign
// in from a device shows the command to run on it; closing cancels).
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { AccountStatus, FrameSchema, type Frame } from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { ClaudeProfiles } from "../../src/machines/claude-profiles.tsx";
import type { MachineLink } from "../../src/machines/link/machine-link.ts";
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
		selectedByProvider: { claude: "" },
		actions: [{ provider: "claude", signIn: true, usage: true }],
		accounts: [
			{ provider: "claude", id: "", email: "owner@example.com", organization: "Org", plan: "max", status: AccountStatus.OK, usage: { fiveHour: { utilization: 30 }, sevenDay: { utilization: 55 } }, usageUpdatedAt: BigInt(Date.UTC(2026, 10, 8, 7, 0)) },
			{ provider: "claude", id: "p2", email: "second@example.com", organization: "Org", plan: "pro", status: AccountStatus.OK, createdAt: 1n },
		],
	},
};

describe("Claude accounts of a machine", () => {
	it("lists the accounts with the one in use and their last usage, and picks another", async () => {
		const { link, sent } = fakeLink(() => LIST);
		wrap(<ClaudeProfiles link={link} online ai="Claude Code" provider="claude" announced={null} />);
		const owner = await screen.findByText("owner@example.com");
		const row = owner.closest("li") as HTMLElement;
		expect(within(row).getByText("Đang dùng")).toBeTruthy();
		expect(within(row).getByText(/5 giờ 30% · tuần 55%/)).toBeTruthy();
		const second = screen.getByText("second@example.com").closest("li") as HTMLElement;
		expect(within(second).getByText("Chưa rõ hạn mức")).toBeTruthy();
		await userEvent.click(within(second).getByRole("button", { name: "Dùng cho cả máy" }));
		await waitFor(() => expect(sent.at(-1)).toEqual(expect.objectContaining({ case: "accountSelect", value: expect.objectContaining({ provider: "claude", id: "p2" }) })));
		await userEvent.click(within(row).getByRole("button", { name: "Làm mới hạn mức" }));
		await waitFor(() => expect(sent.at(-1)).toEqual(expect.objectContaining({ case: "usageRefresh", value: expect.objectContaining({ id: "", provider: "claude" }) })));
	});

	it("marks an added account that needs to sign in again, with when its sign-in ended", async () => {
		const ended = Date.UTC(2026, 10, 1, 7, 0);
		const { link } = fakeLink(() => ({
			case: "accountListResult",
			value: {
				selectedByProvider: {},
				accounts: [
					{ provider: "claude", id: "", email: "", status: AccountStatus.NEEDS_SIGN_IN },
					{ provider: "claude", id: "p2", email: "second@example.com", status: AccountStatus.NEEDS_SIGN_IN, loginExpiresAt: BigInt(ended) },
					{ provider: "claude", id: "p3", email: "third@example.com", status: AccountStatus.OK, loginExpiresAt: BigInt(Date.now() + 86_400_000) },
				],
			},
		}));
		wrap(<ClaudeProfiles link={link} online ai="Claude Code" provider="claude" announced={null} />);
		const second = (await screen.findByText("second@example.com")).closest("li") as HTMLElement;
		expect(within(second).getByText("Cần đăng nhập lại")).toBeTruthy();
		expect(within(second).getByText(/đăng nhập đã hết hạn lúc/)).toBeTruthy();
		expect((within(second).getByRole("button", { name: "Dùng cho cả máy" }) as HTMLButtonElement).disabled).toBe(true);
		expect((within(second).getByRole("button", { name: "Làm mới hạn mức" }) as HTMLButtonElement).disabled).toBe(false);
		const third = screen.getByText("third@example.com").closest("li") as HTMLElement;
		expect(within(third).queryByText("Cần đăng nhập lại")).toBeNull();
		expect(within(third).getByText(/đăng nhập tới/)).toBeTruthy();
		expect(screen.getByText("Chưa đăng nhập")).toBeTruthy();
	});

	it("removes an added account after confirming, never the default one", async () => {
		const { link, sent } = fakeLink(() => LIST);
		wrap(<ClaudeProfiles link={link} online ai="Claude Code" provider="claude" announced={null} />);
		const owner = (await screen.findByText("owner@example.com")).closest("li") as HTMLElement;
		expect(within(owner).queryByRole("button", { name: "Xoá" })).toBeNull();
		const second = screen.getByText("second@example.com").closest("li") as HTMLElement;
		await userEvent.click(within(second).getByRole("button", { name: "Xoá" }));
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Xoá" }));
		await waitFor(() => expect(sent.at(-1)).toEqual(expect.objectContaining({ case: "accountRemove", value: expect.objectContaining({ provider: "claude", id: "p2" }) })));
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

	it("shows the command to run on the machine when it cannot sign in from a device", async () => {
		const { link } = fakeLink(() => ({ case: "accountSignInResult", value: { ok: false, error: "sign-in-on-machine" } }));
		wrap(<SignInCodeDialog link={link} ai="Claude Code" provider="claude" onAdded={() => undefined} onClose={() => undefined} />);
		expect(await screen.findByText("tunelo claude profiles add")).toBeTruthy();
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
