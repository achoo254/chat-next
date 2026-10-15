import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatus, OFFLINE_AFTER_MS, type NetworkStatus } from "../src/messaging/data/connection-status.ts";

class FakeNetwork implements NetworkStatus {
	private up = true;
	private readonly listeners = new Set<() => void>();
	online(): boolean {
		return this.up;
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	set(up: boolean): void {
		this.up = up;
		for (const listener of this.listeners) listener();
	}
	get subscribers(): number {
		return this.listeners.size;
	}
}

describe("ConnectionStatus", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function track(network = new FakeNetwork()) {
		const changes: string[] = [];
		const status = new ConnectionStatus(network, () => changes.push(status.get()), () => Date.now());
		return { status, network, changes };
	}

	it("shows offline as soon as the device loses the network, even with the socket still open", () => {
		const { status, network, changes } = track();
		status.setCore("connected");
		network.set(false);
		expect(status.get()).toBe("offline");
		network.set(true);
		expect(status.get()).toBe("connected");
		expect(changes).toEqual(["connected", "offline", "connected"]);
	});

	it("says connecting while the socket reconnects, then waiting after the grace period", () => {
		const { status, changes } = track();
		status.setCore("connected");
		status.setCore("waiting");
		expect(status.get()).toBe("connecting");
		status.setCore("connecting");
		vi.advanceTimersByTime(OFFLINE_AFTER_MS - 1);
		expect(status.get()).toBe("connecting");
		vi.advanceTimersByTime(1);
		expect(status.get()).toBe("waiting");
		// Retries keep the "no network" state instead of flipping back.
		status.setCore("waiting");
		status.setCore("connecting");
		expect(status.get()).toBe("waiting");
		status.setCore("connected");
		expect(status.get()).toBe("connected");
		expect(changes).toEqual(["connected", "connecting", "waiting", "connected"]);
	});

	it("counts the grace period from the start when the socket never connected", () => {
		const { status } = track();
		expect(status.get()).toBe("connecting");
		vi.advanceTimersByTime(OFFLINE_AFTER_MS);
		expect(status.get()).toBe("waiting");
	});

	it("stops listening on dispose", () => {
		const { status, network, changes } = track();
		status.dispose();
		network.set(false);
		vi.advanceTimersByTime(OFFLINE_AFTER_MS);
		expect(changes).toEqual([]);
		expect(network.subscribers).toBe(0);
	});
});
