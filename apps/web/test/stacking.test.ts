// What the user opens on purpose (the message menu, the chat list's row menu, a link's menu, menus anchored to a
// button, the emoji picker) stays above Advisor's floating mascot, its line and its bubble, which float over the page.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const messaging = css("../src/styles/messaging.css");
const emoji = css("../src/styles/emoji-picker.css");
const advisor = css("../src/advisor/advisor.css");

/** The z-index of the first rule whose selector is exactly `selector`. */
function zIndexOf(sheet: string, selector: string): number {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*?z-index:\\s*(\\d+)`).exec(sheet);
	if (match === null) throw new Error(`no z-index for ${selector}`);
	return Number(match[1]);
}

describe("stacking of menus over Advisor's mascot", () => {
	it("keeps every menu and picker above the mascot, its flash, bubble and menu", () => {
		const advisorTop = Math.max(...[".adv-mascot", ".adv-flash", ".adv-bubble"].map((s) => zIndexOf(advisor, s)));
		const menus = [".ctx-layer", ".ctx-pop", ".list-menu", ".entity-menu", ".menu-anchor .menu", ".menu-anchor .menu.attach-menu", ".qa-menu"].map((s) => zIndexOf(messaging, s));
		for (const z of [...menus, zIndexOf(emoji, ".composer .emoji-pop")]) expect(z).toBeGreaterThan(advisorTop);
		expect(advisor).toMatch(/z-index: 47/);
		expect(Math.min(...menus)).toBeGreaterThan(47);
	});
});
