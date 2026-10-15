// A dialog whose code has not arrived yet opens at once as a shell (title,
// close button, the shared delayed loader): Esc closes it, and its content
// takes the shell's place when the chunk is in.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

// The create-dialogs chunk loads only when the test lets it.
const chunk = vi.hoisted(() => {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { gate, release: () => release() };
});

vi.mock("../src/messaging/ui/create-dialogs.tsx", async (importOriginal) => {
	await chunk.gate;
	return importOriginal();
});

describe("dialog shell", () => {
	it("opens Chat mới at once, closes with Esc while loading, then shows the content", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture);
		const plus = (await screen.findAllByRole("button", { name: "Tạo chat mới" }, LONG))[0] as HTMLElement;

		await userEvent.click(plus);
		const shell = screen.getByRole("dialog", { name: "Chat mới" });
		expect(within(shell).queryByRole("searchbox")).toBeNull();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		await userEvent.click(plus);
		expect(screen.getByRole("dialog", { name: "Chat mới" })).toBeTruthy();
		chunk.release();
		const search = await screen.findByRole("searchbox", { name: "Tìm người" }, LONG);
		expect(search.closest("dialog")?.getAttribute("aria-labelledby")).not.toMatch(/^dlg-shell/);
		expect(screen.getAllByRole("dialog")).toHaveLength(1);
	});
});
