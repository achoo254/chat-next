// The agent's OTLP receiver and its tokens as one part of the service:
// started (start-otlp-receiver.ts), stopped, and the token rotated or the
// previous one revoked while it runs (the receiver reads the tokens for each
// request). Every token in use is remembered by mcp/redact.ts, so no output
// of the agent shows one.
import { rememberSecret } from "../../mcp/redact.ts";
import type { OtlpReceiver } from "./otlp-receiver.ts";
import { type ReceiverTokens, revokePreviousToken, rotateTokens } from "./receiver-token.ts";
import { type ReceiverStatusState, type StartReceiverOptions, startOtlpReceiver } from "./start-otlp-receiver.ts";

/** How often a token file that could not be read is read again. */
export const TOKEN_RETRY_EVERY_MS = 30_000;

export type OtlpReceiverHostOptions = Omit<StartReceiverOptions, "tokens"> & { tokenRetryEveryMs?: number };

export class OtlpReceiverHost {
  private receiver: OtlpReceiver | undefined;
  private tokens: ReceiverTokens | undefined;
  private current: ReceiverStatusState = "off";
  /** Set while the token file cannot be read: start is tried again until it can (the file is never replaced). */
  private retry: ReturnType<typeof setInterval> | undefined;
  /** Bumped by stop(), so a start still running when it was called lets go of what it started. */
  private generation = 0;
  private attempting = false;

  constructor(private readonly opts: OtlpReceiverHostOptions) {}

  get state(): ReceiverStatusState {
    return this.current;
  }

  /** The running receiver (its port and counters), if any. */
  get running(): OtlpReceiver | undefined {
    return this.receiver;
  }

  /** The tokens accepted now: the current one and the previous one, if kept. */
  tokenValues(): string[] {
    return [this.tokens?.current, this.tokens?.previous].filter((t): t is string => t !== undefined);
  }

  /** Starts the receiver; with a token file that cannot be read, tries again every TOKEN_RETRY_EVERY_MS until it can. */
  async start(): Promise<void> {
    await this.attempt();
    if (this.current !== "token-unreadable" || this.retry) return;
    this.retry = setInterval(() => void this.attempt(), this.opts.tokenRetryEveryMs ?? TOKEN_RETRY_EVERY_MS);
    this.retry.unref?.();
  }

  private async attempt(): Promise<void> {
    if (this.attempting) return;
    this.attempting = true;
    const generation = this.generation;
    const started = await startOtlpReceiver({ ...this.opts, tokens: () => this.tokens }).finally(() => (this.attempting = false));
    if (generation !== this.generation) {
      // Stopped while it ran: let go of what started.
      await started.receiver?.stop();
      return;
    }
    this.receiver = started.receiver;
    if (started.tokens) this.use(started.tokens);
    this.current = started.state;
    if (started.state !== "token-unreadable") this.clearRetry();
  }

  private clearRetry(): void {
    clearInterval(this.retry);
    this.retry = undefined;
  }

  /** Stops the receiver (its queue handed on) and any retry; never rejects. */
  async stop(): Promise<void> {
    this.clearRetry();
    this.generation++;
    await this.receiver?.stop().catch((err: unknown) => this.opts.problems("otlp-stop", err));
    this.receiver = undefined;
    this.current = "off";
  }

  /** A new token; the current one stays accepted until the next rotation or revokePrevious(). */
  async rotate(): Promise<ReceiverTokens> {
    return this.use(await rotateTokens(this.opts.dataDir));
  }

  /** Stops accepting the token before the last rotation, now. */
  async revokePrevious(): Promise<ReceiverTokens> {
    return this.use(await revokePreviousToken(this.opts.dataDir));
  }

  private use(tokens: ReceiverTokens): ReceiverTokens {
    this.tokens = tokens;
    for (const token of this.tokenValues()) rememberSecret(token);
    return tokens;
  }
}
