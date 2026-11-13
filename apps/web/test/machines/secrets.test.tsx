// Sign-in secrets on the device: the card names the site (its domain stands
// out), the name and why; the value goes to the machine in one SecretProvide
// and leaves the page at once; "save for next time" is on unless unticked;
// declining says so. The machine's page lists what it keeps, never a value,
// and removes one. Machines without the feature show neither.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ApprovalItemSchema, Decision, FrameSchema, PromptState, SecretPromptSchema, ToolKind, type Frame } from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { ApprovalCard, secretsInCommand } from "../../src/machines/cards/approval.tsx";
import { SecretCard, originParts } from "../../src/machines/cards/secret-request.tsx";
import { SavedSecrets } from "../../src/machines/saved-secrets.tsx";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

const prompt = create(SecretPromptSchema, {
	requestId: "r1",
	threadId: "t1",
	name: "GH_PASSWORD",
	purpose: "Đăng nhập để chạy test e2e",
	origin: "https://github.com",
	expiresAt: BigInt(Date.now() + 300_000),
});

describe("the secret card", () => {
	it("shows the site, the name and why; sends the value once, saved by default, and forgets it", async () => {
		const sent: { value: string; remember: boolean }[] = [];
		const { container } = render(
			<I18nProvider>
				<SecretCard prompt={prompt} ai="Claude" onProvide={async (value, remember) => void sent.push({ value, remember })} onDecline={async () => undefined} />
			</I18nProvider>,
		);
		expect(screen.getByRole("heading", { name: "Claude cần thông tin đăng nhập" })).toBeTruthy();
		expect(screen.getByText("github.com").tagName).toBe("STRONG");
		expect(screen.getByText("GH_PASSWORD")).toBeTruthy();
		expect(screen.getByText("Đăng nhập để chạy test e2e")).toBeTruthy();
		const field = screen.getByLabelText<HTMLInputElement>("Mật khẩu hoặc token");
		expect(field.type).toBe("password");
		expect(field.autocomplete).toBe("off");
		expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /Lưu trên máy cho lần sau/ }).checked).toBe(true);

		await userEvent.type(field, "hunter2!");
		await userEvent.click(screen.getByRole("button", { name: "Hiện giá trị" }));
		expect(field.type).toBe("text");
		await userEvent.click(screen.getByRole("button", { name: "Gửi tới máy" }));
		await waitFor(() => expect(sent).toEqual([{ value: "hunter2!", remember: true }]));
		expect(field.value).toBe("");
		expect(field.type).toBe("password");
		expect(container.innerHTML).not.toContain("hunter2!");
	});

	it("sends for this session only when unticked, and declines", async () => {
		const sent: { value: string; remember: boolean }[] = [];
		let declined = 0;
		render(
			<I18nProvider>
				<SecretCard
					prompt={prompt}
					ai="Claude"
					onProvide={async (value, remember) => void sent.push({ value, remember })}
					onDecline={async () => void (declined += 1)}
				/>
			</I18nProvider>,
		);
		await userEvent.click(screen.getByRole("checkbox", { name: /Lưu trên máy cho lần sau/ }));
		await userEvent.type(screen.getByLabelText("Mật khẩu hoặc token"), "once-only{Enter}");
		await waitFor(() => expect(sent).toEqual([{ value: "once-only", remember: false }]));
		await userEvent.click(screen.getByRole("button", { name: "Từ chối" }));
		await waitFor(() => expect(declined).toBe(1));
	});

	it("says what went wrong in the user's language", async () => {
		const { RemoteError } = await import("../../src/machines/link/machine-link.ts");
		const { ErrorCode, ErrorReason } = await import("@achoo254/chat-proto/remote/remote");
		render(
			<I18nProvider>
				<SecretCard
					prompt={prompt}
					ai="Claude"
					onProvide={async () => Promise.reject(new RemoteError(ErrorCode.NOT_FOUND, "gone", ErrorReason.SECRET_PROMPT_GONE))}
					onDecline={async () => undefined}
				/>
			</I18nProvider>,
		);
		await userEvent.type(screen.getByLabelText("Mật khẩu hoặc token"), "x{Enter}");
		expect((await screen.findByRole("alert")).textContent).toMatch(/Yêu cầu này đã đóng/);
	});

	it("splits a site for showing", () => {
		expect(originParts("https://github.com")).toEqual({ scheme: "https://", host: "github.com", port: "" });
		expect(originParts("http://localhost:5173")).toEqual({ scheme: "http://", host: "localhost", port: ":5173" });
	});
});

