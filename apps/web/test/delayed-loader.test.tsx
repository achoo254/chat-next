import { act, render, screen } from "@testing-library/react";
import { Suspense, use, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DelayedLoader, LoaderBoundary, Ready, useLoader } from "../src/components/delayed-loader.tsx";
import { LOADER_DELAY_MS, LOADER_MIN_MS } from "../src/components/loader-gate.ts";
import { resource } from "../src/components/preload.ts";
import { I18nProvider } from "../src/i18n/i18n.tsx";

function Loading({ loading }: { loading: boolean }) {
	const loader = useLoader(loading, "Đang tải danh sách…");
	return loader ?? <p>Nội dung</p>;
}

/** Lets the gate's deferred work (a microtask) and React's commits run. */
async function advance(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

function status(): HTMLElement | null {
	return screen.queryByRole("status");
}

describe("delayed loader", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps an empty frame for a short load, then shows the content without any loader", async () => {
		const { rerender, container } = render(
			<I18nProvider>
				<Loading loading />
			</I18nProvider>,
		);
		expect(status()).toBeNull();
		expect(container.querySelector(".brand-loader[aria-busy='true']")).not.toBeNull();
		await advance(LOADER_DELAY_MS - 20);
		expect(status()).toBeNull();
		rerender(
			<I18nProvider>
				<Loading loading={false} />
			</I18nProvider>,
		);
		expect(screen.getByText("Nội dung")).toBeTruthy();
		await advance(1000);
		expect(status()).toBeNull();
	});

	it("shows the loader after the delay and keeps it for its minimum time", async () => {
		const { rerender } = render(
			<I18nProvider>
				<Loading loading />
			</I18nProvider>,
		);
		await advance(LOADER_DELAY_MS);
		expect(status()?.textContent).toContain("Đang tải danh sách…");
		// The data arrives 50 ms after the loader appeared: the loader stays.
		await advance(50);
		rerender(
			<I18nProvider>
				<Loading loading={false} />
			</I18nProvider>,
		);
		expect(status()).not.toBeNull();
		await advance(LOADER_MIN_MS - 50 - 1);
		expect(status()).not.toBeNull();
		await advance(1);
		expect(status()).toBeNull();
		expect(screen.getByText("Nội dung")).toBeTruthy();
	});

	it("draws one continuous loader for a region's code and then its data", async () => {
		let resolveCode: (() => void) | null = null;
		const code = new Promise<void>((resolve) => {
			resolveCode = resolve;
		});
		let setLoading: ((loading: boolean) => void) | null = null;
		function Screen() {
			use(code);
			const [loading, set] = useState(true);
			useEffect(() => {
				setLoading = set;
			}, [set]);
			return <Loading loading={loading} />;
		}
		const appearances: number[] = [];
		const observer = new MutationObserver(() => {
			const shown = document.querySelector("[role='status']") !== null;
			if (shown && appearances.length % 2 === 0) appearances.push(Date.now());
			if (!shown && appearances.length % 2 === 1) appearances.push(Date.now());
		});
		observer.observe(document.body, { childList: true, subtree: true });
		render(
			<I18nProvider>
				<LoaderBoundary>
					<Screen />
				</LoaderBoundary>
			</I18nProvider>,
		);
		await advance(LOADER_DELAY_MS + 30);
		expect(status()).not.toBeNull();
		// The code arrives; the screen's own data loader takes over in place.
		await act(async () => {
			resolveCode?.();
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(status()).not.toBeNull();
		// After the loader's minimum time the screen renders and its data loader holds the same loader.
		await advance(LOADER_MIN_MS);
		expect(setLoading).not.toBeNull();
		expect(status()).not.toBeNull();
		act(() => setLoading?.(false));
		expect(status()).toBeNull();
		expect(screen.getByText("Nội dung")).toBeTruthy();
		await advance(0);
		observer.disconnect();
		// Shown once and hidden once: no second loader in between.
		expect(appearances).toHaveLength(2);
	});

	it("holds Suspense content back while the fallback loader has not had its minimum time", async () => {
		let resolveData: (() => void) | null = null;
		const data = new Promise<void>((resolve) => {
			resolveData = resolve;
		});
		function Screen() {
			use(data);
			return <p>Màn hình</p>;
		}
		render(
			<I18nProvider>
				<LoaderBoundary label="Đang tải màn hình…">
					<Screen />
				</LoaderBoundary>
			</I18nProvider>,
		);
		await advance(LOADER_DELAY_MS + 10);
		expect(status()?.textContent).toContain("Đang tải màn hình…");
		await act(async () => {
			resolveData?.();
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(screen.queryByText("Màn hình")).toBeNull();
		await advance(LOADER_MIN_MS);
		expect(screen.getByText("Màn hình")).toBeTruthy();
		expect(status()).toBeNull();
	});

	it("works as a plain Suspense fallback outside any region", async () => {
		const never = new Promise<void>(() => undefined);
		function Pending(): null {
			use(never);
			return null;
		}
		render(
			<I18nProvider>
				<Suspense fallback={<DelayedLoader />}>
					<Pending />
				</Suspense>
			</I18nProvider>,
		);
		expect(status()).toBeNull();
		await advance(LOADER_DELAY_MS);
		expect(status()?.textContent).toContain("Đang tải…");
	});

	it("shows a screen as soon as the parts it starts with are in, with no loader for a fast load", async () => {
		const slow = resource({}, "data", () => new Promise<string>((resolve) => setTimeout(() => resolve("x"), 80)));
		render(
			<I18nProvider>
				<LoaderBoundary>
					<Ready parts={[slow.promise]}>
						<p>Màn hình</p>
					</Ready>
				</LoaderBoundary>
			</I18nProvider>,
		);
		expect(screen.queryByText("Màn hình")).toBeNull();
		await advance(80);
		// At 80 ms, not at React's 300 ms Suspense reveal.
		expect(screen.getByText("Màn hình")).toBeTruthy();
		expect(status()).toBeNull();
	});

	it("draws the loader for slow parts and keeps it for its minimum time", async () => {
		const slow = resource({}, "data", () => new Promise<string>((resolve) => setTimeout(() => resolve("x"), LOADER_DELAY_MS + 50)));
		render(
			<I18nProvider>
				<LoaderBoundary>
					<Ready parts={[slow.promise]}>
						<p>Màn hình</p>
					</Ready>
				</LoaderBoundary>
			</I18nProvider>,
		);
		await advance(LOADER_DELAY_MS);
		expect(status()).not.toBeNull();
		await advance(50);
		expect(screen.queryByText("Màn hình")).toBeNull();
		await advance(LOADER_MIN_MS - 50);
		expect(status()).toBeNull();
		expect(screen.getByText("Màn hình")).toBeTruthy();
	});

	it("renders at once when the parts are in already", async () => {
		const done = resource({}, "data", () => Promise.resolve(1));
		await act(async () => {
			await done.promise;
		});
		render(
			<I18nProvider>
				<Ready parts={[done.promise]}>
					<p>Màn hình</p>
				</Ready>
			</I18nProvider>,
		);
		expect(screen.getByText("Màn hình")).toBeTruthy();
	});
});
