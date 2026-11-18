import { describe, expect, it } from "vitest";
import { allowedDirections, levelChanges, needsConfirm, type BridgeFeatureView, type FeatureRisk } from "../src/messaging/settings/bridge-features-model.ts";

function f(feature: string, risk: FeatureRisk, canReceive: boolean, canSend: boolean, direction: BridgeFeatureView["direction"] = "in"): BridgeFeatureView {
	return { feature, risk, direction, isDefault: true, canReceive, canSend };
}

const telegramLike = [f("messages", "r2", true, true), f("pins", "r1", true, true), f("read", "r1", true, false), f("topics", "r2", true, true), f("members", "r3", true, true, "off")];

describe("what a feature of a synced chat can be set to", () => {
	it("offers only the directions the app can do", () => {
		expect(allowedDirections(f("a", "r1", true, true))).toEqual(["off", "in", "out", "both"]);
		expect(allowedDirections(f("a", "r1", true, false))).toEqual(["off", "in"]);
		expect(allowedDirections(f("a", "r1", false, true))).toEqual(["off", "out"]);
	});

	it("sets nothing for people and groups in a quick level", () => {
		for (const level of ["readonly", "personal", "full"] as const) expect(levelChanges(telegramLike, level).has("members")).toBe(false);
	});

	it("read only brings everything in and sends nothing", () => {
		const both = telegramLike.map((x) => (x.risk === "r3" ? x : { ...x, direction: "both" as const }));
		expect(Object.fromEntries(levelChanges(both, "readonly"))).toEqual({ messages: "in", pins: "in", read: "in", topics: "in" });
	});

	it("personal sends your own state both ways and leaves what others see receiving", () => {
		expect(Object.fromEntries(levelChanges(telegramLike, "personal"))).toEqual({ pins: "both" });
	});

	it("full also sends messages and structure, clipped to what the app can do (read marks only come in)", () => {
		expect(Object.fromEntries(levelChanges(telegramLike, "full"))).toEqual({ messages: "both", pins: "both", topics: "both" });
	});

	it("asks first only when a feature that acts on people starts to send", () => {
		const members = f("members", "r3", true, true, "off");
		expect(needsConfirm(members, "both")).toBe(true);
		expect(needsConfirm(members, "out")).toBe(true);
		expect(needsConfirm(members, "in")).toBe(false);
		expect(needsConfirm({ ...members, direction: "both" }, "both")).toBe(false);
		expect(needsConfirm(f("pins", "r1", true, true), "both")).toBe(false);
	});
});
