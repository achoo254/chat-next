// Advisor on the demo machine of the visual harness (tunelo 3.13.0+): one
// Advisor thread per folder and AI (ThreadCreate{kind: ADVISOR}); each
// question (ThreadSend with its client_msg_id) runs a turn that answers a
// moment later with the AI's text and Advisor's verdict, as the machine
// journals them; ThreadInterrupt stops the question it names. The e2e spec
// reads what the device sent as window.__fakeAdvisor.
import { Role, ThreadKind, ThreadState, TurnState, type Frame, type ThreadSend } from "@achoo254/chat-proto/remote/remote";
import type { Body, FakeMachine, FakeSocket } from "../machines/fake-machine.ts";

/** The option Advisor picks in the demo. */
export const DEMO_PICK = "Rebase lên origin/main rồi push lại";

export class FakeAdvisor {
	/** The questions the device sent, in order. */
	readonly sends: ThreadSend[] = [];
	readonly threads = new Map<string, string>();
	private seq = 100n;
	/** When each item was first made: a later revision keeps its place (Item.at). */
	private readonly made = new Map<string, bigint>();

	constructor(private readonly machine: FakeMachine) {}

	private items(threadId: string, items: unknown[]): Body {
		return { case: "threadItems", value: { threadId, items: items as never, cursor: { epoch: 1n, seq: this.seq } } };
	}

	private item(id: string, body: unknown): unknown {
		this.seq += 1n;
		const at = this.made.get(id) ?? BigInt(Date.now()) * 1000n + this.seq;
		this.made.set(id, at);
		return { id, seq: this.seq, revision: Number(this.seq), at, body };
	}

	/** Answers an Advisor request; undefined for any other frame. */
	handle(frame: Frame, socket: FakeSocket): Body[] | undefined {
		const b = frame.body;
		if (b.case === "threadCreate" && b.value.kind === ThreadKind.ADVISOR) {
			const key = `${b.value.dir}\n${b.value.provider}`;
			const id = this.threads.get(key) ?? `advisor-${this.threads.size + 1}`;
			this.threads.set(key, id);
			return [{ case: "threadCreated", value: { thread: { id, kind: ThreadKind.ADVISOR, dir: b.value.dir, provider: b.value.provider, archived: true, state: ThreadState.IDLE } } }];
		}
		if (b.case === "threadSend" && [...this.threads.values()].includes(b.value.threadId)) {
			const { threadId, clientMsgId, text } = b.value;
			this.sends.push(b.value);
			const turnId = `turn-${clientMsgId}`;
			const turn = (state: TurnState) => this.item(turnId, { case: "turn", value: { state, clientMsgId } });
			setTimeout(() => {
				this.machine.send(socket, this.items(threadId, [this.item(`u-${clientMsgId}`, { case: "text", value: { role: Role.USER, text, clientMsgId } }), turn(TurnState.RUNNING)]));
			}, 50);
			setTimeout(() => {
				this.machine.send(
					socket,
					this.items(threadId, [
						this.item(`a-${clientMsgId}`, { case: "text", value: { role: Role.ASSISTANT, text: "Nhánh main trên máy đi sau origin/main 1 commit, nên push bị từ chối." } }),
						this.item(`v-${clientMsgId}`, {
							case: "advisorVerdict",
							value: {
								toolId: `tool-${clientMsgId}`,
								turnId,
								kind: "answer",
								question: "Sửa lỗi push bị từ chối thế nào?",
								options: [
									{ text: DEMO_PICK, probability: 0.82 },
									{ text: "git push --force", probability: 0.18 },
								],
								context: "! [rejected] main -> main (fetch first)",
								confidence: 0.8,
								verdict: "confident",
								error: "",
							},
						}),
						turn(TurnState.COMPLETED),
					]),
				);
			}, 600);
			return [{ case: "ack", value: {} }];
		}
		if (b.case === "threadInterrupt" && [...this.threads.values()].includes(b.value.threadId)) return [{ case: "ack", value: {} }];
		return undefined;
	}
}
