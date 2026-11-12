// A paired device on a running Machine's real WebSocket, recording every
// frame it gets (for tests of what the machine sends devices unasked).
import { type MessageInitShape, create } from "@bufbuild/protobuf";
import { type Frame, FrameSchema } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, startHandshake } from "@achoo254/chat-remote-protocol";
import { WebSocket } from "ws";
import type { Machine } from "../../src/machine.ts";

export type Device = { frames: Frame[]; request(id: string, body: NonNullable<MessageInitShape<typeof FrameSchema>["body"]>): void; close(): void };

/** A paired device on the machine's real WebSocket, recording every frame it gets. */
export async function connectDevice(machine: Machine, port: number, name: string): Promise<Device> {
  const key = await generateKeyPair();
  machine.config.addDevice(key.publicKey, name);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  ws.on("message", (d: Buffer) => {
    inbox.push(new Uint8Array(d));
    wake?.();
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = async (): Promise<Uint8Array> => {
    for (;;) {
      const d = inbox.shift();
      if (d) return d;
      await new Promise<void>((r) => (wake = r));
    }
  };
  const hs = await startHandshake({ device: key, deviceName: name, trust: { kind: "pinned", machineKey: machine.publicKey } });
  ws.send(hs.hello);
  const { session } = await hs.finish(await next());
  const frames: Frame[] = [];
  let open = true;
  void (async () => {
    while (open) frames.push(session.open(await next()));
  })();
  const device: Device = {
    frames,
    request: (id, body) => ws.send(session.seal(create(FrameSchema, { id, body }))),
    close: () => {
      open = false;
      ws.close();
    },
  };
  device.request("hello", { case: "ping", value: {} });
  await waitFor(() => frames.some((f) => f.body.case === "pong"));
  return device;
}

export async function waitFor(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
