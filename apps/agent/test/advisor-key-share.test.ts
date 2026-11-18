// The account's TypeSafe key handed from machine to machine: the device asks
// the receiving machine for a ticket, the holding machine seals the key for
// the ticket's public key, and the receiver opens it. No frame either device
// gets carries the key; both machines log the hand-off with the fingerprint
// only; a ticket opens one key, for its own machine only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toBinary } from "@bufbuild/protobuf";
import { AdvisorKeySource, ErrorReason, type Frame, FrameSchema } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it } from "vitest";
import { AdvisorKeyStore } from "../src/advisor/advisor-key-store.ts";
import { AdvisorKeyTickets, MAX_TICKETS, TICKET_TTL_MS } from "../src/advisor/advisor-key-share.ts";
import { ConfigStore } from "../src/config.ts";
import { forgetSecrets, secretVariants } from "../src/mcp/redact.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { fakeProvider } from "./fake-provider.ts";
import { makeCore, tempDir } from "./harness.ts";
import { type DeviceLink, pairedDevice } from "./support/device-link.ts";

process.env.TUNELO_KEYSTORE = "file";

const KEY = "ts_live_6b2d8f0a4c1e3b5d7f9a2c4e6b8d0f1a";
const OWN = "ts_live_0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const FINGERPRINT = createHash("sha256").update(KEY).digest("hex").slice(0, 6);
const SET_AT = 1_800_000_000_000n;

afterEach(() => forgetSecrets());

type Machine = { dir: string; keys: AdvisorKeyStore; device: DeviceLink; announced: () => number };

async function machine(): Promise<Machine> {
  const dir = tempDir("advisor-share-");
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const keys = new AdvisorKeyStore({ configDir: dir, audit });
  const { core } = makeCore([fakeProvider()]);
  let announced = 0;
  const device = await pairedDevice({ core, config: new ConfigStore(dir), audit, advisorKeys: keys, onAdvisorKey: () => announced++ });
  return { dir, keys, device, announced: () => announced };
}

let ids = 0;
async function ask(m: Machine, body: Parameters<DeviceLink["request"]>[1]): Promise<Frame> {
  ids += 1;
  return m.device.request(`r${ids}`, body);
}

function reasonOf(frame: Frame): ErrorReason | undefined {
  return frame.body.case === "error" ? frame.body.value.reason : undefined;
}

/** The three legs as a device runs them; the sealed bytes it relays, or the refusal of a leg. */
async function handOff(source: Machine, target: Machine): Promise<{ answer: Frame; sealed?: Uint8Array; ticketId?: string }> {
  const ticket = await ask(target, { case: "advisorKeyShareBegin", value: {} });
  if (ticket.body.case !== "advisorKeyShareTicket") return { answer: ticket };
  const { ticketId, publicKey } = ticket.body.value;
  expect(publicKey).toHaveLength(32);
  const sealed = await ask(source, { case: "advisorKeySeal", value: { recipientPublicKey: publicKey } });
  if (sealed.body.case !== "advisorKeySealed") return { answer: sealed, ticketId };
  expect(sealed.body.value.fingerprint).toBe(FINGERPRINT);
  const bytes = sealed.body.value.sealed;
  const answer = await ask(target, { case: "advisorKeyShareOpen", value: { ticketId, sealed: bytes } });
  return { answer, sealed: bytes, ticketId };
}

/** Every frame a device received, as bytes. */
function sentBytes(frames: readonly Frame[]): string {
  return frames.map((f) => Buffer.from(toBinary(FrameSchema, f)).toString("latin1")).join("\n");
}

function auditOf(m: Machine): string {
  return readFileSync(join(m.dir, "audit.jsonl"), "utf8");
}

