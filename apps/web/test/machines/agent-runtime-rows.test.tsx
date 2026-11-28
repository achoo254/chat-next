// The tunelo service's status and open ports on a machine's page.
import { create } from "@bufbuild/protobuf";
import { AgentPortKind, MachineInfoSchema } from "@achoo254/chat-proto/remote/remote";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AgentRuntimeRows } from "../../src/machines/agent-runtime-rows.tsx";
import { viMachines } from "../../src/machines/copy-vi.ts";
import type { Conn } from "../../src/machines/machine-status.ts";

const NOW = Date.UTC(2026, 10, 26, 1, 0);

function show(conn: Conn, info: ReturnType<typeof create<typeof MachineInfoSchema>> | null) {
	render(
		<I18nProvider>
			<dl>
				<AgentRuntimeRows t={viMachines} conn={conn} info={info} now={NOW} />
			</dl>
		</I18nProvider>,
	);
}

const withRuntime = create(MachineInfoSchema, {
	memoryMb: 180,
	runtime: {
		pid: 4242,
		startedAt: BigInt(NOW - 2 * 3_600_000),
		ports: [
			{ kind: AgentPortKind.DEVICE_LINK, port: 51000, listening: true },
			{ kind: AgentPortKind.OBSERVATORY, port: 4318, listening: false },
			{ kind: AgentPortKind.TUNNEL_HTTP, port: 3000, listening: true, urls: ["https://dev.example.test"] },
		],
	},
});

describe("the tunelo service's rows", () => {
	it("says it runs, with its pid and memory", () => {
		show({ kind: "on" }, withRuntime);
		expect(screen.getByText("Đang chạy")).toBeTruthy();
		expect(screen.getByText(/PID 4242 · 180 MB/)).toBeTruthy();
	});

	it("says it runs for a tunelo that does not tell its process", () => {
		show({ kind: "on" }, create(MachineInfoSchema, {}));
		expect(screen.getByText("Đang chạy")).toBeTruthy();
	});

	it("shows why the machine is not connected, and no stale ports", () => {
		show({ kind: "offline", lastSeenMs: NOW - 10 * 60_000 }, withRuntime);
		expect(screen.getByText("Ngoại tuyến · 10 phút trước")).toBeTruthy();
		expect(screen.queryByText("51000")).toBeNull();
	});
});
