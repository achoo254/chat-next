// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { flashRow } from "../src/messaging/ui/focus-flash.ts";

function row(): HTMLElement {
	const element = document.createElement("div");
	element.className = "msg";
	document.body.append(element);
	return element;
}

describe("flashRow", () => {
	it("marks the row and clears the mark when its own fade ends", () => {
		const element = row();
		flashRow(element);
		expect(element.classList.contains("flash")).toBe(true);
		element.dispatchEvent(new Event("animationend"));
		expect(element.classList.contains("flash")).toBe(false);
	});

	it("keeps the mark while an animation of something inside the row ends", () => {
		const element = row();
		const inner = document.createElement("span");
		element.append(inner);
		flashRow(element);
		inner.dispatchEvent(new Event("animationend", { bubbles: true }));
		expect(element.classList.contains("flash")).toBe(true);
	});

	it("plays again for a second jump to the same row", () => {
		const element = row();
		flashRow(element);
		element.dispatchEvent(new Event("animationend"));
		flashRow(element);
		expect(element.classList.contains("flash")).toBe(true);
	});
});
