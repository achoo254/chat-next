// The workspace requests (Ws* of remote.proto, tunelo 2.7.0+) over the
// machine's end-to-end link, each answered by its own result frame. A
// workspace is named by the machine's project id only, never a folder.
import type { Frame, WsChanged } from "@achoo254/chat-proto/remote/remote";
import type { MachineLink } from "../link/machine-link.ts";

/** What the panel needs of a link (tests pass the real one over a fake machine). */
export type WsLink = Pick<MachineLink, "request" | "onFrame">;

type Body = Parameters<MachineLink["request"]>[0];
type Case = NonNullable<Frame["body"]["case"]>;
type ValueOf<K extends Case> = Extract<Frame["body"], { case: K }>["value"];

/** The machine answered with a frame the request does not expect (a newer or broken machine). */
export class UnexpectedAnswer extends Error {
	constructor(readonly got: string) {
		super(`unexpected answer: ${got}`);
	}
}

/** Sends `body`; resolves with the value of the answer of kind `expect`. */
export async function ask<K extends Case>(link: WsLink, body: Body, expect: K): Promise<ValueOf<K>> {
	const frame = await link.request(body);
	if (frame.body.case !== expect) throw new UnexpectedAnswer(frame.body.case ?? "none");
	return frame.body.value as ValueOf<K>;
}

/** Calls `listener` with every WsChanged of `workspaceId`; returns the unsubscribe. */
export function onWsChanged(link: WsLink, workspaceId: string, listener: (change: WsChanged) => void): () => void {
	return link.onFrame((body) => {
		if (body.case === "wsChanged" && body.value.workspaceId === workspaceId) listener(body.value);
	});
}
