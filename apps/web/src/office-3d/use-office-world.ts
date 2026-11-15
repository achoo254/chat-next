// Mounts the 3D office in a host element for as long as the component lives
// (shape of Chùa Nhỏ's use-babylon-world.ts): downloads the Babylon chunk on
// first use, boots it, and disposes every engine resource on unmount (iOS
// keeps GPU memory of a forgotten engine). A failed boot or a lost GPU
// context reports `failed`; the view then shows the 2D office.
import { useEffect, useRef, useState, type RefObject } from "react";
import type { OfficeRendererProps } from "../machines/office/office-renderer.ts";
import { qualityIndexOf } from "./engine/quality-levels.ts";
import type { Office3DFlags } from "./office-flags.ts";
import type { OfficeWorld } from "./office-world.ts";

export type WorldStatus = "loading" | "ready" | "failed";

function mediaMatches(query: string): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

export function useOfficeWorld(host: RefObject<HTMLDivElement | null>, props: OfficeRendererProps, flags: Office3DFlags, canvasLabel: string): { status: WorldStatus; world: OfficeWorld | null } {
	const [state, setState] = useState<{ status: WorldStatus; world: OfficeWorld | null }>({ status: "loading", world: null });
	// What the world boots with; later changes go through `update`.
	const initial = useRef(props);
	const label = useRef(canvasLabel);
	useEffect(() => {
		const el = host.current;
		if (el === null) return;
		const abort = new AbortController();
		let world: OfficeWorld | null = null;
		const fail = (error: unknown): void => {
			if (abort.signal.aborted) return;
			console.warn("office: the 3D view could not start, showing 2D", error);
			world?.dispose();
			world = null;
			setState({ status: "failed", world: null });
		};
		import("./office-world.ts")
			.then((module) =>
				module.bootOfficeWorld({
					host: el,
					props: initial.current,
					preference: flags.preference,
					pinnedQuality: qualityIndexOf(flags.quality),
					reducedMotion: mediaMatches("(prefers-reduced-motion: reduce)"),
					coarsePointer: mediaMatches("(pointer: coarse)"),
					testApi: flags.testApi,
					signal: abort.signal,
					canvasLabel: label.current,
					onLost: () => fail(new Error("GPU context lost")),
				}),
			)
			.then((result) => {
				if (result.kind === "unsupported") return fail(new Error("no WebGPU or WebGL2"));
				if (abort.signal.aborted) {
					result.world.dispose();
					return;
				}
				world = result.world;
				setState({ status: "ready", world: result.world });
			})
			.catch(fail);
		return () => {
			abort.abort();
			world?.dispose();
			world = null;
		};
	}, [host, flags]);
	return state;
}
