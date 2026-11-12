// A device talking to the machine over in-memory sockets: only a device key
// the owner's account lists gets in (asked of Chat at once when new, at most
// once per key every 30 s; refused when the list is over 24 hours old), then
// a thread, Claude sessions, an unknown device, a revoked device, updates.
import { randomUUID } from "node:crypto";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MessageInitShape, create, toBinary } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, type Frame, FrameSchema, HandshakeErrorCode, MachineInfoSchema, ThreadState } from "@achoo254/chat-proto/remote/remote";
import { HandshakeFailure, type KeyPair, type Session, generateKeyPair, startHandshake, toBase64Url } from "@achoo254/chat-remote-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore, TRUST_MAX_AGE_MS } from "../src/config.ts";
import { AgentUpdater } from "../src/agent-updater.ts";
import { DeviceTrust, UNKNOWN_KEY_RETRY_MS } from "../src/device-trust.ts";
import { Connection, type LinkContext } from "../src/link/connection.ts";
import { LocalSessions } from "../src/providers/claude/local-sessions.ts";
import type { AgentProvider } from "../src/providers/types.ts";
import { fakeProvider } from "./fake-provider.ts";
import { Transcript } from "./support/claude-transcript.ts";
import { revokeDevice, trustDevice } from "./support/trusted-devices.ts";
import { makeCore, tempDir } from "./harness.ts";

process.env.TUNELO_KEYSTORE = "file";

async function machine(providers: AgentProvider[] = [fakeProvider()], extra: Partial<LinkContext> = {}) {
  const { core, audit, work, home } = makeCore(providers);
  const config = new ConfigStore(join(tempDir(), "cfg"));
  const key = await generateKeyPair(true);
  let now = Date.now();
  const trust = new DeviceTrust({ config, now: () => now });
  const refused: string[] = [];
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
        machineKey: () => key,
        trust,
        onRefused: (k, verdict) => refused.push(`${toBase64Url(k).slice(0, 8)} ${verdict}`),
        machineInfo: async () => {
          throw new Error("unused");
        },
        isSensitive: () => false,
        onPing: () => undefined,
        ...extra,
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
  return {
    core,
    config,
    audit,
    key,
    trust,
    connect,
    work,
    home,
    refused,
    /** Moves the machine's clock. */
    advance: (ms: number) => (now += ms),
  };
}

type TestMachine = Awaited<ReturnType<typeof machine>>;

/** The handshake of `device`: resolves with the session, or rejects with the machine's HandshakeFailure. */
async function handshake(m: TestMachine, device: KeyPair) {
  const c = m.connect();
  const hs = await startHandshake({ device, expectedMachineKey: m.key.publicKey });
  c.conn.receive(hs.hello);
  const { session } = await hs.finish((await c.next()) ?? new Uint8Array());
  return { ...c, session };
}

/** The handshake's error code, or "ok". */
async function outcome(m: TestMachine, device: KeyPair): Promise<HandshakeErrorCode | "ok"> {
  try {
    await handshake(m, device);
    return "ok";
  } catch (err) {
    if (err instanceof HandshakeFailure) return err.code;
    throw err;
  }
}

/** A trusted device's end-to-end link to the machine. */
async function link(m: TestMachine, device: KeyPair) {
  const l = m.connect();
  const hs = await startHandshake({ device, expectedMachineKey: m.key.publicKey });
  l.conn.receive(hs.hello);
  const { session } = await hs.finish((await l.next()) ?? new Uint8Array());
  const request = async (id: string, body: NonNullable<MessageInitShape<typeof FrameSchema>["body"]>): Promise<Frame["body"] | undefined> => {
    l.conn.receive(session.seal(create(FrameSchema, { id, body })));
    return (await frames(session, l.next, (f) => f.id === id)).at(-1)?.body;
  };
  return { ...l, session, request };
}