function fakeLink(lists: { id: string; name: string; origin: string; lastUsedAt: bigint }[][]) {
	const sent: Frame["body"][] = [];
	let n = 0;
	return {
		sent,
		link: {
			request: (body: Body) => {
				sent.push(create(FrameSchema, { body }).body);
				const secrets = lists[Math.min(n++, lists.length - 1)] ?? [];
				return Promise.resolve(create(FrameSchema, { body: { case: "secretListResult", value: { secrets: secrets.map((s) => ({ ...s, createdAt: 1n })) } } }));
			},
		},
	};
}

describe("saved secrets on a machine's page", () => {
	it("lists site, name and last use, never a value, and removes one over the link", async () => {
		const gh = { id: "a1", name: "GH_PASSWORD", origin: "https://github.com", lastUsedAt: BigInt(Date.now() - 3 * 60_000) };
		const api = { id: "b2", name: "API_TOKEN", origin: "https://api.example.com", lastUsedAt: 0n };
		const { link, sent } = fakeLink([[gh, api], [api]]);
		render(
			<I18nProvider>
				<SavedSecrets link={link} online ai="Claude" />
			</I18nProvider>,
		);
		expect(await screen.findByText("GH_PASSWORD")).toBeTruthy();
		expect(screen.getByText("Chưa dùng")).toBeTruthy();
		expect(screen.getByText(/Dùng lần cuối/)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Xoá GH_PASSWORD của https://github.com" }));
		await waitFor(() => expect(screen.queryByText("GH_PASSWORD")).toBeNull());
		expect(sent).toEqual([expect.objectContaining({ case: "secretList" }), expect.objectContaining({ case: "secretRemove", value: expect.objectContaining({ id: "a1" }) })]);
	});

	it("says when the machine keeps none", async () => {
		const { link } = fakeLink([[]]);
		render(
			<I18nProvider>
				<SavedSecrets link={link} online ai="Claude" />
			</I18nProvider>,
		);
		expect(await screen.findByText("Chưa lưu bí mật nào trên máy này.")).toBeTruthy();
	});
});

describe("the approval card of a command that uses a secret", () => {
	const command = (text: string, reason = "") =>
		create(ApprovalItemSchema, { toolId: "t", kind: ToolKind.SHELL, name: "Bash", summary: text, input: JSON.stringify({ command: text }), state: PromptState.PENDING, reason });

	it("says so in the user's language, never in the machine's English, and offers no allow for the session", async () => {
		const english = "It reads a sign-in secret ($TUNELO_SECRET_…): tunelo asks you every time a command uses one.";
		const decided: Decision[] = [];
		render(
			<I18nProvider>
				<ApprovalCard hotkeys approval={command('curl -u "me:$TUNELO_SECRET_GH_PASSWORD" https://api.github.com', english)} ai="Claude" sessionAllow onDecide={async (d) => void decided.push(d)} />
			</I18nProvider>,
		);
		expect(screen.getByText(/Lệnh này dùng bí mật đăng nhập GH_PASSWORD/)).toBeTruthy();
		expect(screen.queryByText(english)).toBeNull();
		expect(screen.queryByRole("button", { name: /Cho phép trong phiên này/ })).toBeNull();
		await userEvent.keyboard("2");
		expect(decided).toEqual([]);
		await userEvent.click(screen.getByRole("button", { name: /^1?Cho phép$/ }));
		await waitFor(() => expect(decided).toEqual([Decision.ALLOW]));
	});

	it("keeps allow for the session for other commands", () => {
		render(
			<I18nProvider>
				<ApprovalCard approval={command("npm test")} ai="Claude" sessionAllow onDecide={async () => undefined} />
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: /Cho phép trong phiên này/ })).toBeTruthy();
	});

	it("finds each secret a shell command names, once", () => {
		expect(secretsInCommand(command("echo $TUNELO_SECRET_A ${TUNELO_SECRET_B} $TUNELO_SECRET_A $HOME"))).toEqual(["A", "B"]);
		expect(secretsInCommand({ ...command("echo $TUNELO_SECRET_A"), kind: ToolKind.EDIT })).toEqual([]);
	});
});
