// The shared Modal against a browser-like <dialog> (jsdom has none): it
// opens under StrictMode's double effects, Esc closes only the topmost
// dialog, a close by the browser itself reaches React, and the main dialogs
// of the chat screen open and close with Esc.
import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Modal } from "../src/messaging/ui/parts.tsx";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };
const proto = HTMLDialogElement.prototype;
const original = { showModal: proto.showModal, close: proto.close };

/** Lets queued tasks run (the browser fires a dialog's close event from a task). */
const nextTask = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

beforeAll(() => {
	// Like the browser: open at once, the close event from a later task.
	proto.showModal = function showModal(this: HTMLDialogElement) {
		this.setAttribute("open", "");
	};
	proto.close = function close(this: HTMLDialogElement) {
		if (!this.hasAttribute("open")) return;
		this.removeAttribute("open");
		setTimeout(() => this.dispatchEvent(new Event("close")), 0);
	};
});

afterAll(() => {
	proto.showModal = original.showModal;
	proto.close = original.close;
});

function Opener({ onClose }: { onClose: () => void }) {
	const [open, setOpen] = useState(false);
	const close = () => {
		onClose();
		setOpen(false);
	};
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Mở
			</button>
			{open && (
				<Modal labelledBy="t" onClose={close}>
					<h2 id="t">Hộp thử</h2>
					<button type="button">Bên trong</button>
				</Modal>
			)}
		</>
	);
}

describe("Modal", () => {
	it("stays open under StrictMode, closes with Esc and returns focus to its opener", async () => {
		const onClose = vi.fn();
		render(
			<StrictMode>
				<Opener onClose={onClose} />
			</StrictMode>,
		);
		const opener = screen.getByRole("button", { name: "Mở" });
		await userEvent.click(opener);
		const dialog = screen.getByRole("dialog", { name: "Hộp thử" });
		// The close event queued by StrictMode's first cleanup must not close it.
		await nextTask();
		expect(onClose).not.toHaveBeenCalled();
		expect(dialog.hasAttribute("open")).toBe(true);
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Bên trong" }));

		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog", { name: "Hộp thử" })).toBeNull();
		await waitFor(() => expect(document.activeElement).toBe(opener));
	});

	it("follows a close made by the browser itself", async () => {
		const onClose = vi.fn();
		render(<Opener onClose={onClose} />);
		await userEvent.click(screen.getByRole("button", { name: "Mở" }));
		const dialog = screen.getByRole("dialog", { name: "Hộp thử" });
		if (!(dialog instanceof HTMLDialogElement)) throw new Error("not a <dialog>");
		dialog.close();
		await nextTask();
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog", { name: "Hộp thử" })).toBeNull();
	});

	it("leaves an Esc that something inside already handled", async () => {
		const onClose = vi.fn();
		render(<Opener onClose={onClose} />);
		await userEvent.click(screen.getByRole("button", { name: "Mở" }));
		const inside = screen.getByRole("button", { name: "Bên trong" });
		inside.addEventListener("keydown", (event) => event.preventDefault());
		fireEvent.keyDown(inside, { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();
	});
});

describe("chat screen dialogs", () => {
	it("opens New chat and closes it with Esc, focus back on the button", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, "/");
		const list = await screen.findByRole("region", { name: "Danh sách chat" }, LONG);
		const button = within(list).getAllByRole("button", { name: "Tạo chat mới" })[0];
		if (button === undefined) throw new Error("no New chat button");
		await userEvent.click(button);
		const dialog = await screen.findByRole("dialog", { name: "Chat mới" }, LONG);
		await nextTask();
		expect(dialog.hasAttribute("open")).toBe(true);
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Chat mới" })).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(button));
	});
});
