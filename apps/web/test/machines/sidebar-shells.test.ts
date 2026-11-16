// Placing a machine's shells under its workspaces in the AI Agent column:
// the deepest workspace holding the shell's folder wins, AI CLIs, ended
// shells and shells outside every workspace stay out, Windows folders
// compare without case and with either separator.
import { create } from "@bufbuild/protobuf";
import { TermSessionInfoSchema } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { placeShells } from "../../src/machines/sidebar-shells.tsx";

const shell = (session: number, cwd: string, extra: { threadId?: string; exited?: boolean; createdAt?: bigint } = {}) => create(TermSessionInfoSchema, { session, cwd, createdAt: extra.createdAt ?? BigInt(session), threadId: extra.threadId ?? "", exited: extra.exited ?? false });
const ids = (placed: Map<number, { session: number }[]>, id: number) => (placed.get(id) ?? []).map((s) => s.session);

describe("placeShells", () => {
	const workspaces = [
		{ id: 1, dir: "/w/app" },
		{ id: 2, dir: "/w/app/packages/core" },
	];

	it("puts each shell under the deepest workspace holding its folder, newest first", () => {
		const placed = placeShells(workspaces, [shell(1, "/w/app"), shell(2, "/w/app/apps/web"), shell(3, "/w/app/packages/core/src")], false);
		expect(ids(placed, 1)).toEqual([2, 1]);
		expect(ids(placed, 2)).toEqual([3]);
	});

	it("leaves out AI CLIs, ended shells, shells with no folder and folders outside every workspace", () => {
		const placed = placeShells(workspaces, [shell(1, "/w/app", { threadId: "t1" }), shell(2, "/w/app", { exited: true }), shell(3, ""), shell(4, "/w/application"), shell(5, "/tmp")], false);
		expect(placed.size).toBe(0);
	});

	it("compares Windows folders without case, with either separator and a trailing one", () => {
		const placed = placeShells([{ id: 7, dir: "D:\\Work\\App\\" }], [shell(1, "d:/work/app/web"), shell(2, "D:\\WORK\\APP")], true);
		expect(ids(placed, 7)).toEqual([2, 1]);
		// Case matters elsewhere.
		expect(placeShells([{ id: 7, dir: "/w/App" }], [shell(1, "/w/app")], false).size).toBe(0);
	});
});
