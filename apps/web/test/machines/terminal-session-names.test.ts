import { describe, expect, it } from "vitest";
import { openedTime } from "../../src/terminal/new-tab-actions.ts";

describe("when a session on the machine was opened", () => {
	it("says the time today, and the day too for an older one", () => {
		const now = new Date(2026, 10, 12, 21, 30).getTime();
		const today = openedTime(new Date(2026, 10, 12, 9, 5).getTime(), now);
		expect(today).toMatch(/09.05/);
		expect(today).not.toMatch(/12/);
		const older = openedTime(new Date(2026, 10, 10, 9, 5).getTime(), now);
		expect(older).toMatch(/10/);
		expect(older).toMatch(/09.05/);
	});
});
