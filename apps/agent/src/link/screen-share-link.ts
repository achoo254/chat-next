// The machine's Screen Sharing on one device's link: its status, opening a
// session on the user's tap, and the session's bytes both ways. The bytes are
// relayed as they are and never logged.
import type { MessageInitShape } from "@bufbuild/protobuf";
import { type Frame, type FrameSchema, ScreenShareEnd } from "@achoo254/chat-proto/remote/remote";
import type { ScreenShare, ScreenShareEndReason, ScreenShareSink } from "../screen-share/screen-share.ts";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;
export type ScreenShareFrame = Extract<Frame["body"], { case: "screenShareStatusRequest" | "screenShareOpen" | "screenShareData" | "screenShareClose" }>;

const END: Record<ScreenShareEndReason, ScreenShareEnd> = {
	closed: ScreenShareEnd.CLOSED,
	idle: ScreenShareEnd.IDLE,
	service: ScreenShareEnd.SERVICE,
	stopped: ScreenShareEnd.STOPPED,
};

export class ScreenShareLink {
	private readonly sink: ScreenShareSink;

	constructor(
		private readonly share: ScreenShare,
		private readonly send: (id: string, body: Body) => void,
		private readonly fail: (id: string, err: unknown) => void,
		buffered: () => number,
		private readonly device: () => string,
	) {
		this.sink = {
			data: (streamId, data) => this.send("", { case: "screenShareData", value: { streamId, data } }),
			closed: (streamId, reason) => this.send("", { case: "screenShareClosed", value: { streamId, reason: END[reason] } }),
			buffered,
		};
	}

	/** A request of the device; answered by id (or an error by id). Data is written in the order it came. */
	handle(id: string, b: ScreenShareFrame): void {
		const ack = () => this.send(id, { case: "ack", value: {} });
		switch (b.case) {
			case "screenShareStatusRequest":
				void this.share.status().then(
					(s) => this.send(id, { case: "screenShareStatus", value: s }),
					(err: unknown) => this.fail(id, err),
				);
				return;
			case "screenShareOpen":
				void this.share.open(this.sink, this.device()).then(
					(o) => this.send(id, { case: "screenShareOpened", value: { streamId: o.streamId, idleMs: o.idleMs } }),
					(err: unknown) => this.fail(id, err),
				);
				return;
			case "screenShareData":
				try {
					this.share.write(b.value.streamId, this.sink, b.value.data);
					ack();
				} catch (err) {
					this.fail(id, err);
				}
				return;
			case "screenShareClose":
				try {
					this.share.close(b.value.streamId, this.sink);
					ack();
				} catch (err) {
					this.fail(id, err);
				}
				return;
		}
	}

	/** The device's link closed: its session ends. */
	close(): void {
		this.share.drop(this.sink);
	}
}
