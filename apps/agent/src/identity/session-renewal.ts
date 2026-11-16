/**
 * Keeps the machine's grant alive. The IdP ends a grant nobody refreshed for
 * 30 days, and a refresh happens only when someone asks for an access token:
 * a tunnel that stays connected asks for none, so its sign-in would die
 * quietly. The background service therefore renews the grant about once a
 * day (session.ts `renew`, under the session lock), with jitter so machines
 * do not all call the IdP at once.
 *
 * At start, a grant renewed within the last day waits for its next turn; an
 * older one (or one never renewed) is renewed after a few minutes rather than
 * during boot. A renewal another process made within the window counts, so
 * the shared refresh token is not rotated twice. A failure that may pass
 * (network, IdP down, Keychain locked) is tried again after 1 minute,
 * doubling up to 1 hour. A grant the IdP no longer knows stops the renewals
 * until `tunelo login`, which never runs by itself.
 */
import { retryDelay } from "../registration-status.ts";
import { type RenewResult, SessionExpiredError } from "./session.ts";

const HOUR_MS = 60 * 60_000;
/** Time between renewals. */
export const RENEW_EVERY_MS = 24 * HOUR_MS;
/** Up to this much earlier or later than RENEW_EVERY_MS. */
export const RENEW_JITTER_MS = 2 * HOUR_MS;
/** A renewal younger than this is not repeated (another process just did it). */
export const RENEWED_RECENTLY_MS = 20 * HOUR_MS;
/** A grant due at start is renewed after this… */
export const START_DELAY_MS = 3 * 60_000;
/** …plus up to this much. */
export const START_JITTER_MS = 5 * 60_000;

/** What the renewal needs of the session: never a token. */
export interface RenewableSession {
	lastRenewedAt(): number | undefined;
	renew(recentMs: number): Promise<RenewResult>;
}

export interface SessionRenewalDeps {
	session: RenewableSession;
	log: (line: string) => void;
	/** The grant is gone: show the apps as needing `tunelo login`. */
	onSignedOut: (detail: string) => void;
	now?: () => number;
	/** A number in [0, 1). */
	random?: () => number;
	/** Runs `fn` after `ms`; returns a cancel. */
	schedule?: (fn: () => void, ms: number) => () => void;
}

export class SessionRenewal {
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly schedule: (fn: () => void, ms: number) => () => void;
	private cancelTimer: (() => void) | undefined;
	private running = false;
	private stopped = false;
	/** Set when the grant is gone: nothing is scheduled until retryNow. */
	private signedOut = false;
	private failures = 0;

	constructor(private readonly deps: SessionRenewalDeps) {
		this.now = deps.now ?? Date.now;
		this.random = deps.random ?? Math.random;
		this.schedule =
			deps.schedule ??
			((fn, ms) => {
				const timer = setTimeout(fn, ms);
				timer.unref?.();
				return () => clearTimeout(timer);
			});
	}

	/** Schedules the first renewal from the stored mark. */
	start(): void {
		if (this.stopped) return;
		this.arm(this.delayAfter(this.deps.session.lastRenewedAt()));
	}

	/** After `tunelo login`: a new grant, so renewals start over. */
	retryNow(): void {
		if (this.stopped) return;
		this.signedOut = false;
		this.failures = 0;
		this.start();
	}

	stop(): void {
		this.stopped = true;
		this.cancel();
	}

	/** The wait before the renewal that follows one at `renewedAt`. */
	private delayAfter(renewedAt: number | undefined): number {
		const startDelay = START_DELAY_MS + this.random() * START_JITTER_MS;
		if (renewedAt === undefined) return startDelay;
		const jitter = (this.random() * 2 - 1) * RENEW_JITTER_MS;
		return Math.max(startDelay, renewedAt + RENEW_EVERY_MS + jitter - this.now());
	}

	private arm(ms: number): void {
		this.cancel();
		this.cancelTimer = this.schedule(() => {
			this.cancelTimer = undefined;
			void this.run();
		}, ms);
	}

	private cancel(): void {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
	}

	private async run(): Promise<void> {
		if (this.stopped || this.signedOut || this.running) return;
		this.running = true;
		try {
			const result = await this.deps.session.renew(RENEWED_RECENTLY_MS);
			this.failures = 0;
			if (result.renewed) this.deps.log("sign-in renewed");
			if (!this.stopped) this.arm(this.delayAfter(result.renewedAt));
		} catch (err) {
			if (this.stopped) return;
			if (err instanceof SessionExpiredError) {
				this.signedOut = true;
				this.cancel();
				this.deps.log(`sign-in renewal stopped: ${err.message}`);
				this.deps.onSignedOut("the sign-in has expired or was revoked; run `tunelo login`");
				return;
			}
			this.failures++;
			const delay = retryDelay(this.failures);
			const message = err instanceof Error ? err.message : String(err);
			this.deps.log(`sign-in renewal failed: ${message}; trying again in ${Math.round(delay / 60_000)} min`);
			this.arm(delay);
		} finally {
			this.running = false;
		}
	}
}
