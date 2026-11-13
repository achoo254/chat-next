// Moving projects in the sidebar: the new order a drop or "Lên trên"/"Xuống
// dưới" gives, shown at once and back to the server's on a refusal, and a
// finger that must hold still before it drags (moving at once scrolls).
import { act, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProjectsStore } from "../../src/machines/agent-projects-store.ts";
import { HOLD_MS, movedTo, useProjectDrag } from "../../src/machines/project-drag.ts";
import { FakeAgentProjects } from "../support/fake-agent-projects.ts";

describe("the order after a move", () => {
	it("puts the project before the one at the index, or last", () => {
		expect(movedTo([1, 2, 3, 4], 1, 3)).toEqual([2, 3, 1, 4]);
		expect(movedTo([1, 2, 3, 4], 4, 0)).toEqual([4, 1, 2, 3]);
		expect(movedTo([1, 2, 3, 4], 2, 4)).toEqual([1, 3, 4, 2]);
		expect(movedTo([1, 2, 3, 4], 3, 3)).toEqual([1, 2, 3, 4]);
		expect(movedTo([1, 2, 3, 4], 3, 2)).toEqual([1, 2, 3, 4]);
	});
});

describe("reordering in the store", () => {
	it("shows the new order at once, then keeps the server's", async () => {
		const server = new FakeAgentProjects();
		const [a, , c] = [server.seed("a"), server.seed("b"), server.seed("c")];
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		const done = store.reorder([c.id, a.id]);
		expect(store.snapshot().projects.map((p) => p.name)).toEqual(["c", "a", "b"]);
		await done;
		expect(store.snapshot().projects.map((p) => p.name)).toEqual(["c", "a", "b"]);
		expect(server.list().map((p) => p.name)).toEqual(["c", "a", "b"]);
	});

	it("a refusal brings the server's order back", async () => {
		const server = new FakeAgentProjects();
		const [a, b] = [server.seed("a"), server.seed("b")];
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		await expect(store.reorder([b.id, a.id, 999])).rejects.toBeTruthy();
		expect(store.snapshot().projects.map((p) => p.name)).toEqual(["a", "b"]);
	});
});

function List({ onDrop }: { onDrop: (ids: number[]) => void }) {
	const ref = useRef<HTMLDivElement>(null);
	const { drag, onPointerDown } = useProjectDrag(ref, [1, 2], true, onDrop);
	return (
		<div ref={ref} onPointerDown={onPointerDown} data-drag-id={drag?.id ?? ""}>
			{[1, 2].map((id) => (
				<div key={id} data-project-id={id}>
					<div className="mx-project-head">
						<button type="button">{`p${id}`}</button>
						<span className="mx-row-menu">
							<button type="button">⋮</button>
						</span>
					</div>
				</div>
			))}
		</div>
	);
}

describe("dragging with a finger", () => {
	afterEach(() => vi.useRealTimers());

	const setup = () => {
		const onDrop = vi.fn();
		const { container } = render(<List onDrop={onDrop} />);
		const root = container.firstElementChild as HTMLElement;
		root.querySelectorAll<HTMLElement>("[data-project-id]").forEach((row, i) => (row.getBoundingClientRect = () => ({ top: i * 100, height: 80, bottom: i * 100 + 80 }) as DOMRect));
		const head = root.querySelector<HTMLElement>("[data-project-id='1'] button");
		if (head === null) throw new Error("no row");
		return { onDrop, root, head };
	};

	it("held still, then moved: a drop", () => {
		vi.useFakeTimers();
		const { onDrop, root, head } = setup();
		fireEvent.pointerDown(head, { button: 0, pointerId: 7, pointerType: "touch", clientX: 5, clientY: 10 });
		act(() => vi.advanceTimersByTime(HOLD_MS));
		expect(root.dataset.dragId).toBe("1");
		fireEvent.pointerMove(window, { pointerId: 7, clientX: 5, clientY: 170 });
		fireEvent.pointerUp(window, { pointerId: 7 });
		expect(onDrop).toHaveBeenCalledWith([2, 1]);
	});

	it("moved at once: a scroll, no drag", () => {
		vi.useFakeTimers();
		const { onDrop, root, head } = setup();
		fireEvent.pointerDown(head, { button: 0, pointerId: 7, pointerType: "touch", clientX: 5, clientY: 10 });
		fireEvent.pointerMove(window, { pointerId: 7, clientX: 5, clientY: 60 });
		act(() => vi.advanceTimersByTime(HOLD_MS));
		expect(root.dataset.dragId).toBe("");
		fireEvent.pointerUp(window, { pointerId: 7 });
		expect(onDrop).not.toHaveBeenCalled();
	});

	it("a press on the row's menu is never a drag", () => {
		vi.useFakeTimers();
		const { onDrop, root } = setup();
		const menu = root.querySelector<HTMLElement>(".mx-row-menu button");
		if (menu === null) throw new Error("no menu");
		fireEvent.pointerDown(menu, { button: 0, pointerId: 7, pointerType: "touch", clientX: 5, clientY: 10 });
		act(() => vi.advanceTimersByTime(HOLD_MS));
		expect(root.dataset.dragId).toBe("");
		expect(onDrop).not.toHaveBeenCalled();
	});
});
