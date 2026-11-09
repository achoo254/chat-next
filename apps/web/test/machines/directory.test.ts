// A machine of an old install code shows that it needs `tunelo login` until
// its tunelo signs in with the account (the directory's claimed flag).
import { create } from "@bufbuild/protobuf";
import { MachineSchema } from "@achoo254/chat-proto/machines";
import { describe, expect, it } from "vitest";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";
import { toEntry } from "../../src/machines/machines-client.ts";

describe("machine directory", () => {
	it("keeps whether the machine is tied to the account", () => {
		expect(toEntry(create(MachineSchema, { id: 3n, name: "Laptop", claimed: false })).claimed).toBe(false);
		expect(toEntry(create(MachineSchema, { id: 4n, name: "Mac", claimed: true })).claimed).toBe(true);
	});

	it("says what to do in every language: a short chip, the command in its hint", () => {
		for (const copy of [viMachines, enMachines, zhCNMachines]) {
			expect(copy.status.needsLogin.length).toBeLessThanOrEqual(16);
			expect(copy.status.needsLoginHint).toContain("tunelo login");
			expect(copy.addMachine.note.length).toBeGreaterThan(20);
		}
	});
});
