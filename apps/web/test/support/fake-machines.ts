// In-memory MachinesService for tests and the visual harness: the user's
// machine directory, empty unless a test adds machines, the account's
// devices (registered with a real proof of the key, as the server checks it),
// and the user's AI Agent projects beside it (fake-agent-projects.ts). Never
// imported by production code.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { AccountDeviceSchema, MachineSchema, MachinesService, type AccountDevice, type Machine } from "@achoo254/chat-proto/machines";
import { equal, generateKeyPair, proveKeyPossession, random, type KeyPair } from "@achoo254/chat-remote-protocol";
import { FakeAgentProjects } from "./fake-agent-projects.ts";

/** A refusal RegisterDevice answers once, as the server words it. */
export type RegisterRefusal = "device_revoked" | "device_key_in_use" | "session_devices_revoked" | "too_many_devices";

const REFUSAL_CODE: Readonly<Record<RegisterRefusal, Code>> = {
	device_revoked: Code.PermissionDenied,
	device_key_in_use: Code.FailedPrecondition,
	session_devices_revoked: Code.PermissionDenied,
	too_many_devices: Code.ResourceExhausted,
};

export class FakeMachines {
	machines: Machine[] = [];
	devices: AccountDevice[] = [];
	/** Registrations that reached the service (proof checked), in order. */
	readonly registrations: Uint8Array[] = [];
	/** Answers to the next RegisterDevice calls, one each, before the normal answer. */
	readonly refuse: RegisterRefusal[] = [];
	/** The key this session registered; devices with it list as "current". */
	private currentKey: Uint8Array | null = null;
	private serverKey: Promise<KeyPair> | null = null;
	/** The user's projects; a removed machine's workspaces list with machine 0. */
	readonly projects = new FakeAgentProjects((id) => this.machines.some((m) => Number(m.id) === id));

	add(fields: Partial<Omit<Machine, "$typeName">>): Machine {
		const machine = create(MachineSchema, { id: BigInt(this.machines.length + 1), name: "Mac mini", os: "darwin", arch: "arm64", ...fields });
		this.machines.push(machine);
		return machine;
	}

	addDevice(fields: Partial<Omit<AccountDevice, "$typeName">>): AccountDevice {
		const device = create(AccountDeviceSchema, { publicKey: random(32), name: "Chrome · Windows", platform: "web", createdAt: 1_700_000_000n, ...fields });
		this.devices.push(device);
		return device;
	}

	routes(router: ConnectRouter): void {
		this.projects.routes(router);
		const find = (id: bigint) => {
			const machine = this.machines.find((m) => m.id === id);
			if (machine === undefined) throw new ConnectError("machine not found", Code.NotFound);
			return machine;
		};
		const server = () => (this.serverKey ??= generateKeyPair());
		router.service(MachinesService, {
			listMachines: () => ({ machines: this.machines }),
			renameMachine: (req) => {
				const machine = find(req.machineId);
				machine.name = req.name;
				return { machine };
			},
			revokeMachine: (req) => {
				find(req.machineId);
				this.machines = this.machines.filter((m) => m.id !== req.machineId);
				return {};
			},
			getDeviceKeyChallenge: async () => ({
				challenge: { serverKey: (await server()).publicKey, nonce: random(32), expiresAt: BigInt(Math.floor(Date.now() / 1000) + 120) },
			}),
			registerDevice: async (req) => {
				const challenge = req.proof?.challenge;
				if (challenge === undefined) throw new ConnectError("bad_key_proof: no proof", Code.PermissionDenied);
				// X25519 is symmetric: the server's half of the challenge and the device's public key give the same mac.
				const expected = await proveKeyPossession((await server()).privateKey, { serverKey: req.publicKey, nonce: challenge.nonce });
				if (!equal(expected, req.proof?.mac ?? new Uint8Array(0))) throw new ConnectError("bad_key_proof: the proof does not check", Code.PermissionDenied);
				const refusal = this.refuse.shift();
				if (refusal !== undefined) throw new ConnectError(`${refusal}: refused by the test`, REFUSAL_CODE[refusal]);
				this.registrations.push(req.publicKey);
				this.currentKey = req.publicKey;
				let device = this.devices.find((d) => equal(d.publicKey, req.publicKey));
				if (device === undefined) device = this.addDevice({ publicKey: req.publicKey, name: req.name, platform: req.platform });
				device.name = req.name;
				device.platform = req.platform;
				return { device };
			},
			listDevices: () => ({
				devices: this.devices.map((d) => create(AccountDeviceSchema, { ...d, current: this.currentKey !== null && equal(d.publicKey, this.currentKey) })),
			}),
			revokeDevice: (req) => {
				const device = this.devices.find((d) => equal(d.publicKey, req.devicePublicKey));
				if (device === undefined) throw new ConnectError("device not found", Code.NotFound);
				if (device.revokedAt === 0n) device.revokedAt = BigInt(Math.floor(Date.now() / 1000));
				return {};
			},
		});
	}
}
