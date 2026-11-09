// The AI Agent column names what each entry does in the AI Agent context:
// managing the machines, the sessions on one machine, its settings; no
// leftover of the old "Máy" navigation entry.
import { describe, expect, it } from "vitest";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";

describe("AI Agent navigation copy", () => {
	it("says Manage machines, Sessions on this machine and Machine settings in every language", () => {
		const pick = (c: typeof viMachines) => [c.agent.machines, c.agent.machinesTitle, c.agent.machineBoard, c.agent.info];
		expect(pick(viMachines)).toEqual(["Quản lý máy", "Quản lý máy", "Phiên trên máy này", "Cài đặt máy"]);
		expect(pick(enMachines)).toEqual(["Manage machines", "Manage machines", "Sessions on this machine", "Machine settings"]);
		expect(pick(zhCNMachines)).toEqual(["管理设备", "管理设备", "此设备上的会话", "设备设置"]);
		expect(viMachines.agent.infoOf("Mac mini")).toBe("Cài đặt máy Mac mini");
		expect(enMachines.agent.machineBoardOf("Mac mini")).toBe("Sessions on Mac mini");
	});

	it("points to Machine settings, not to an old machine page", () => {
		for (const c of [viMachines, enMachines, zhCNMachines]) {
			expect(c.agent.account.manage).not.toMatch(/trang máy|machine's page|电脑页面/);
			expect(c.diskAccess.sessionHint).not.toMatch(/trang máy|machine's page|电脑页面/);
		}
	});
});
