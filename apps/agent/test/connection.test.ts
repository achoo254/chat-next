// A device talking to the machine over in-memory sockets: pairing by the
// authenticator code (wrong code, lockout, clock drift, no secret yet),
// setting the secret from a paired device, handshake, a thread, an unknown
// device, a revoked device.
import { randomUUID } from "node:crypto";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MessageInitShape, create, toBinary } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, type Frame, FrameSchema, HandshakeErrorCode, MachineInfoSchema, ThreadState } from "@achoo254/chat-proto/remote/remote";
import {
  HandshakeFailure,
  type KeyPair,
  PAIRING_LOCKOUT_MS,
  PAIRING_MAX_ATTEMPTS,
  PakeFailure,
  type PairingMethod,
  type Session,
  TOTP_PERIOD_MS,
  TotpPairing,
  decodePlain,
  encodePlain,
  generateKeyPair,
  generateTotpSecret,
  pakeStart,
  startHandshake,
  toBase64Url,
  totpCode,
  totpCodeAt,
  totpStep,
} from "@achoo254/chat-remote-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { AgentUpdater } from "../src/agent-updater.ts";
import { Connection, type LinkContext } from "../src/link/connection.ts";
import { LocalSessions } from "../src/providers/claude/local-sessions.ts";
import type { AgentProvider } from "../src/providers/types.ts";
import { fakeProvider } from "./fake-provider.ts";
import { Transcript } from "./support/claude-transcript.ts";
import { makeCore, tempDir } from "./harness.ts";

process.env.TUNELO_KEYSTORE = "file";

async function machine(providers: AgentProvider[] = [fakeProvider()], extra: Partial<LinkContext> = {}) {
  const { core, audit, work, home } = makeCore(providers);
  const config = new ConfigStore(join(tempDir(), "cfg"));
  const key = await generateKeyPair(true);
  const pairing = new TotpPairing(config.totpSecret());
  const paired: PairingMethod[] = [];
  let totpSets = 0;
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
        auth: () => ({ machine: key, deviceStatus: (k) => config.deviceStatus(k) }),
        pairing,
        machineInfo: async () => {
          throw new Error("unused");
        },
        isSensitive: () => false,
        onPing: () => undefined,
        onPaired: (via) => paired.push(via),
        onTotpSet: () => (totpSets += 1),
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
  /** Sets the authenticator secret as a paired device would have. */
  const enableTotp = (): Uint8Array => {
    const secret = generateTotpSecret();
    config.setTotpSecret(secret);
    pairing.setSecret(secret);
    return secret;
  };
  return { core, config, audit, key, pairing, connect, work, home, paired, enableTotp, totpSets: () => totpSets };
}

type TestMachine = Awaited<ReturnType<typeof machine>>;
type PairOutcome = { kind: "paired"; machineKey: Uint8Array } | { kind: "refused"; code: HandshakeErrorCode } | { kind: "wrong-code" };

/** A new device types `code`: the machine pairs it, refuses before any exchange, or the code does not match. */
async function pairWithCode(m: TestMachine, device: KeyPair, code: string): Promise<PairOutcome> {
  const c = m.connect();
  const p = await pakeStart({ code, deviceKey: device.publicKey, deviceName: "phone" });
  c.conn.receive(encodePlain({ case: "pakeStart", value: p.start }));
  const reply = decodePlain((await c.next()) ?? new Uint8Array());
  if (reply.body.case === "error") {
    expect(await c.next()).toBeNull();
    return { kind: "refused", code: reply.body.value.code };
  }
  if (reply.body.case !== "pakeReply") throw new Error(`unexpected ${reply.body.case}`);
  let done: { machineKey: Uint8Array; finish: Parameters<typeof encodePlain>[0] };
  try {
    const r = await p.finish(reply.body.value);
    done = { machineKey: r.machineKey, finish: { case: "pakeFinish", value: r.finish } };
  } catch (err) {
    if (!(err instanceof PakeFailure)) throw err;
    // The device gives up, as the web does on a wrong code.
    c.conn.close();
    return { kind: "wrong-code" };
  }
  c.conn.receive(encodePlain(done.finish));
  expect(await c.next()).toBeNull();
  return { kind: "paired", machineKey: done.machineKey };
}

