// The softer sleeping pose: a sleeper's head, neck and upper arms turn part of the way back to their rest rotation.
import { Axis } from "@babylonjs/core/Maths/math.axis";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { describe, expect, it } from "vitest";
import { SLEEP_KEEP, SLEEP_SOFTENED_BONES, softenTowardRest } from "../../src/office-3d/character/sleep-softening.ts";

const angleOf = (q: Quaternion): number => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
const quarterTurn = (): Quaternion => Quaternion.RotationAxis(Axis.X, Math.PI / 2);

describe("sleep softening", () => {
	it("keeps the given share of the clip's turn", () => {
		const rest = Quaternion.Identity();
		const posed = quarterTurn();
		expect(angleOf(softenTowardRest(rest, posed, 0.5, new Quaternion()))).toBeCloseTo(Math.PI / 4, 5);
		expect(angleOf(softenTowardRest(rest, posed, 1, new Quaternion()))).toBeCloseTo(Math.PI / 2, 5);
		expect(angleOf(softenTowardRest(rest, posed, 0, new Quaternion()))).toBeCloseTo(0, 5);
	});

	it("turns about the clip's own axis and stays a unit rotation", () => {
		const out = softenTowardRest(Quaternion.Identity(), quarterTurn(), SLEEP_KEEP, new Quaternion());
		expect(out.length()).toBeCloseTo(1, 6);
		expect(out.y).toBeCloseTo(0, 6);
		expect(out.z).toBeCloseTo(0, 6);
		expect(out.x).toBeGreaterThan(0);
	});

	it("measures from the rest rotation, not from the identity", () => {
		const rest = Quaternion.RotationAxis(Axis.Y, Math.PI / 2);
		const out = softenTowardRest(rest, rest.clone(), SLEEP_KEEP, new Quaternion());
		expect(out.equalsWithEpsilon(rest, 1e-6)).toBe(true);
	});

	it("clamps a share outside 0 to 1", () => {
		const posed = quarterTurn();
		expect(angleOf(softenTowardRest(Quaternion.Identity(), posed, 3, new Quaternion()))).toBeCloseTo(Math.PI / 2, 5);
		expect(angleOf(softenTowardRest(Quaternion.Identity(), posed, -1, new Quaternion()))).toBeCloseTo(0, 5);
	});

	it("softens the head, the neck and both upper arms, by half", () => {
		expect([...SLEEP_SOFTENED_BONES].sort()).toEqual(["head", "neck_01", "upperarm_l", "upperarm_r"]);
		expect(SLEEP_KEEP).toBe(0.5);
	});
});
