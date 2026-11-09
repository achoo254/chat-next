// A device talking to the machine over in-memory sockets: code pairing,
// handshake, a thread, an unknown device, a revoked device.
import { randomUUID } from "node:crypto";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, type Frame, FrameSchema, HandshakeErrorCode, ThreadState } from "@achoo254/chat-proto/remote/remote";
import {
  HandshakeFailure,
  PairingWindow,
  type Session,
  decodePlain,
  encodePlain,
  generateKeyPair,
  pakeStart,
  startHandshake,
  toBase64Url,
} from "@achoo254/chat-remote-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { Connection } from "../src/link/connection.ts";
import { LocalSessions } from "../src/providers/claude/local-sessions.ts";
import type { AgentProvider } from "../src/providers/types.ts";
import { fakeProvider } from "./fake-provider.ts";
import { Transcript } from "./support/claude-transcript.ts";
import { makeCore, tempDir } from "./harness.ts";

process.env.CHAT_AGENT_KEYSTORE = "file";

async function machine(providers: AgentProvider[] = [fakeProvider()]) {
  const { core, audit, work, home } = makeCore(providers);
  const config = new ConfigStore(join(tempDir(), "cfg"));
  const key = await generateKeyPair(true);
  let window: PairingWindow | undefined;
  const connect = () => {
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
      },
      {
        core,
        config,
        audit,
        auth: () => ({ machine: key, deviceStatus: (k) => config.deviceStatus(k), pairing: window }),
        pairing: () => window,
        machineInfo: async () => {
          throw new Error("unused");
        },
        isSensitive: () => false,
        onPing: () => undefined,
        onPaired: () => (window = undefined),
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
    return { conn, next, isClosed: () => closed };
  };
  return { core, config, key, connect, work, home, open: () => (window = PairingWindow.open()) };
}

const cores: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.stop()));
});

async function frames(s: Session, next: () => Promise<Uint8Array | null>, until: (f: Frame) => boolean): Promise<Frame[]> {
  const out: Frame[] = [];
  for (;;) {
    const d = await next();
    if (!d) throw new Error("connection closed");
    const f = s.open(d);
    out.push(f);
    if (until(f)) return out;
  }
}

