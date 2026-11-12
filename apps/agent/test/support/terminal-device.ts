// A machine with a terminal (TerminalService) and the devices of its account talking
// to it over in-memory end-to-end connections, for the terminal tests: a
// device may open several connections (chat and terminal), each with its
// own session counter, as the web does.
import { join } from "node:path";
import { type MessageInitShape, create } from "@bufbuild/protobuf";
import { type Frame, FrameSchema } from "@achoo254/chat-proto/remote/remote";
import { type KeyPair, type Session, generateKeyPair, startHandshake } from "@achoo254/chat-remote-protocol";
import { ConfigStore } from "../../src/config.ts";
import { DeviceTrust } from "../../src/device-trust.ts";
import { Connection } from "../../src/link/connection.ts";
import type { AgentProvider } from "../../src/providers/types.ts";
import type { TermHostUnit } from "../../src/terminal/host-supervisor.ts";
import { TerminalService, aiTerminalsOf } from "../../src/terminal/terminal-service.ts";
import { fakeProvider } from "../fake-provider.ts";
import { makeCore, tempDir } from "../harness.ts";
import { trustDevice } from "./trusted-devices.ts";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

export type DeviceConnection = {
  conn: Connection;
  session: Session;
  /** Every frame the device got on this connection. */
  received: Frame[];
  isClosed(): boolean;
  /** Seals and sends a frame (no answer awaited). */
  send(body: Body, id?: string): void;
  /** Sends raw bytes as a WebSocket message (for broken frames). */
  raw(bytes: Uint8Array): void;
  /** Sends a request and resolves with the frame answering it. */
  request(id: string, body: Body): Promise<Frame>;
  /** Resolves with the first frame (already received or coming) that matches. */
  waitFor(match: (f: Frame) => boolean, ms?: number): Promise<Frame>;
  close(): void;
};

export async function terminalMachine(opts: {
  unit: TermHostUnit | undefined;
  env?: NodeJS.ProcessEnv;
  providers?: AgentProvider[];
  claudeConfigDir?: () => string | undefined;
  /** The machine's config folder; a new one when not given. */
  configDir?: string;
  /** Grace before the terminal closes connections an earlier agent run left. */
  orphanGraceMs?: number;
}) {
  const { core, audit, work } = makeCore(opts.providers ?? [fakeProvider()]);
  const config = new ConfigStore(opts.configDir ?? join(tempDir("term-"), "cfg"));
  const machineKey = await generateKeyPair(true);
  const trust = new DeviceTrust({ config });
  const logs: string[] = [];
  const terminal = new TerminalService({
    configDir: config.dir,
    config,
    audit,
    unit: opts.unit,
    ai: aiTerminalsOf(core),
    log: (l) => logs.push(l),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.claudeConfigDir ? { claudeConfigDir: opts.claudeConfigDir } : {}),
    ...(opts.orphanGraceMs !== undefined ? { orphanGraceMs: opts.orphanGraceMs } : {}),
  });

  const connect = async (device: KeyPair, buffered: () => number = () => 0): Promise<DeviceConnection> => {
    const inbox: Uint8Array[] = [];
    let closed = false;
    let wake: (() => void) | undefined;
    const conn = new Connection(
      {
        send: (d) => {
          inbox.push(d);
          wake?.();
        },
        close: () => {
          closed = true;
          wake?.();
        },
        buffered,
      },
      {
        core,
        config,
        audit,
        terminal,
        machineKey: () => machineKey,
        trust,
        machineInfo: async () => {
          throw new Error("unused");
        },
        isSensitive: () => false,
        onPing: () => undefined,
      },
    );
    const next = async (): Promise<Uint8Array | null> => {
      for (;;) {
        const d = inbox.shift();
        if (d) return d;
        if (closed) return null;
        await new Promise<void>((r) => (wake = r));
      }
    };
    const hs = await startHandshake({ device, expectedMachineKey: machineKey.publicKey });
    conn.receive(hs.hello);
    const first = await next();
    if (!first) throw new Error("the machine refused the device");
    const { session } = await hs.finish(first);
    const received: Frame[] = [];
    const watchers = new Set<(f: Frame) => void>();
    void (async () => {
      for (;;) {
        const d = await next();
        if (!d) return;
        const f = session.open(d);
        received.push(f);
        for (const w of [...watchers]) w(f);
      }
    })();
    const waitFor = (match: (f: Frame) => boolean, ms = 5_000): Promise<Frame> => {
      const hit = received.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          watchers.delete(w);
          reject(new Error(`no matching frame in ${ms} ms; got ${received.map((f) => f.body.case).join(",")}`));
        }, ms);
        const w = (f: Frame) => {
          if (!match(f)) return;
          clearTimeout(timer);
          watchers.delete(w);
          resolve(f);
        };
        watchers.add(w);
      });
    };
    const send = (body: Body, id = "") => conn.receive(session.seal(create(FrameSchema, { id, body })));
    return {
      conn,
      session,
      received,
      isClosed: () => closed,
      send,
      raw: (bytes) => conn.receive(bytes),
      request: (id, body) => {
        const answer = waitFor((f) => f.id === id, 15_000);
        send(body, id);
        return answer;
      },
      waitFor,
      close: () => conn.close(),
    };
  };

  /** A device of the machine's account. */
  const pair = async (name = "laptop"): Promise<KeyPair> => {
    const device = await generateKeyPair();
    trustDevice(config, device.publicKey, name);
    return device;
  };

  return { core, config, audit, terminal, machineKey, connect, pair, logs, work };
}

type BodyOf<C extends NonNullable<Frame["body"]["case"]>> = Extract<Frame["body"], { case: C }>["value"];

/** The TermStatus frames a connection received. */
export function termStatuses(frames: Frame[]): BodyOf<"termStatus">[] {
  return frames.flatMap((f) => (f.body.case === "termStatus" ? [f.body.value] : []));
}

/** The TermData frames a connection received. */
export function termDatas(frames: Frame[]): BodyOf<"termData">[] {
  return frames.flatMap((f) => (f.body.case === "termData" ? [f.body.value] : []));
}

/** The TermSignal frames a connection received. */
export function termSignals(frames: Frame[]): BodyOf<"termSignal">[] {
  return frames.flatMap((f) => (f.body.case === "termSignal" ? [f.body.value] : []));
}