describe("the account's key from machine to machine", () => {
  it("hands the key on sealed: the receiver keeps it as the account's with the same set time; nothing a device got carries it", async () => {
    const source = await machine();
    const target = await machine();
    const set = await ask(source, { case: "advisorSetKey", value: { key: KEY, source: AdvisorKeySource.ACCOUNT, setAt: SET_AT } });
    expect(set.body.case).toBe("ack");
    expect(source.keys.status()).toMatchObject({ source: "account", setAt: Number(SET_AT), fingerprint: FINGERPRINT });

    const { answer, sealed } = await handOff(source, target);
    expect(answer.body.case).toBe("ack");
    expect(target.announced()).toBe(1);
    expect(target.keys.status()).toEqual({
      keySet: true,
      fingerprint: FINGERPRINT,
      setByDevice: source.keys.status().setByDevice,
      setAt: Number(SET_AT),
      source: "account",
    });
    expect(await target.keys.key()).toBe(KEY);

    // The relayed bytes and every frame either device got never hold the key.
    const relayed = Buffer.from(sealed ?? new Uint8Array()).toString("latin1");
    for (const form of secretVariants(KEY)) {
      expect(relayed).not.toContain(form);
      expect(sentBytes(source.device.received)).not.toContain(form);
      expect(sentBytes(target.device.received)).not.toContain(form);
    }
    // Both machines log the hand-off, with the fingerprint only.
    expect(auditOf(source)).toMatch(new RegExp(`"action":"advisor_key_share_sent","path":"[^"]+","detail":"${FINGERPRINT}"`));
    expect(auditOf(target)).toMatch(new RegExp(`"action":"advisor_key_share_received","path":"[^"]+","detail":"${FINGERPRINT}"`));
    expect(auditOf(source)).not.toContain(KEY);
    expect(auditOf(target)).not.toContain(KEY);
  });

  it("a ticket opens one key, for its own machine only; forged bytes are refused and nothing is saved", async () => {
    const source = await machine();
    const target = await machine();
    const other = await machine();
    await ask(source, { case: "advisorSetKey", value: { key: KEY, source: AdvisorKeySource.ACCOUNT } });

    // Sealed for another machine's ticket: the target cannot open it.
    const theirs = await ask(other, { case: "advisorKeyShareBegin", value: {} });
    const mine = await ask(target, { case: "advisorKeyShareBegin", value: {} });
    if (theirs.body.case !== "advisorKeyShareTicket" || mine.body.case !== "advisorKeyShareTicket") throw new Error("no ticket");
    const forOther = await ask(source, { case: "advisorKeySeal", value: { recipientPublicKey: theirs.body.value.publicKey } });
    if (forOther.body.case !== "advisorKeySealed") throw new Error("not sealed");
    const wrong = await ask(target, { case: "advisorKeyShareOpen", value: { ticketId: mine.body.value.ticketId, sealed: forOther.body.value.sealed } });
    expect(reasonOf(wrong)).toBe(ErrorReason.ADVISOR_KEY_SHARE_FAILED);

    // The right ticket, used twice: the second time it is gone.
    const { answer, sealed, ticketId } = await handOff(source, target);
    expect(answer.body.case).toBe("ack");
    const again = await ask(target, { case: "advisorKeyShareOpen", value: { ticketId: ticketId ?? "", sealed: sealed ?? new Uint8Array() } });
    expect(reasonOf(again)).toBe(ErrorReason.ADVISOR_KEY_SHARE_FAILED);

    // A flipped byte, an unknown ticket.
    const fresh = await ask(other, { case: "advisorKeyShareBegin", value: {} });
    if (fresh.body.case !== "advisorKeyShareTicket") throw new Error("no ticket");
    const good = await ask(source, { case: "advisorKeySeal", value: { recipientPublicKey: fresh.body.value.publicKey } });
    if (good.body.case !== "advisorKeySealed") throw new Error("not sealed");
    const forged = good.body.value.sealed.slice();
    forged[forged.length - 1] = (forged.at(-1) ?? 0) ^ 1;
    expect(reasonOf(await ask(other, { case: "advisorKeyShareOpen", value: { ticketId: fresh.body.value.ticketId, sealed: forged } }))).toBe(
      ErrorReason.ADVISOR_KEY_SHARE_FAILED,
    );
    expect(reasonOf(await ask(other, { case: "advisorKeyShareOpen", value: { ticketId: "nope", sealed: good.body.value.sealed } }))).toBe(
      ErrorReason.ADVISOR_KEY_SHARE_FAILED,
    );
    expect(other.keys.status().keySet).toBe(false);
    // A public key that is not 32 bytes is refused before anything is sealed.
    const bad = await ask(source, { case: "advisorKeySeal", value: { recipientPublicKey: new Uint8Array(31) } });
    expect(bad.body.case).toBe("error");
  });

  it("an own key is never handed on, never replaced by the account's, and removed only on its own", async () => {
    const source = await machine();
    const target = await machine();
    await ask(source, { case: "advisorSetKey", value: { key: OWN } });
    expect(source.keys.status().source).toBe("own");
    const { answer } = await handOff(source, target);
    expect(reasonOf(answer)).toBe(ErrorReason.ADVISOR_NO_KEY);

    // The target keeps its own key: the account's key, pasted or handed on, is refused.
    const holder = await machine();
    await ask(holder, { case: "advisorSetKey", value: { key: KEY, source: AdvisorKeySource.ACCOUNT } });
    await ask(target, { case: "advisorSetKey", value: { key: OWN, source: AdvisorKeySource.OWN } });
    expect(reasonOf((await handOff(holder, target)).answer)).toBe(ErrorReason.ADVISOR_OWN_KEY);
    expect(reasonOf(await ask(target, { case: "advisorSetKey", value: { key: KEY, source: AdvisorKeySource.ACCOUNT } }))).toBe(ErrorReason.ADVISOR_OWN_KEY);
    expect(await target.keys.key()).toBe(OWN);

    // Removing the account's key leaves an own key; removing the own key takes it.
    expect((await ask(target, { case: "advisorRemoveKey", value: { source: AdvisorKeySource.ACCOUNT } })).body.case).toBe("ack");
    expect(target.keys.status().source).toBe("own");
    await ask(target, { case: "advisorRemoveKey", value: { source: AdvisorKeySource.OWN } });
    expect(target.keys.status().keySet).toBe(false);
    // An older device's removal takes whatever key is kept.
    await ask(holder, { case: "advisorRemoveKey", value: {} });
    expect(holder.keys.status().keySet).toBe(false);
  });

  it("promotes a machine's own key to the account's (logged), which then hands on", async () => {
    const source = await machine();
    const target = await machine();
    expect(reasonOf(await ask(source, { case: "advisorKeyPromote", value: { setAt: SET_AT } }))).toBe(ErrorReason.ADVISOR_NO_KEY);
    await source.keys.set(KEY, "local");
    const promoted = await ask(source, { case: "advisorKeyPromote", value: { setAt: SET_AT } });
    expect(promoted.body.case).toBe("ack");
    expect(source.keys.status()).toMatchObject({ source: "account", setAt: Number(SET_AT), setByDevice: "local", fingerprint: FINGERPRINT });
    expect(auditOf(source)).toMatch(new RegExp(`"action":"advisor_key_promote","path":"[^"]+","detail":"${FINGERPRINT}"`));
    // Promoting again: there is no own key any more.
    expect(reasonOf(await ask(source, { case: "advisorKeyPromote", value: { setAt: SET_AT } }))).toBe(ErrorReason.ADVISOR_NO_KEY);
    expect((await handOff(source, target)).answer.body.case).toBe("ack");
    expect(target.keys.status()).toMatchObject({ source: "account", setByDevice: "local" });
  });
});

describe("hand-off tickets", () => {
  it("expire after their time and are capped per link, the oldest dropped first", async () => {
    let now = 1_000;
    const tickets = new AdvisorKeyTickets(() => now);
    const first = await tickets.begin();
    now += TICKET_TTL_MS;
    expect(tickets.take(first.ticketId)).toBeUndefined();

    const made = [];
    for (let i = 0; i <= MAX_TICKETS; i++) made.push(await tickets.begin());
    expect(tickets.take(made[0]?.ticketId ?? "")).toBeUndefined();
    expect(tickets.take(made.at(-1)?.ticketId ?? "")).toBeDefined();
  });
});