describe("connection", () => {
  it("pairs with the code, then opens a thread over the encrypted link", async () => {
    const m = await machine();
    cores.push(m.core);
    const device = await generateKeyPair();
    const { code } = m.open();

    const pairing = m.connect();
    const p = await pakeStart({ code, deviceKey: device.publicKey, deviceName: "phone" });
    pairing.conn.receive(encodePlain({ case: "pakeStart", value: p.start }));
    const reply = decodePlain((await pairing.next()) ?? new Uint8Array());
    if (reply.body.case !== "pakeReply") throw new Error("expected reply");
    const { machineKey, finish } = await p.finish(reply.body.value);
    pairing.conn.receive(encodePlain({ case: "pakeFinish", value: finish }));
    await pairing.next();
    expect(pairing.isClosed()).toBe(true);
    expect(m.config.deviceStatus(device.publicKey)).toBe("paired");

    const link = m.connect();
    const hs = await startHandshake({ device, deviceName: "phone", trust: { kind: "pinned", machineKey } });
    link.conn.receive(hs.hello);
    const { session } = await hs.finish((await link.next()) ?? new Uint8Array());
    link.conn.receive(
      session.seal(create(FrameSchema, { id: "1", body: { case: "threadCreate", value: { provider: "fake", dir: m.work, text: "hello" } } })),
    );
    const got = await frames(session, link.next, (f) => f.body.case === "threadStatus" && f.body.value.thread?.state === ThreadState.IDLE);
    expect(got.some((f) => f.id === "1" && f.body.case === "threadCreated")).toBe(true);
    const texts = got.flatMap((f) => (f.body.case === "threadItems" ? f.body.value.items : [])).filter((i) => i.body.case === "text");
    expect(texts.some((i) => i.body.case === "text" && i.body.value.text === "echo: hello")).toBe(true);

    link.conn.receive(session.seal(create(FrameSchema, { id: "2", body: { case: "dirList", value: { path: "/definitely/not/here" } } })));
    const err = await frames(session, link.next, (f) => f.id === "2");
    const notFound = err.at(-1)?.body;
    expect(notFound?.case).toBe("error");
    if (notFound?.case === "error") expect(notFound.value.reason).toBe(ErrorReason.FOLDER_NOT_FOUND);

    // @-mentions: files of the thread's own folder; a path out of it is refused with its reason.
    const threadId = got.find((f) => f.body.case === "threadCreated")?.body.value;
    const id = threadId && "thread" in threadId ? (threadId.thread?.id ?? "") : "";
    writeFileSync(join(m.work, "notes.md"), "x");
    link.conn.receive(session.seal(create(FrameSchema, { id: "3", body: { case: "fileList", value: { threadId: id, prefix: "no" } } })));
    const listed = (await frames(session, link.next, (f) => f.id === "3")).at(-1)?.body;
    expect(listed?.case === "fileListResult" && listed.value.entries.map((e) => e.path)).toEqual(["notes.md"]);
    link.conn.receive(session.seal(create(FrameSchema, { id: "4", body: { case: "fileList", value: { threadId: id, prefix: "../" } } })));
    const outside = (await frames(session, link.next, (f) => f.id === "4")).at(-1)?.body;
    expect(outside?.case === "error" && [outside.value.code, outside.value.reason]).toEqual([ErrorCode.INVALID, ErrorReason.PATH_OUTSIDE_FOLDER]);

    // A machine without Full Disk Access to open (not a Mac) says it does not know the request.
    link.conn.receive(session.seal(create(FrameSchema, { id: "4b", body: { case: "openDiskAccessSettings", value: {} } })));
    const settings = (await frames(session, link.next, (f) => f.id === "4b")).at(-1)?.body;
    expect(settings?.case === "error" && settings.value.reason).toBe(ErrorReason.UNSUPPORTED_REQUEST);

    // A denial with words reaches the core and lands on the card.
    link.conn.receive(
      session.seal(
        create(FrameSchema, {
          id: "5",
          body: { case: "threadRespond", value: { threadId: id, itemId: "nope", expectedRevision: 1, answer: { case: "decision", value: 3 }, denyMessage: "no" } },
        }),
      ),
    );
    const stale = (await frames(session, link.next, (f) => f.id === "5")).at(-1)?.body;
    expect(stale?.case === "error" && stale.value.reason).toBe(ErrorReason.PROMPT_STALE);
  });

  it("lists the machine's Claude sessions and opens one as a thread with its history", async () => {
    const claudeHome = tempDir("claude-home-");
    const m = await machine([{ ...fakeProvider("claude"), history: new LocalSessions({ homes: () => [claudeHome] }) }]);
    cores.push(m.core);
    const t = new Transcript(randomUUID(), m.work, "cli").opening();
    t.user("Viết README");
    t.assistant([{ type: "text", text: "Xong README." }]);
    const file = t.write(claudeHome);
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(file, hourAgo, hourAgo);

    const device = await generateKeyPair();
    m.config.addDevice(device.publicKey, "phone");
    const link = m.connect();
    const hs = await startHandshake({ device, deviceName: "phone", trust: { kind: "pinned", machineKey: m.key.publicKey } });
    link.conn.receive(hs.hello);
    const { session } = await hs.finish((await link.next()) ?? new Uint8Array());

    link.conn.receive(session.seal(create(FrameSchema, { id: "1", body: { case: "sessionList", value: { query: "readme" } } })));
    const listed = (await frames(session, link.next, (f) => f.id === "1")).at(-1)?.body;
    if (listed?.case !== "sessionListResult") throw new Error(`expected a list, got ${listed?.case}`);
    expect(listed.value.total).toBe(1);
    expect(listed.value.sessions[0]).toMatchObject({ sessionId: t.sessionId, dir: m.work, title: "Viết README", messages: 2, entrypoint: "cli", threadId: "", busyElsewhere: false });
    expect(listed.value.dirs).toEqual([expect.objectContaining({ dir: m.work, sessions: 1 })]);

    link.conn.receive(session.seal(create(FrameSchema, { id: "2", body: { case: "sessionOpen", value: { sessionId: t.sessionId } } })));
    const got = await frames(session, link.next, (f) => f.body.case === "threadItems");
    const created = got.find((f) => f.id === "2")?.body;
    expect(created?.case === "threadCreated" && created.value.thread?.title).toBe("Viết README");
    const items = got.flatMap((f) => (f.body.case === "threadItems" ? f.body.value.items : []));
    expect(items.flatMap((i) => (i.body.case === "text" ? [i.body.value.text] : []))).toEqual(["Viết README", "Xong README."]);

    link.conn.receive(session.seal(create(FrameSchema, { id: "3", body: { case: "sessionOpen", value: { sessionId: randomUUID() } } })));
    const missing = (await frames(session, link.next, (f) => f.id === "3")).at(-1)?.body;
    expect(missing?.case === "error" && [missing.value.code, missing.value.reason]).toEqual([ErrorCode.NOT_FOUND, ErrorReason.SESSION_NOT_FOUND]);
  });

  it("refuses an unpaired device and a revoked one", async () => {
    const m = await machine();
    cores.push(m.core);
    const stranger = await generateKeyPair();
    const c1 = m.connect();
    const hs = await startHandshake({ device: stranger, deviceName: "x", trust: { kind: "pinned", machineKey: m.key.publicKey } });
    c1.conn.receive(hs.hello);
    await expect(hs.finish((await c1.next()) ?? new Uint8Array())).rejects.toMatchObject({ code: HandshakeErrorCode.UNKNOWN_DEVICE });

    m.config.addDevice(stranger.publicKey, "x");
    m.config.revokeDevice(toBase64Url(stranger.publicKey));
    const c2 = m.connect();
    const hs2 = await startHandshake({ device: stranger, deviceName: "x", trust: { kind: "pinned", machineKey: m.key.publicKey } });
    c2.conn.receive(hs2.hello);
    const err = await hs2.finish((await c2.next()) ?? new Uint8Array()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandshakeFailure);
    expect((err as HandshakeFailure).code).toBe(HandshakeErrorCode.REVOKED);
  });
});
