// In-memory MachinesService for tests and the visual harness: the user's
// machine directory, empty unless a test adds machines. Never imported by
// production code.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { MachineSchema, MachinesService, type Machine } from "@achoo254/chat-proto/machines";

export class FakeMachines {
	machines: Machine[] = [];

	add(fields: Partial<Omit<Machine, "$typeName">>): Machine {
		const machine = create(MachineSchema, { id: BigInt(this.machines.length + 1), name: "Mac mini", os: "darwin", arch: "arm64", claimed: true, ...fields });
		this.machines.push(machine);
		return machine;
	}

	routes(router: ConnectRouter): void {
		const find = (id: bigint) => {
			const machine = this.machines.find((m) => m.id === id);
			if (machine === undefined) throw new ConnectError("machine not found", Code.NotFound);
			return machine;
		};
		router.service(MachinesService, {
			createInstallCode: () => {
				throw new ConnectError("install_codes_retired: update tunelo", Code.FailedPrecondition);
			},
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
			revokeDevice: (req) => {
				find(req.machineId);
				return {};
			},
		});
	}
}
