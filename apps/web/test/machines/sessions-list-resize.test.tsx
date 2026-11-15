// The AI Agent column of sessions is resized like the chat list (the shared
// ListResizer): ←/→ and Home/End on the handle change the column's width
// within its own bounds, the width is kept on this device under its own key
// (never the chat list's), and a kept width comes back on the next visit.
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { ListResizer } from "../../src/messaging/ui/list-resizer.tsx";

const KEY = "ai:list-width";

function Column() {
	const grid = useRef<HTMLDivElement>(null);
	return (
		<div className="mx" ref={grid} data-testid="grid">
			<section className="mx-list" />
			<ListResizer app={grid} list=":scope > .mx-list" storageKey={KEY} min={260} max={640} label="Độ rộng danh sách phiên" className="mx-list-resize" />
		</div>
	);
}

const show = () =>
	render(
		<I18nProvider>
			<Column />
		</I18nProvider>,
	);

afterEach(() => window.localStorage.clear());

describe("the session column's width", () => {
	it("moves with the keys within its own bounds and is kept under its own key", async () => {
		show();
		const handle = await screen.findByRole("separator", { name: "Độ rộng danh sách phiên" });
		expect(handle.getAttribute("aria-valuemin")).toBe("260");
		expect(handle.getAttribute("aria-valuemax")).toBe("640");
		fireEvent.keyDown(handle, { key: "End" });
		expect(screen.getByTestId("grid").style.getPropertyValue("--list-w")).toBe("640px");
		expect(window.localStorage.getItem(KEY)).toBe("640");
		fireEvent.keyDown(handle, { key: "ArrowLeft" });
		expect(window.localStorage.getItem(KEY)).toBe("630");
		fireEvent.keyDown(handle, { key: "Home" });
		expect(window.localStorage.getItem(KEY)).toBe("260");
		// The chat list keeps its own width.
		expect(window.localStorage.getItem("chat:list-width")).toBeNull();
	});

	it("comes back at the width kept, clamped to its bounds", async () => {
		window.localStorage.setItem(KEY, "900");
		show();
		await screen.findByRole("separator", { name: "Độ rộng danh sách phiên" });
		expect(screen.getByTestId("grid").style.getPropertyValue("--list-w")).toBe("640px");
	});
});