/** A code no authenticator with `secret` shows within two steps of now. */
function wrongCode(secret: Uint8Array): string {
  const step = totpStep(Date.now());
  const near = new Set([-2, -1, 0, 1, 2].map((d) => totpCodeAt(secret, step + d)));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, "0");
    if (!near.has(code)) return code;
  }
}

/** A paired device's end-to-end link to the machine. */
async function link(m: TestMachine, device: KeyPair) {
  const l = m.connect();
  const hs = await startHandshake({ device, deviceName: "phone", trust: { kind: "pinned", machineKey: m.key.publicKey } });
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
  it("pairs with the authenticator code, then opens a thread over the encrypted link", async () => {
    const m = await machine();
    cores.push(m.core);
    const device = await generateKeyPair();
    const secret = m.enableTotp();

    const outcome = await pairWithCode(m, device, totpCode(secret));
    if (outcome.kind !== "paired") throw new Error(`not paired: ${JSON.stringify(outcome)}`);
    const machineKey = outcome.machineKey;
    expect(m.config.deviceStatus(device.publicKey)).toBe("paired");
    expect(m.paired).toEqual(["totp"]);
    expect(m.audit.list().find((e) => e.action === "pair")).toMatchObject({ detail: "totp", device: expect.stringContaining("phone") });

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

describe("pairing by the authenticator code", () => {
  it("refuses a new device while the machine has no authenticator secret, without counting an attempt", async () => {
    const m = await machine();
    cores.push(m.core);
    const device = await generateKeyPair();
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS + 1; i++) {
      expect(await pairWithCode(m, device, "123456")).toEqual({ kind: "refused", code: HandshakeErrorCode.TOTP_NOT_SET });
    }
    expect(m.config.deviceStatus(device.publicKey)).toBe("unknown");
    // Once a secret is set the right code pairs at once: the refusals above were not attempts.
    const secret = m.enableTotp();
    expect((await pairWithCode(m, device, totpCode(secret))).kind).toBe("paired");
  });

  it("does not pair a wrong code and leaves no trace of it but the attempt", async () => {
    const m = await machine();
    cores.push(m.core);
    const device = await generateKeyPair();
    const secret = m.enableTotp();
    expect(await pairWithCode(m, device, wrongCode(secret))).toEqual({ kind: "wrong-code" });
    expect(m.config.deviceStatus(device.publicKey)).toBe("unknown");
    expect(m.paired).toEqual([]);
    expect(m.audit.list().some((e) => e.action === "pair")).toBe(false);
  });

  it("accepts the code of the step before and after, not two steps away", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The middle of a step, so the steps around it are whole.
    vi.setSystemTime(1_000 * TOTP_PERIOD_MS + TOTP_PERIOD_MS / 2);
    const m = await machine();
    cores.push(m.core);
    const secret = m.enableTotp();
    const step = totpStep(Date.now());
    for (const drift of [-1, 1]) {
      const device = await generateKeyPair();
      expect((await pairWithCode(m, device, totpCodeAt(secret, step + drift))).kind).toBe("paired");
    }
    const late = await generateKeyPair();
    expect((await pairWithCode(m, late, totpCodeAt(secret, step - 2))).kind).toBe("wrong-code");
  });

  it("locks pairing for 15 minutes after 5 attempts that did not pair, even for the right code", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000 * TOTP_PERIOD_MS + TOTP_PERIOD_MS / 2);
    const m = await machine();
    cores.push(m.core);
    const secret = m.enableTotp();
    const device = await generateKeyPair();
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
      expect((await pairWithCode(m, device, wrongCode(secret))).kind).toBe("wrong-code");
    }
    expect(await pairWithCode(m, device, totpCode(secret))).toEqual({ kind: "refused", code: HandshakeErrorCode.TOO_MANY_ATTEMPTS });
    vi.setSystemTime(Date.now() + PAIRING_LOCKOUT_MS - 1_000);
    expect(await pairWithCode(m, device, totpCode(secret))).toEqual({ kind: "refused", code: HandshakeErrorCode.TOO_MANY_ATTEMPTS });
    vi.setSystemTime(Date.now() + 2_000);
    expect((await pairWithCode(m, device, totpCode(secret))).kind).toBe("paired");
    expect(m.paired).toEqual(["totp"]);
  });

  it("a right code clears the count of failed attempts", async () => {
    const m = await machine();
    cores.push(m.core);
    const secret = m.enableTotp();
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS - 1; i++) {
      expect((await pairWithCode(m, await generateKeyPair(), wrongCode(secret))).kind).toBe("wrong-code");
    }
    expect((await pairWithCode(m, await generateKeyPair(), totpCode(secret))).kind).toBe("paired");
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS - 1; i++) {
      expect((await pairWithCode(m, await generateKeyPair(), wrongCode(secret))).kind).toBe("wrong-code");
    }
    expect((await pairWithCode(m, await generateKeyPair(), totpCode(secret))).kind).toBe("paired");
  });

  it("a paired device sets, reads and replaces the secret; it is stored but never logged or echoed", async () => {
    const m = await machine();
    cores.push(m.core);
    const phone = await generateKeyPair();
    m.config.addDevice(phone.publicKey, "phone");
    const l = await link(m, phone);

    expect(await l.request("1", { case: "totpStatusRequest", value: {} })).toMatchObject({ case: "totpStatus", value: { enabled: false } });
    const short = await l.request("2", { case: "totpSet", value: { secret: new Uint8Array(19) } });
    expect(short?.case === "error" && [short.value.code, short.value.reason]).toEqual([ErrorCode.INVALID, ErrorReason.TOTP_SECRET_INVALID]);
    expect(m.pairing.enabled).toBe(false);
    expect(m.config.get().totpSecret).toBeUndefined();

    const first = generateTotpSecret();
    expect(await l.request("3", { case: "totpSet", value: { secret: first } })).toMatchObject({ case: "totpStatus", value: { enabled: true } });
    expect(m.pairing.enabled).toBe(true);
    expect(m.config.totpSecret()).toEqual(first);
    expect(await l.request("4", { case: "totpStatusRequest", value: {} })).toMatchObject({ case: "totpStatus", value: { enabled: true } });

    // A new secret replaces the old one: only its codes pair from now on.
    const second = generateTotpSecret();
    expect(await l.request("5", { case: "totpSet", value: { secret: second } })).toMatchObject({ case: "totpStatus", value: { enabled: true } });
    expect(m.config.totpSecret()).toEqual(second);
    expect(m.totpSets()).toBe(2);
    expect(m.audit.list().filter((e) => e.action === "totp_set").map((e) => e.detail)).toEqual(["replaced", "set"]);

    const laptop = await generateKeyPair();
    const oldCode = totpCode(first);
    if (!new Set([-1, 0, 1].map((d) => totpCodeAt(second, totpStep(Date.now()) + d))).has(oldCode)) {
      expect((await pairWithCode(m, laptop, oldCode)).kind).toBe("wrong-code");
    }
    expect((await pairWithCode(m, laptop, totpCode(second))).kind).toBe("paired");

    // Kept with the config, nowhere in the consent log.
    const encodings = (b: Uint8Array) => [toBase64Url(b), Buffer.from(b).toString("base64"), Buffer.from(b).toString("hex")];
    const auditText = JSON.stringify(m.audit.list(1000));
    for (const secret of [first, second]) for (const e of encodings(secret)) expect(auditText).not.toContain(e);
    expect(readFileSync(m.config.file, "utf8")).toContain(toBase64Url(second));
  });

  it("a stored secret turns pairing on for a machine started later; a damaged one leaves it off", async () => {
    const dir = join(tempDir(), "cfg");
    const secret = generateTotpSecret();
    new ConfigStore(dir).setTotpSecret(secret);
    const later = new ConfigStore(dir);
    expect(later.totpSecret()).toEqual(secret);
    expect(new TotpPairing(later.totpSecret()).enabled).toBe(true);
    later.update((c) => (c.totpSecret = "not*base64"));
    expect(later.totpSecret()).toBeUndefined();
    later.update((c) => (c.totpSecret = toBase64Url(new Uint8Array(10))));
    expect(later.totpSecret()).toBeUndefined();
    expect(() => later.setTotpSecret(new Uint8Array(21))).toThrow();
  });

  it("only a paired device's sealed link reaches totpSet: an unknown device and a device mid-pairing cannot", async () => {
    const m = await machine();
    cores.push(m.core);
    const secret = m.enableTotp();
    const stranger = await generateKeyPair();
    const attack = generateTotpSecret();

    // An unknown device's handshake is refused before any frame.
    const c1 = m.connect();
    const hs = await startHandshake({ device: stranger, deviceName: "x", trust: { kind: "pinned", machineKey: m.key.publicKey } });
    c1.conn.receive(hs.hello);
    await expect(hs.finish((await c1.next()) ?? new Uint8Array())).rejects.toMatchObject({ code: HandshakeErrorCode.UNKNOWN_DEVICE });

    const unsealed = toBinary(FrameSchema, create(FrameSchema, { id: "1", body: { case: "totpSet", value: { secret: attack } } }));
    const drain = async (c: ReturnType<TestMachine["connect"]>) => {
      while ((await c.next()) !== null);
    };

    // A frame sent in the clear, without a session, closes the link.
    const c2 = m.connect();
    c2.conn.receive(unsealed);
    await drain(c2);
    expect(c2.isClosed()).toBe(true);

    // Mid-pairing (after PakeStart), anything but PakeFinish closes the link.
    const c3 = m.connect();
    const p = await pakeStart({ code: wrongCode(secret), deviceKey: stranger.publicKey, deviceName: "x" });
    c3.conn.receive(encodePlain({ case: "pakeStart", value: p.start }));
    expect(decodePlain((await c3.next()) ?? new Uint8Array()).body.case).toBe("pakeReply");
    c3.conn.receive(unsealed);
    await drain(c3);
    expect(c3.isClosed()).toBe(true);

    expect(m.config.totpSecret()).toEqual(secret);
    expect(m.audit.list().some((e) => e.action === "totp_set")).toBe(false);
    expect(m.totpSets()).toBe(0);
  });

  it("a paired device updates tunelo: Ack at once, a line in the consent log, an error where it cannot", async () => {
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
    m.config.addDevice(phone.publicKey, "phone");
    const l = await link(m, phone);

    expect(await l.request("1", { case: "agentUpdateCheck", value: {} })).toMatchObject({ case: "machineInfo", value: { agentUpdate: { latestVersion: "9.9.9" } } });
    expect((await l.request("2", { case: "agentUpdateStart", value: {} }))?.case).toBe("ack");
    expect(started).toBe(1);
    expect(m.audit.list().some((e) => e.action === "agent_update" && e.detail === "9.9.9")).toBe(true);

    const none = await machine([fakeProvider()], { updater: new AgentUpdater({ supported: () => false, announce: () => undefined, emit: () => undefined, restart: () => undefined, log: () => undefined }) });
    cores.push(none.core);
    none.config.addDevice(phone.publicKey, "phone");
    const l2 = await link(none, phone);
    const refused = await l2.request("1", { case: "agentUpdateStart", value: {} });
    expect(refused?.case === "error" && refused.value.reason).toBe(ErrorReason.UPDATE_UNAVAILABLE);
  });
});
