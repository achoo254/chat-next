// Advisor's TypeSafe key over one device's link: the machine's own key and the
// account's (AdvisorSetKey, AdvisorRemoveKey, AdvisorKeyPromote) and the
// account's key handed from machine to machine (AdvisorKeyShareBegin on the
// machine that receives, AdvisorKeySeal on the one that holds it,
// AdvisorKeyShareOpen back on the first; advisor/advisor-key-share.ts). A key
// arrives only here, end to end, and goes straight to its own store; no frame
// from here ever carries it, only sealed bytes or its fingerprint.
import type { MessageInitShape } from "@bufbuild/protobuf";
import { AdvisorKeySource, type Frame, type FrameSchema } from "@achoo254/chat-proto/remote/remote";
import { type AdvisorKeySourceName, type AdvisorKeyStore, advisorKeyFingerprint, rememberAdvisorKey } from "../advisor/advisor-key-store.ts";
import { AdvisorKeyShareError, AdvisorKeyTickets, openAdvisorKey, sealAdvisorKey, ticketTag } from "../advisor/advisor-key-share.ts";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

export type AdvisorKeyFrame = Extract<
  Frame["body"],
  { case: "advisorSetKey" | "advisorRemoveKey" | "advisorKeyShareBegin" | "advisorKeySeal" | "advisorKeyShareOpen" | "advisorKeyPromote" }
>;

/** The kind of key a request names; undefined for none (an older device: the machine's own key, or any key to remove). */
function sourceName(source: AdvisorKeySource): AdvisorKeySourceName | undefined {
  if (source === AdvisorKeySource.ACCOUNT) return "account";
  if (source === AdvisorKeySource.OWN) return "own";
  return undefined;
}

/** A set time from a device: a positive exact integer, or 0 for the machine's clock. */
function setAtOf(value: bigint): number {
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
}

export class AdvisorKeyLink {
  /** The tickets this device asked for on this link; dropped with the link. */
  private readonly tickets: AdvisorKeyTickets;

  constructor(
    private readonly keys: AdvisorKeyStore,
    private readonly send: (id: string, body: Body) => void,
    private readonly device: () => string,
    /** The key changed: every device hears the machine's info again. */
    private readonly changed: () => void,
    now?: () => number,
  ) {
    this.tickets = new AdvisorKeyTickets(now);
  }

  /** Handles one request; a refusal is thrown for the caller to answer by id. */
  async handle(id: string, b: AdvisorKeyFrame): Promise<void> {
    switch (b.case) {
      case "advisorSetKey": {
        const source = sourceName(b.value.source) ?? "own";
        await this.keys.set(b.value.key, this.device(), { source, setAt: source === "account" ? setAtOf(b.value.setAt) : 0 });
        return this.done(id);
      }
      case "advisorRemoveKey":
        await this.keys.remove(this.device(), sourceName(b.value.source));
        return this.done(id);
      case "advisorKeyPromote":
        await this.keys.promote(this.device(), setAtOf(b.value.setAt));
        return this.done(id);
      case "advisorKeyShareBegin": {
        const ticket = await this.tickets.begin();
        return this.send(id, { case: "advisorKeyShareTicket", value: ticket });
      }
      case "advisorKeySeal": {
        // Checked before the key is opened: a public key that is not 32 bytes is refused first.
        const tag = ticketTag(b.value.recipientPublicKey);
        const shared = await this.keys.shareAccountKey(this.device(), tag);
        const sealed = await sealAdvisorKey(b.value.recipientPublicKey, shared);
        return this.send(id, { case: "advisorKeySealed", value: { sealed, fingerprint: advisorKeyFingerprint(shared.key) } });
      }
      case "advisorKeyShareOpen": {
        const ticket = this.tickets.take(b.value.ticketId);
        if (ticket === undefined) throw new AdvisorKeyShareError("failed");
        const shared = await openAdvisorKey(ticket, b.value.sealed);
        // Hidden from every output of this process before anything else happens to it.
        rememberAdvisorKey(shared.key);
        await this.keys.receive(shared, this.device(), ticketTag(ticket.publicKey));
        return this.done(id);
      }
    }
  }

  private done(id: string): void {
    this.send(id, { case: "ack", value: {} });
    this.changed();
  }
}
