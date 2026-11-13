// The AIs a machine reported last, kept on this device for its page while the
// machine is offline: kept and read back, never trusted blindly from storage,
// and forgotten with the machine.
import { create } from "@bufbuild/protobuf";
import { MachineInfoSchema } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it } from "vitest";
import { cachedProviders, forgetProviders, rememberProviders } from "../../src/machines/link/provider-cache.ts";

afterEach(() => window.localStorage.clear());

describe("the AIs a machine reported last", () => {
	it("are kept per machine with their versions, and forgotten with it", () => {
		const info = create(MachineInfoSchema, {
			providers: [
				{ id: "claude", name: "Claude Code", version: "2.1.0", capabilities: { accounts: true } },
				{ id: "antigravity", name: "Antigravity", version: "1.5.8", untestedVersion: true },
			],
		});
		rememberProviders("7", info.providers);
		expect(cachedProviders("7")).toEqual([
			{ id: "claude", name: "Claude Code", version: "2.1.0", untested: false },
			{ id: "antigravity", name: "Antigravity", version: "1.5.8", untested: true },
		]);
		expect(cachedProviders("8")).toEqual([]);
		forgetProviders("7");
		expect(cachedProviders("7")).toEqual([]);
	});

	it("drop what storage holds that is not a list of AIs", () => {
		window.localStorage.setItem("machines:providers:1", "{not json");
		expect(cachedProviders("1")).toEqual([]);
		window.localStorage.setItem("machines:providers:1", JSON.stringify({ id: "claude" }));
		expect(cachedProviders("1")).toEqual([]);
		window.localStorage.setItem("machines:providers:1", JSON.stringify([{ id: "", name: "x", version: "1" }, { id: "a", name: 3, version: "1" }, null, { id: "b", name: "B", version: "1" }]));
		expect(cachedProviders("1")).toEqual([{ id: "b", name: "B", version: "1", untested: false }]);
	});
});