const cores: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  vi.useRealTimers();
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
  it("lets in a device the account lists, then opens a thread over the encrypted link", async () => {
    const m = await machine();
    cores.push(m.core);
    const device = await generateKeyPair();
    trustDevice(m.config, device.publicKey, "phone");

    const link = m.connect();
    const hs = await startHandshake({ device, expectedMachineKey: m.key.publicKey });
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

    // A file in two pieces, then a message naming it: saved in the folder, kept on the message.
    const seal = (fid: string, body: Parameters<typeof create<typeof FrameSchema>>[1]) => link.conn.receive(session.seal(create(FrameSchema, { id: fid, ...body })));
    const bytes = new TextEncoder().encode("hello file");
    seal("6", { body: { case: "attachmentUpload", value: { uploadId: "upload-1234", threadId: id, name: "../notes.txt", size: BigInt(bytes.length), offset: 0n, data: bytes.slice(0, 6) } } });
    seal("7", { body: { case: "attachmentUpload", value: { uploadId: "upload-1234", offset: 6n, data: bytes.slice(6) } } });
    const acks = await frames(session, link.next, (f) => f.id === "7");
    expect(acks.filter((f) => f.id === "6" || f.id === "7").map((f) => f.body.case)).toEqual(["ack", "ack"]);
    seal("8", { body: { case: "threadSend", value: { threadId: id, text: "read it", clientMsgId: "c8", attachmentIds: ["upload-1234"] } } });
    const echoed = await frames(session, link.next, (f) => f.body.case === "threadItems" && f.body.value.items.some((i) => i.body.case === "text" && i.body.value.clientMsgId === "c8"));
    const user = echoed.flatMap((f) => (f.body.case === "threadItems" ? f.body.value.items : [])).find((i) => i.body.case === "text" && i.body.value.clientMsgId === "c8");
    const sentFile = user?.body.case === "text" ? user.body.value.attachments[0] : undefined;
    expect(sentFile && [sentFile.name, sentFile.image, sentFile.path.endsWith("/notes.txt")]).toEqual(["../notes.txt", false, true]);
    // A piece at the wrong place, and an image that is not one, are refused with their reasons.
    seal("9", { body: { case: "attachmentUpload", value: { uploadId: "upload-5678", offset: 4n, data: bytes } } });
    const gap = (await frames(session, link.next, (f) => f.id === "9")).at(-1)?.body;
    expect(gap?.case === "error" && gap.value.reason).toBe(ErrorReason.ATTACHMENT_NOT_FOUND);
    seal("10", { body: { case: "attachmentFetch", value: { threadId: id, attachmentId: "upload-1234" } } });
    const noImage = (await frames(session, link.next, (f) => f.id === "10")).at(-1)?.body;
    expect(noImage?.case === "error" && noImage.value.reason).toBe(ErrorReason.ATTACHMENT_NOT_FOUND);
    seal("11", { body: { case: "attachmentCancel", value: { uploadId: "never-sent-1" } } });
    expect((await frames(session, link.next, (f) => f.id === "11")).at(-1)?.body.case).toBe("ack");

    // `/clear` opens an empty thread in the same folder on the same AI; the old one keeps its history and never gets the command.
    seal("11b", { body: { case: "threadSend", value: { threadId: id, text: " /clear ", clientMsgId: "c11b", attachmentIds: [] } } });
    const cleared = await frames(session, link.next, (f) => f.id === "11b" && f.body.case === "threadCreated");
    const fresh = cleared.find((f) => f.id === "11b")?.body;
    const freshThread = fresh?.case === "threadCreated" ? fresh.value.thread : undefined;
    expect(freshThread && [freshThread.id !== id, freshThread.dir, freshThread.provider, freshThread.title]).toEqual([true, m.work, "fake", ""]);
    const oldTexts = m.core.snapshot(id).flatMap((i) => (i.body.case === "text" ? [i.body.value.text] : []));
    expect(oldTexts.some((text) => text.includes("/clear"))).toBe(false);
    expect(m.core.snapshot(freshThread?.id ?? "")).toEqual([]);

    // Archive, then delete: every device hears the thread is gone.
    seal("12", { body: { case: "threadSetArchived", value: { threadId: id, archived: true } } });
    const archived = await frames(session, link.next, (f) => f.id === "12");
    expect(archived.some((f) => f.body.case === "threadStatus" && f.body.value.thread?.archived === true)).toBe(true);
    seal("13", { body: { case: "threadDelete", value: { threadId: id } } });
    const deleted = await frames(session, link.next, (f) => f.id === "13");
    expect(deleted.filter((f) => f.body.case === "threadDeleted").map((f) => f.id)).toEqual(["", "13"]);
    seal("14", { body: { case: "threadDelete", value: { threadId: id } } });
    const gone = (await frames(session, link.next, (f) => f.id === "14")).at(-1)?.body;
    expect(gone?.case === "error" && gone.value.reason).toBe(ErrorReason.THREAD_NOT_FOUND);
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
    trustDevice(m.config, device.publicKey, "phone");
    const link = m.connect();
    const hs = await startHandshake({ device, expectedMachineKey: m.key.publicKey });
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

  it("refuses a device the account does not list, and one it dropped", async () => {
    const m = await machine();
    cores.push(m.core);
    const phone = await generateKeyPair();
    trustDevice(m.config, phone.publicKey, "phone");
    const stranger = await generateKeyPair();
    expect(await outcome(m, stranger)).toBe(HandshakeErrorCode.UNKNOWN_DEVICE);

    revokeDevice(m.config, phone.publicKey);
    expect(await outcome(m, phone)).toBe(HandshakeErrorCode.REVOKED);
    expect(m.refused).toEqual([`${toBase64Url(stranger.publicKey).slice(0, 8)} unknown`, `${toBase64Url(phone.publicKey).slice(0, 8)} revoked`]);
  });

  it("a frame in the clear, before any handshake, closes the link", async () => {
    const m = await machine();
    cores.push(m.core);
    const c = m.connect();
    c.conn.receive(toBinary(FrameSchema, create(FrameSchema, { id: "1", body: { case: "threadList", value: {} } })));
    while ((await c.next()) !== null);
    expect(c.isClosed()).toBe(true);
  });
});

