import { describe, expect, test } from "vitest";
import {
	RENEWED_RECENTLY_MS,
	RENEW_EVERY_MS,
	type RenewableSession,
	START_DELAY_MS,
	START_JITTER_MS,
	SessionRenewal,
} from "../../src/identity/session-renewal.ts";
import { type RenewResult, SessionExpiredError } from "../../src/identity/session.ts";
import { retryDelay } from "../../src/registration-status.ts";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

type Timer = { fn: () => void; ms: number; cancelled: boolean };

/** A renewal with a fake clock and timer queue; `answers` are the session's renew results in turn. */
function harness(lastRenewedAt: number | undefined, answers: (RenewResult | Error)[]) {
	const timers: Timer[] = [];
	const calls: number[] = [];
	const signedOut: string[] = [];
	const logs: string[] = [];
	const session: RenewableSession = {
		lastRenewedAt: () => lastRenewedAt,
		renew: async (recentMs) => {
			calls.push(recentMs);
			const next = answers.shift();
			if (next === undefined) throw new Error("no answer left");
			if (next instanceof Error) throw next;
			return next;
		},
	};
	const renewal = new SessionRenewal({
		session,
		log: (line) => logs.push(line),
		onSignedOut: (detail) => signedOut.push(detail),
		now: () => NOW,
		// Midway: no jitter on the daily turn, half of it on the start delay.
		random: () => 0.5,
		schedule: (fn, ms) => {
			const timer: Timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	});
	const pending = () => timers.filter((t) => !t.cancelled);
	/** Fires the one pending timer and lets its renewal settle. */
	const fire = async () => {
		const live = pending();
		expect(live).toHaveLength(1);
		const [timer] = live;
		if (!timer) return;
		timer.cancelled = true;
		timer.fn();
		await new Promise((r) => setTimeout(r, 0));
	};
	return { renewal, timers, pending, fire, calls, signedOut, logs };
}

const START_MS = START_DELAY_MS + START_JITTER_MS / 2;

describe("session renewal", () => {
	test("a grant never renewed is renewed a few minutes after start, not at once", () => {
		const h = harness(undefined, []);
		h.renewal.start();
		expect(h.pending().map((t) => t.ms)).toEqual([START_MS]);
		expect(h.calls).toEqual([]);
	});

	test("a grant renewed within the day waits for its turn; an older one is renewed soon", () => {
		const recent = harness(NOW - HOUR, []);
		recent.renewal.start();
		expect(recent.pending().map((t) => t.ms)).toEqual([RENEW_EVERY_MS - HOUR]);
		const old = harness(NOW - 25 * HOUR, []);
		old.renewal.start();
		expect(old.pending().map((t) => t.ms)).toEqual([START_MS]);
	});

	test("the daily turn has jitter of up to two hours either way", () => {
		for (const [random, expected] of [
			[0, RENEW_EVERY_MS - 2 * HOUR],
			[0.75, RENEW_EVERY_MS + HOUR],
		] as const) {
			const timers: number[] = [];
			const renewal = new SessionRenewal({
				session: { lastRenewedAt: () => NOW, renew: async () => ({ renewed: true, renewedAt: NOW }) },
				log: () => undefined,
				onSignedOut: () => undefined,
				now: () => NOW,
				random: () => random,
				schedule: (_fn, ms) => {
					timers.push(ms);
					return () => undefined;
				},
			});
			renewal.start();
			expect(timers).toEqual([expected]);
		}
	});

	test("after a renewal, by this process or another, the next one is a day later", async () => {
		const h = harness(undefined, [{ renewed: true, renewedAt: NOW }]);
		h.renewal.start();
		await h.fire();
		expect(h.calls).toEqual([RENEWED_RECENTLY_MS]);
		expect(h.logs).toContain("sign-in renewed");
		expect(h.pending().map((t) => t.ms)).toEqual([RENEW_EVERY_MS]);
	});

	test("a dead grant stops the renewals, asks for `tunelo login`, and never signs in by itself", async () => {
		const h = harness(undefined, [new SessionExpiredError("Your sign-in has expired. Run `tunelo login` again.")]);
		h.renewal.start();
		await h.fire();
		expect(h.pending()).toEqual([]);
		expect(h.calls).toHaveLength(1);
		expect(h.signedOut).toHaveLength(1);
		expect(h.signedOut[0]).toContain("tunelo login");
		expect(h.logs.some((l) => l.includes("tunelo login"))).toBe(true);
		// `tunelo login` starts it over.
		h.renewal.retryNow();
		expect(h.pending()).toHaveLength(1);
	});

	test("a network failure is tried again after 1 minute, doubling, and a success goes back to daily", async () => {
		const h = harness(undefined, [new TypeError("fetch failed"), new TypeError("fetch failed"), { renewed: true, renewedAt: NOW }]);
		h.renewal.start();
		await h.fire();
		expect(h.pending().map((t) => t.ms)).toEqual([retryDelay(1)]);
		expect(retryDelay(1)).toBe(60_000);
		await h.fire();
		expect(h.pending().map((t) => t.ms)).toEqual([retryDelay(2)]);
		expect(h.logs.filter((l) => l.startsWith("sign-in renewal failed: fetch failed"))).toHaveLength(2);
		await h.fire();
		expect(h.pending().map((t) => t.ms)).toEqual([RENEW_EVERY_MS]);
		expect(h.signedOut).toEqual([]);
	});

	test("stop cancels the timer, and a renewal that ends after it schedules nothing", async () => {
		const h = harness(undefined, [new TypeError("fetch failed")]);
		h.renewal.start();
		h.renewal.stop();
		expect(h.pending()).toEqual([]);
		const running = harness(undefined, [new TypeError("fetch failed")]);
		running.renewal.start();
		const [timer] = running.pending();
		timer?.fn();
		running.renewal.stop();
		await new Promise((r) => setTimeout(r, 0));
		expect(running.pending().filter((t) => t !== timer)).toEqual([]);
	});
});
