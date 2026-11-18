// Opening the office (the tab, a reload, coming back to it) shows everyone
// already there at their place; only someone who came in after it opened
// walks in from the lobby door.
import { describe, expect, it } from "vitest";
import { cameInAfterOpening } from "../../src/office-3d/character/office-people.ts";

const OPENED = 1_000_000;

function employee(enteredAt: number): Parameters<typeof cameInAfterOpening>[0] {
	return { kind: "employee", actor: { enteredAt }, member: null };
}

describe("who walks in", () => {
	it("nobody before the office was seen live, whatever their entry", () => {
		expect(cameInAfterOpening(employee(OPENED + 5_000), { clockOffset: 0 }, null)).toBe(false);
		expect(cameInAfterOpening({ kind: "chairman", actor: null, member: null }, { clockOffset: 0 }, null)).toBe(false);
	});

	it("an employee who entered before the tab opened is already there", () => {
		expect(cameInAfterOpening(employee(OPENED - 60_000), { clockOffset: 0 }, OPENED)).toBe(false);
		// The machine's clock runs 10 s behind the viewer's: entered 5 s (viewer) after opening.
		expect(cameInAfterOpening(employee(OPENED - 5_000), { clockOffset: 10_000 }, OPENED)).toBe(true);
	});

	it("an employee who came in after it opened walks in, and so does the chairman showing up later", () => {
		expect(cameInAfterOpening(employee(OPENED + 3_000), { clockOffset: 0 }, OPENED)).toBe(true);
		expect(cameInAfterOpening({ kind: "chairman", actor: null, member: null }, { clockOffset: 0 }, OPENED)).toBe(true);
	});

	it("the director and Advisor never walk in, nor an off-duty resident with no entry known", () => {
		expect(cameInAfterOpening({ kind: "director", actor: null, member: null }, { clockOffset: 0 }, OPENED)).toBe(false);
		expect(cameInAfterOpening({ kind: "advisor", actor: null, member: null }, { clockOffset: 0 }, OPENED)).toBe(false);
		expect(cameInAfterOpening({ kind: "employee", actor: null, member: null }, { clockOffset: 0 }, OPENED)).toBe(false);
	});
});
