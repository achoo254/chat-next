// In-app loaders that follow the loader timing (loader-gate.ts,
// mockups/auth.html#loading): nothing but an empty frame for the first
// 320 ms, then the logo loader for at least 400 ms, and one continuous loader
// per region while its code and then its data load.
//
//   <LoaderBoundary>            a region: Suspense whose fallback is a delayed
//                               loader; content that arrives while that loader
//                               is on screen waits out its minimum time
//   useLoader(loading)          a loader in place while `loading`, kept for its
//                               minimum time; shares the region's timing
//   <DelayedLoader />           the same as a plain element (Suspense fallbacks)
//   <Ready parts>               holds a screen back, with the region's loader,
//                               until the code and data it starts with are in
import { Suspense, createContext, use, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { BrandLoader } from "./brand-loader.tsx";
import { isSettled } from "./preload.ts";
import { LoaderGate, pageSplash, type LoaderPhase } from "./loader-gate.ts";

const GateContext = createContext<LoaderGate | null>(null);

function createGate(): LoaderGate {
	return new LoaderGate(undefined, pageSplash());
}

/** The region's gate, or one of the caller's own outside any region. */
function useGate(): LoaderGate {
	const region = useContext(GateContext);
	const [own] = useState(createGate);
	return region ?? own;
}

/**
 * Whether the gate's phase matches `on`, followed from a layout effect: a
 * Suspense fallback whose content never committed gets no passive effects in
 * time, so useSyncExternalStore's subscription would come too late there.
 * Only a change of the answer re-renders: an update in the layout phase is a
 * synchronous render, which would also hurry unrelated pending updates.
 */
function useGateIn(gate: LoaderGate, on: readonly LoaderPhase[]): boolean {
	const [inside, setInside] = useState(() => on.includes(gate.getPhase()));
	useLayoutEffect(() => {
		const update = () => {
			const next = on.includes(gate.getPhase());
			setInside(next);
		};
		update();
		return gate.subscribe(update);
	}, [gate, on]);
	return inside;
}

const ON_SCREEN: readonly LoaderPhase[] = ["show", "shown"];
const MIN_PENDING: readonly LoaderPhase[] = ["show"];

interface SlotProps {
	gate: LoaderGate;
	label?: string | undefined;
	/** A Suspense fallback: its content waits for the loader's minimum time. */
	fallback?: boolean;
}

/** Holds the gate while mounted; draws the loader once the gate says so, an empty frame before. */
function LoaderSlot({ gate, label, fallback = false }: SlotProps) {
	useLayoutEffect(() => gate.acquire(fallback), [gate, fallback]);
	const visible = useGateIn(gate, ON_SCREEN);
	if (visible) return <BrandLoader label={label} since={gate.since} />;
	// Same box as the loader, nothing in it: a still frame, not announced.
	return <div className="brand-loader" aria-busy="true" />;
}

/** A delayed loader as an element, for Suspense fallbacks inside or outside a region. */
export function DelayedLoader({ label }: { label?: string | undefined }) {
	const gate = useGate();
	return <LoaderSlot gate={gate} label={label} fallback />;
}

/**
 * The loader to render in place of content while `loading`, and for the rest
 * of its minimum time once it is on screen; null when the content may show.
 */
export function useLoader(loading: boolean, label?: string): ReactNode {
	const gate = useGate();
	const minPending = useGateIn(gate, MIN_PENDING);
	const [showing, setShowing] = useState(loading);
	// Derived from the previous render (React's "adjusting state while rendering").
	if (loading && !showing) setShowing(true);
	if (!loading && showing && !minPending) setShowing(false);
	return loading || showing ? <LoaderSlot gate={gate} label={label} /> : null;
}

/** Resolved and marked so, so use() reads it without suspending. */
const NO_WAIT: Promise<void> = Object.assign(Promise.resolve(), { status: "fulfilled" as const, value: undefined });

/** Content of a region: waits while the fallback loader has not had its minimum time. */
function Hold({ gate, children }: { gate: LoaderGate; children: ReactNode }) {
	// use() runs on every render: React expects the same calls when it replays a suspended render.
	use(gate.contentWait() ?? NO_WAIT);
	return children;
}

/** Wraps a loader where the region needs its own box (a grid column). */
type Frame = (loader: ReactNode) => ReactNode;

interface LoaderBoundaryProps {
	children: ReactNode;
	frame?: Frame | undefined;
	label?: string | undefined;
}

/** A loading region: Suspense with one delayed loader shared by everything loading inside it. */
export function LoaderBoundary({ children, frame, label }: LoaderBoundaryProps) {
	const [gate] = useState(createGate);
	const loader = <LoaderSlot gate={gate} label={label} fallback />;
	return (
		<GateContext value={gate}>
			<Suspense fallback={frame === undefined ? loader : frame(loader)}>
				<Hold gate={gate}>{children}</Hold>
			</Suspense>
		</GateContext>
	);
}

/**
 * Holds a screen back, the first time it shows, until the code and data it
 * starts with (`parts`, started together by the route) are in, drawing the
 * region's loader meanwhile. It waits with state rather than Suspense, so a
 * screen whose parts arrive in 80 ms shows at 80 ms, not at React's 300 ms
 * Suspense reveal. Later changes inside the screen (a settings tab) load
 * under their own loader.
 */
export function Ready({ parts, frame, children }: { parts: readonly Promise<unknown>[]; frame?: Frame | undefined; children: ReactNode }) {
	const [first] = useState(parts);
	const [ready, setReady] = useState(() => first.every(isSettled));
	useEffect(() => {
		if (ready) return;
		let active = true;
		void Promise.allSettled(first).then(() => {
			if (active) setReady(true);
		});
		return () => {
			active = false;
		};
	}, [first, ready]);
	const loader = useLoader(!ready);
	if (loader === null) return children;
	return frame === undefined ? loader : frame(loader);
}

/** Shares one loader timing between the loaders of a region that does not suspend. */
export function LoaderScope({ children }: { children: ReactNode }) {
	const [gate] = useState(createGate);
	return <GateContext value={gate}>{children}</GateContext>;
}