describe("trusted devices from Chat", () => {
  it("a key the list does not have yet asks Chat at once, and gets in once Chat lists it", async () => {
    const m = await machine();
    cores.push(m.core);
    trustDevice(m.config, (await generateKeyPair()).publicKey, "laptop");
    const phone = await generateKeyPair();
    let asked = 0;
    m.trust.setRefresh(async () => {
      asked++;
      trustDevice(m.config, phone.publicKey, "new phone");
    });
    const l = await link(m, phone);
    expect(asked).toBe(1);
    expect(await l.request("1", { case: "ping", value: {} })).toMatchObject({ case: "pong" });
    // Known now: no further call.
    await link(m, phone);
    expect(asked).toBe(1);
  });

  it("asks Chat about a key it does not list at most once per key every 30 s; other keys still ask", async () => {
    const m = await machine();
    cores.push(m.core);
    trustDevice(m.config, (await generateKeyPair()).publicKey, "laptop");
    let asked = 0;
    m.trust.setRefresh(async () => {
      asked++;
    });
    const stranger = await generateKeyPair();
    expect(await outcome(m, stranger)).toBe(HandshakeErrorCode.UNKNOWN_DEVICE);
    expect(await outcome(m, stranger)).toBe(HandshakeErrorCode.UNKNOWN_DEVICE);
    expect(asked).toBe(1);
    expect(await outcome(m, await generateKeyPair())).toBe(HandshakeErrorCode.UNKNOWN_DEVICE);
    expect(asked).toBe(2);
    m.advance(UNKNOWN_KEY_RETRY_MS + 1);
    expect(await outcome(m, stranger)).toBe(HandshakeErrorCode.UNKNOWN_DEVICE);
    expect(asked).toBe(3);
  });

  it("handshakes that arrive together share one call to Chat", async () => {
    const m = await machine();
    cores.push(m.core);
    const devices = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()]);
    let asked = 0;
    m.trust.setRefresh(async () => {
      asked++;
      await new Promise((r) => setTimeout(r, 20));
      for (const d of devices) trustDevice(m.config, d.publicKey);
    });
    expect(await Promise.all(devices.map((d) => outcome(m, d)))).toEqual(["ok", "ok", "ok"]);
    expect(asked).toBe(1);
  });

  it("a list over 24 hours old refuses new handshakes (try later); a link already open stays", async () => {
    const m = await machine();
    cores.push(m.core);
    const phone = await generateKeyPair();
    trustDevice(m.config, phone.publicKey, "phone");
    const open = await link(m, phone);
    let asked = 0;
    // Chat cannot be reached: the list stays as it was.
    m.trust.setRefresh(async () => {
      asked++;
      throw new Error("offline");
    });
    m.advance(TRUST_MAX_AGE_MS - 60_000);
    expect(await outcome(m, phone)).toBe("ok");
    m.advance(120_000);
    expect(await outcome(m, phone)).toBe(HandshakeErrorCode.BUSY);
    expect(asked).toBe(1);
    expect(m.refused.at(-1)).toBe(`${toBase64Url(phone.publicKey).slice(0, 8)} stale`);
    expect(await open.request("1", { case: "ping", value: {} })).toMatchObject({ case: "pong" });
    // Chat answers again: the fresh list lets the device in.
    m.advance(UNKNOWN_KEY_RETRY_MS + 1);
    m.trust.setRefresh(async () => {
      m.config.syncTrustedDevices(m.config.get().trustedDevices?.list ?? [], Date.now() + TRUST_MAX_AGE_MS);
    });
    expect(await outcome(m, phone)).toBe("ok");
  });

  it("a machine that never got a list refuses every device", async () => {
    const m = await machine();
    cores.push(m.core);
    expect(await outcome(m, await generateKeyPair())).toBe(HandshakeErrorCode.BUSY);
  });

  it("stores the list with its time, names devices from it, and reports who was added and who left", () => {
    const config = new ConfigStore(join(tempDir(), "cfg"));
    const a = toBase64Url(new Uint8Array(32).fill(1));
    const b = toBase64Url(new Uint8Array(32).fill(2));
    expect(config.syncTrustedDevices([{ key: a, name: "phone\u0007", platform: "ios", createdAt: 5 }], 1_000)).toEqual({
      added: [{ key: a, name: "phone", platform: "ios", createdAt: 5 }],
      removed: [],
    });
    expect(config.deviceName(a)).toBe("phone");
    const second = config.syncTrustedDevices([{ key: b, name: "", platform: "web", createdAt: 6 }], 2_000);
    expect(second.added.map((d) => [d.key, d.name])).toEqual([[b, "device"]]);
    expect(second.removed.map((d) => d.key)).toEqual([a]);
    expect([config.deviceStatus(a), config.deviceStatus(b), config.revokedKeys()]).toEqual(["revoked", "trusted", [a]]);
    // Read back by a machine started later.
    const later = new ConfigStore(config.dir);
    expect(later.get().trustedDevices?.syncedAt).toBe(2_000);
    expect(later.trustStale(2_000 + TRUST_MAX_AGE_MS)).toBe(false);
    expect(later.trustStale(2_001 + TRUST_MAX_AGE_MS)).toBe(true);
  });

  it("drops the pairing-era fields of an older config", () => {
    const dir = join(tempDir(), "cfg");
    new ConfigStore(dir).update((c) => Object.assign(c, { devices: [{ key: "k", name: "n", addedAt: 1 }], totpSecret: "s", install: { deviceKey: "d", secret: "x" }, claimed: true, revoked: ["r"] }));
    const later = new ConfigStore(dir);
    later.update(() => undefined);
    for (const field of ["devices", "totpSecret", "install", "claimed", "revoked"]) expect(later.get()).not.toHaveProperty(field);
  });
});

