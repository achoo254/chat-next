// "Thêm dự án" with several online machines, for the render check
// (?at=add-project-hosts&hosts=2|3): the machine picker (side by side for
// two, a list for three), the folder browser and the recent folders. The
// second machine answers its folder list late, so a switch shows the old
// list dimmed at the same size rather than a jump.
import { create } from "@bufbuild/protobuf";
import { FrameSchema, type Frame } from "@achoo254/chat-proto/remote/remote";
import { useState } from "react";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AddAgentProjectDialog } from "../../src/machines/agent-project-dialogs.tsx";
import { AgentProjectsStore } from "../../src/machines/agent-projects-store.ts";
import type { LinkState, MachineLink } from "../../src/machines/link/machine-link.ts";
import type { Conn } from "../../src/machines/machine-status.ts";
import type { MachineView } from "../../src/machines/use-machines.ts";
import "../../src/styles/messaging.css";
import "../../src/machines/machines.css";
import { FakeAgentProjects } from "../support/fake-agent-projects.ts";

type Req = Parameters<MachineLink["request"]>[0];

const FOLDERS = ["chat-next", "localman-next", "kb-next", "hoandat-app", "shared-next", "lockin-next", "tieu-de", "scripts"];

function host(id: number, name: string, delayMs: number, suggestions: { dir: string; sessions: number }[]): MachineView {
	const home = id === 1 ? "/Users/dieuvy" : "/home/dieuvy";
	const projects = { projects: [], suggestions: suggestions.map((s) => ({ gitRemote: "", branch: "", ...s })) };
	const link = {
		request: async (req: Req): Promise<Frame> => {
			if (req.case === "dirList") {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				const path = req.value.path || `${home}/code`;
				return create(FrameSchema, { body: { case: "dirListResult", value: { path, parent: home, entries: FOLDERS.map((f, i) => ({ name: f, git: i < 5, branch: i < 5 ? "main" : "" })) } } });
			}
			return create(FrameSchema, { body: { case: "ack", value: {} } });
		},
	} as unknown as MachineLink;
	const state = { info: { agentVersion: "2.6.0", providers: [{ id: "claude", name: "Claude Code" }], home }, threads: [], projects, threadInfo: new Map(), status: { kind: "open" } } as unknown as LinkState;
	return {
		entry: { ref: String(id), id, name, os: "darwin", arch: "arm64", agentVersion: "2.6.0", claudeVersion: "", tunnelUrl: "", createdAt: 0, lastSeenAt: 0, publicKey: new Uint8Array(32) },
		link,
		state,
		conn: { kind: "on" } as Conn,
	} as unknown as MachineView;
}

export function AddProjectHosts({ count }: { count: number }) {
	const [store] = useState(() => new AgentProjectsStore(new FakeAgentProjects().api()));
	const all = [
		host(1, "Hoans-Mac-mini.local", 50, [
			{ dir: "/Users/dieuvy/code/chat-next", sessions: 12 },
			{ dir: "/Users/dieuvy/code/hoandat-app", sessions: 5 },
			{ dir: "/Users/dieuvy/code/acme-billing", sessions: 3 },
			{ dir: "/Users/dieuvy/code/acme-workspace", sessions: 1 },
		]),
		host(2, "dattqh-cloud-1 (máy chủ phòng lab)", 1200, []),
		host(3, "hoandat-pc", 300, [{ dir: "/home/dieuvy/kb-next", sessions: 2 }]),
	];
	return (
		<I18nProvider>
			<div className="app">
				<AddAgentProjectDialog store={store} machines={all.slice(0, count)} onClose={() => undefined} />
			</div>
		</I18nProvider>
	);
}
