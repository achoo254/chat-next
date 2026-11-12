// The machine directory as the screens read it: a machine with the key the
// account lists for it, the account's devices, and the copy of adding a
// machine in every language (one command, nothing to type or paste).
import { create } from "@bufbuild/protobuf";
import { AccountDeviceSchema, MachineSchema } from "@achoo254/chat-proto/machines";
import { describe, expect, it } from "vitest";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";
import { toDevice, toEntry } from "../../src/machines/machines-client.ts";

describe("machine directory", () => {
	it("keeps the machine key the account lists", () => {
		const key = new Uint8Array(32).fill(3);
		const entry = toEntry(create(MachineSchema, { id: 3n, name: "Laptop", publicKey: key, lastSeenAt: 1_800_000_000n }));
		expect(entry).toMatchObject({ ref: "3", id: 3, name: "Laptop", lastSeenAt: 1_800_000_000 });
		expect(entry.publicKey).toEqual(key);
	});

	it("reads the account's devices in seconds, with this one marked", () => {
		const device = toDevice(
			create(AccountDeviceSchema, { publicKey: new Uint8Array(32), name: "Chrome · macOS", platform: "web", createdAt: 10n, lastSeenAt: 20n, revokedAt: 0n, current: true }),
		);
		expect(device).toMatchObject({ name: "Chrome · macOS", platform: "web", createdAt: 10, lastSeenAt: 20, revokedAt: 0, current: true });
	});

	it("says in every language that adding a machine takes one command and nothing to paste", () => {
		for (const copy of [viMachines, enMachines, zhCNMachines]) {
			expect(copy.addMachine.note.length).toBeGreaterThan(20);
			expect(copy.addMachine.remote.length).toBeGreaterThan(20);
			expect(Object.keys(copy.agent.conn.blocked).sort()).toEqual(["key-changed", "machine-unsynced", "refused", "revoked", "session-revoked", "too-many-devices"]);
		}
	});
});