describe("updates", () => {
  it("a device updates tunelo: Ack at once, a line in the consent log, an error where it cannot", async () => {
    let started = 0;
    const updater = new AgentUpdater({
      supported: () => true,
      announce: () => undefined,
      emit: () => undefined,
      restart: () => undefined,
      log: () => undefined,
      check: () => Promise.resolve("9.9.9"),
      install: () => {
        started += 1;
        return Promise.resolve(null);
      },
    });
    const m = await machine([fakeProvider()], { updater, machineInfo: async () => create(MachineInfoSchema, { agentUpdate: updater.info() }) });
    cores.push(m.core);
    const phone = await generateKeyPair();
    trustDevice(m.config, phone.publicKey, "phone");
    const l = await link(m, phone);

    expect(await l.request("1", { case: "agentUpdateCheck", value: {} })).toMatchObject({ case: "machineInfo", value: { agentUpdate: { latestVersion: "9.9.9" } } });
    expect((await l.request("2", { case: "agentUpdateStart", value: {} }))?.case).toBe("ack");
    expect(started).toBe(1);
    expect(m.audit.list().some((e) => e.action === "agent_update" && e.detail === "9.9.9")).toBe(true);

    const none = await machine([fakeProvider()], { updater: new AgentUpdater({ supported: () => false, announce: () => undefined, emit: () => undefined, restart: () => undefined, log: () => undefined }) });
    cores.push(none.core);
    trustDevice(none.config, phone.publicKey, "phone");
    const l2 = await link(none, phone);
    const refused = await l2.request("1", { case: "agentUpdateStart", value: {} });
    expect(refused?.case === "error" && refused.value.reason).toBe(ErrorReason.UPDATE_UNAVAILABLE);
  });
});
