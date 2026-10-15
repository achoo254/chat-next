import { describe, expect, it } from "vitest";
import { LOADER_DELAY_MS, LOADER_MIN_MS, LoaderGate, SplashCover, type LoaderClock } from "../src/components/loader-gate.ts";

/** A hand-driven clock: time moves only through advance(), deferred work runs on settle(). */
class FakeClock implements LoaderClock {
	time = 0;
	private timers: { at: number; run: () => void; id: number }[] = [];
	private deferred: (() => void)[] = [];
	private nextId = 1;

	now = () => this.time;
	setTimeout = (run: () => void, ms: number) => {
		const id = this.nextId++;
		this.timers.push({ at: this.time + ms, run, id });
		return id;
	};
	clearTimeout = (handle: unknown) => {
		this.timers = this.timers.filter((timer) => timer.id !== handle);
	};
	defer = (run: () => void) => {
		this.deferred.push(run);
	};

	/** Ends the current commit: runs what was deferred to it. */
	settle(): void {
		const runs = this.deferred;
		this.deferred = [];
		for (const run of runs) run();
	}

	advance(ms: number): void {
		const end = this.time + ms;
		for (;;) {
			const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
			if (due === undefined) break;
			this.timers = this.timers.filter((timer) => timer !== due);
			this.time = due.at;
			due.run();
			this.settle();
		}
		this.time = end;
	}
}

function gateWith(clock: FakeClock, cover: SplashCover | null = null): { gate: LoaderGate; phases: string[] } {
	const gate = new LoaderGate(clock, cover);
	const phases: string[] = [];
	gate.subscribe(() => phases.push(`${clock.time}:${gate.getPhase()}`));
	return { gate, phases };
}

describe("loader gate", () => {
	it("shows nothing for a wait shorter than the delay", () => {
		const clock = new FakeClock();
		const { gate, phases } = gateWith(clock);
		const release = gate.acquire();
		clock.advance(LOADER_DELAY_MS - 1);
		release();
		clock.settle();
		clock.advance(1000);
		expect(phases).toEqual(["0:wait", `${LOADER_DELAY_MS - 1}:idle`]);
	});

	it("shows the loader after the delay and reports when its minimum time is over", () => {
		const clock = new FakeClock();
		const { gate, phases } = gateWith(clock);
		gate.acquire();
		clock.advance(LOADER_DELAY_MS + LOADER_MIN_MS);
		expect(phases).toEqual(["0:wait", `${LOADER_DELAY_MS}:show`, `${LOADER_DELAY_MS + LOADER_MIN_MS}:shown`]);
		expect(gate.since).toBe(LOADER_DELAY_MS);
	});

	it("counts one wait across loaders that take over in the same commit", () => {
		const clock = new FakeClock();
		const { gate, phases } = gateWith(clock);
		const code = gate.acquire(true);
		clock.advance(200);
		// The code arrives; the screen's data loader takes over in the same commit.
		code();
		const data = gate.acquire();
		clock.settle();
		clock.advance(LOADER_DELAY_MS - 200);
		expect(gate.getPhase()).toBe("show");
		data();
		clock.settle();
		expect(phases).toEqual(["0:wait", `${LOADER_DELAY_MS}:show`, `${LOADER_DELAY_MS}:idle`]);
	});

	it("keeps Suspense content waiting until a fallback loader on screen had its minimum time", async () => {
		const clock = new FakeClock();
		const { gate } = gateWith(clock);
		const fallback = gate.acquire(true);
		expect(gate.contentWait()).toBeNull();
		clock.advance(LOADER_DELAY_MS + 100);
		const wait = gate.contentWait();
		expect(wait).not.toBeNull();
		// The same promise for every retry of the content.
		expect(gate.contentWait()).toBe(wait);
		let done = false;
		void wait?.then(() => {
			done = true;
		});
		clock.advance(LOADER_MIN_MS - 100 - 1);
		await Promise.resolve();
		expect(done).toBe(false);
		clock.advance(1);
		await Promise.resolve();
		expect(done).toBe(true);
		expect(gate.contentWait()).toBeNull();
		fallback();
	});

	it("does not hold content behind a loader that is not a Suspense fallback", () => {
		const clock = new FakeClock();
		const { gate } = gateWith(clock);
		gate.acquire();
		clock.advance(LOADER_DELAY_MS + 10);
		expect(gate.getPhase()).toBe("show");
		expect(gate.contentWait()).toBeNull();
	});

	it("starts over once nothing loads any more", () => {
		const clock = new FakeClock();
		const { gate } = gateWith(clock);
		const first = gate.acquire();
		clock.advance(LOADER_DELAY_MS + LOADER_MIN_MS);
		first();
		clock.settle();
		expect(gate.getPhase()).toBe("idle");
		gate.acquire();
		clock.advance(LOADER_DELAY_MS - 1);
		expect(gate.getPhase()).toBe("wait");
	});

	it("releases twice without counting twice", () => {
		const clock = new FakeClock();
		const { gate } = gateWith(clock);
		const a = gate.acquire();
		const b = gate.acquire();
		a();
		a();
		clock.settle();
		expect(gate.getPhase()).toBe("wait");
		b();
		clock.settle();
		expect(gate.getPhase()).toBe("idle");
	});
});

describe("splash cover", () => {
	it("keeps the splash while a gate loads and hides it for good once the first screen is ready", () => {
		const clock = new FakeClock();
		const splash = document.createElement("div");
		const cover = new SplashCover(splash, clock);
		const page = cover.hold();
		const { gate, phases } = gateWith(clock, cover);
		// The screen takes over from the page loader in one commit.
		page();
		const screen = gate.acquire(true);
		clock.settle();
		clock.advance(2000);
		// No loader of its own: the splash covers.
		expect(phases).toEqual(["0:wait"]);
		expect(splash.hidden).toBe(false);
		screen();
		clock.settle();
		clock.settle();
		expect(splash.hidden).toBe(true);
		expect(cover.active).toBe(false);
		// After the start, gates draw their own loader.
		gate.acquire();
		clock.advance(LOADER_DELAY_MS);
		expect(gate.getPhase()).toBe("show");
	});

	it("is inactive without a splash element", () => {
		const cover = new SplashCover(null);
		expect(cover.active).toBe(false);
	});
});
