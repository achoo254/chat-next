// The "Văn phòng" tab of a session: watches the session's office on the
// machine (office-client.ts), keeps it in an OfficeStore, places everyone
// (office-placement.ts) on the one floor plan, and hands all of that to a
// renderer with the framing the viewer asked for (the work zone or the
// whole plan; a phone opens on the first, a wide screen on the other). Beside the scene a panel is open from the start: the
// office's overview (office-overview-panel.tsx: who works on what, who rests, the to-do, checks and cost the wall boards used to
// show), which gives way to a person's inspector panel (office-inspector-panel.tsx) when one is opened. View only: the one thing
// a viewer can do is open a person's panel; the chat is untouched. A machine whose tunelo predates the office
// gets a note to update and no frame.
// Loaded on demand with the rest of machines/office/ (and its styles).
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type RefObject } from "react";
import { ErrorReason, type MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { AGENT_OFFICE, versionAtLeast } from "../agent-version.ts";
import type { MachinesCopy } from "../copy-vi.ts";
import { RemoteError, type MachineLink } from "../link/machine-link.ts";
import { errorText } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { isPhone } from "../viewport-fit.ts";
import { Office2D } from "./office-2d.tsx";
import { keepOfficeAssetsCached } from "./office-asset-cache.ts";
import { loadOfficeAssets, type OfficeAssets } from "./office-assets.ts";
import { connectOffice, documentVisibility, type OfficeConnection } from "./office-client.ts";
import { officeTalks, type Talk } from "./office-conversations.ts";
import { officeDaypart } from "./office-daypart.ts";
import { deskOrder, type ScreenSize } from "./office-geometry.ts";
import type { Parsed } from "./office-json.ts";
import { OFFICE_LAYOUT, type OfficeLayout } from "./office-layout.ts";
import { EMPTY_MEMORY, officePlacement, type OfficeAdvisor, type Placement, type PlacementMemory } from "./office-placement.ts";
import type { OfficeFraming, OfficeRendererProps } from "./office-renderer.ts";
import { holdInspected, LEFT_SHOWN_MS, type HeldInspected } from "./office-inspector.ts";
import { InspectorPanel } from "./office-inspector-panel.tsx";
import { OverviewPanel } from "./office-overview-panel.tsx";
import { officeOverview } from "./office-overview.ts";
import { createOfficeStore, type OfficeState } from "./office-store.ts";
import "./office.css";

/** The office's frame below this width uses the phone framing and six desks. */
export const PHONE_WIDTH = 640;
/** Below this width the overview panel folds under the scene instead of standing beside it: beside it the scene would turn portrait and show only part of the plan. */
export const COLUMN_WIDTH = 1000;
/** How often placement looks at the clock. */
const FRAME_TICK_MS = 1_000;
const SOUND_KEY = "ai:office:sound";

/** The 3D scene, its own lazy chunk; it falls back to the 2D view itself where 3D cannot run. */
const Office3D = lazy(() => import("../../office-3d/office-canvas.tsx"));

function Office3DOr2D(props: OfficeRendererProps) {
	return (
		<Suspense fallback={<Office2D {...props} />}>
			<Office3D {...props} />
		</Suspense>
	);
}

/**
 * The way to draw the office on this device: the 3D scene
 * (apps/web/src/office-3d/office-canvas.tsx, which checks for hardware
 * WebGL2 before loading Babylon), with the 2D view while it loads and as its
 * fallback.
 */
export function chooseRenderer(): ComponentType<OfficeRendererProps> {
	return Office3DOr2D;
}

/** What to say when the machine refused to watch: its reason when it gave one (too many offices open at once), else that the office could not open. */
export function isWatchLimit(err: unknown): boolean {
	return err instanceof RemoteError && err.reason === ErrorReason.OFFICE_WATCH_LIMIT;
}

/** The machine has no such session (deleted, or never there): the office has nothing to show, only why. */
export function isSessionGone(err: unknown): boolean {
	return err instanceof RemoteError && err.reason === ErrorReason.THREAD_NOT_FOUND;
}

export function refusalText(copy: MachinesCopy, err: unknown): string {
	return err instanceof RemoteError && err.reason !== ErrorReason.UNSPECIFIED ? errorText(copy, err, "") : copy.office.failed;
}

function soundPreference(): boolean {
	try {
		return window.localStorage.getItem(SOUND_KEY) === "on";
	} catch {
		return false;
	}
}

function rememberSound(on: boolean): void {
	try {
		window.localStorage.setItem(SOUND_KEY, on ? "on" : "off");
	} catch {
		// Storage refused: the choice holds for this page.
	}
}

/** The frame's size class, from its width (the phone framing below PHONE_WIDTH). */
function useScreenSize(ref: RefObject<HTMLDivElement | null>): { size: ScreenSize; column: boolean } {
	const [size, setSize] = useState<ScreenSize>(() => (isPhone() ? "phone" : "desktop"));
	const [column, setColumn] = useState(() => !isPhone());
	useEffect(() => {
		const el = ref.current;
		if (el === null || typeof ResizeObserver !== "function") return;
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			if (width > 0) {
				setSize(width < PHONE_WIDTH ? "phone" : "desktop");
				setColumn(width >= COLUMN_WIDTH);
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref]);
	return { size, column };
}

/** What the office shows at one moment: everyone's place (with the memory that keeps people from running about) and the talks among them. */
interface Frame {
	readonly now: number;
	readonly placements: readonly Placement[];
	readonly memory: PlacementMemory;
	readonly talks: readonly Talk[];
	/** The person whose panel is open, as last seen (kept for a while when they have gone). */
	readonly held: HeldInspected | null;
}

const EMPTY_FRAME: Frame = { now: 0, placements: [], memory: EMPTY_MEMORY, talks: [], held: null };

/** The next frame: places from the store's state at `now`, then the talks among them. `advisor`: who Advisor is to the viewer; `selectedKey`: whose panel is open. */
export function advanceFrame(prev: Frame, state: OfficeState, layout: OfficeLayout, now: number, advisor: OfficeAdvisor | null = null, selectedKey: string | null = null): Frame {
	const placed = officePlacement(state, layout, now, prev.memory, advisor);
	return {
		now,
		placements: placed.placements,
		memory: placed.memory,
		talks: officeTalks(placed.placements, state, layout, now),
		held: holdInspected(prev.held, selectedKey, placed.placements, state, now).shown,
	};
}

/** The framing a frame of `size` opens with: a phone on the work zone, a wide screen on the whole plan. */
export function openingFraming(size: ScreenSize): OfficeFraming {
	return size === "phone" ? "work" : "overview";
}

/** The framing button: its label names the other framing, one press goes there. No mode, no memory across visits. */
function FramingButton({ framing, onChange }: { framing: OfficeFraming; onChange: (framing: OfficeFraming) => void }) {
	const t = useMachinesCopy().office;
	const overview = framing === "overview";
	return (
		<button type="button" className="of-toggle of-framing" title={overview ? t.backToWorkHint : t.overviewHint} onClick={() => onChange(overview ? "work" : "overview")} data-framing={framing} data-id="office-framing">
			{overview ? t.backToWork : t.overview}
		</button>
	);
}

function LiveOffice({ link, threadId, layout, advisor }: { link: MachineLink; threadId: string; layout: OfficeLayout; advisor: OfficeAdvisor | null }) {
	const copy = useMachinesCopy();
	const t = copy.office;
	const [store] = useState(() => createOfficeStore({ now: () => Date.now(), desks: deskOrder(layout, isPhone() ? "phone" : "desktop") }));
	// Why the machine refused to watch (too many offices open, an unknown session, …); cleared when a snapshot comes.
	const [refusal, setRefusal] = useState<{ err: unknown } | null>(null);
	const connection = useRef<OfficeConnection | null>(null);
	useEffect(() => {
		const opened = connectOffice(link, threadId, store, { now: () => Date.now(), onRefusal: (err) => setRefusal(err === null ? null : { err }) });
		connection.current = opened;
		return () => {
			connection.current = null;
			opened.close();
		};
	}, [link, threadId, store]);
	const failed = refusal !== null;
	const state = useSyncExternalStore(store.subscribe, store.state);
	const box = useRef<HTMLDivElement>(null);
	const { size, column } = useScreenSize(box);
	// The phone uses six of the eight desks: people keep theirs when it stays offered.
	useEffect(() => store.setDesks(deskOrder(layout, size)), [store, layout, size]);
	// Until the viewer presses the framing button, the framing follows the frame's size.
	const [chosenFraming, setFraming] = useState<OfficeFraming | null>(null);
	const framing: OfficeFraming = chosenFraming ?? openingFraming(size);
	const [frame, setFrame] = useState<Frame>(() => advanceFrame(EMPTY_FRAME, store.state(), layout, Date.now(), advisor));
	// The frame moves on with every change of the store and every second while the page shows (holds run on the clock).
	// Advisor's name or look changed in the profile: the next frame (at most a second later) shows it.
	const advisorNow = useRef(advisor);
	useEffect(() => {
		advisorNow.current = advisor;
	}, [advisor]);
	// The panel's person for the next frame, and a way to take that frame at once (a press should show its panel now, not up to a second later).
	const selectedNow = useRef<string | null>(null);
	const stepNow = useRef<() => void>(() => undefined);
	useEffect(() => {
		const step = (): void => {
			if (documentVisibility.hidden()) return;
			setFrame((prev) => advanceFrame(prev, store.state(), layout, Date.now(), advisorNow.current, selectedNow.current));
		};
		stepNow.current = step;
		const off = store.subscribe(step);
		const timer = window.setInterval(step, FRAME_TICK_MS);
		return () => {
			off();
			window.clearInterval(timer);
			stepNow.current = () => undefined;
		};
	}, [store, layout]);

	const [Renderer] = useState(chooseRenderer);
	const [assets, setAssets] = useState<Parsed<OfficeAssets> | null>(null);
	useEffect(() => {
		let alive = true;
		let stopCaching: (() => void) | null = null;
		void loadOfficeAssets(layout).then((result) => {
			if (!alive) return;
			setAssets(result);
			if (result.ok) stopCaching = keepOfficeAssetsCached();
		});
		return () => {
			alive = false;
			stopCaching?.();
		};
	}, [layout]);
	const [sound, setSound] = useState(soundPreference);
	// The person whose panel is open, by placement key (not by actor: subagents of one title replace one another). Not kept across a reload.
	const [selected, setSelected] = useState<string | null>(null);
	// The next frame takes the selection from here (the timer that closes the panel of someone who left clears it too).
	useEffect(() => {
		selectedNow.current = selected;
	}, [selected]);
	const shown = selected !== null && frame.held?.key === selected ? frame.held : null;
	const overview = useMemo(() => officeOverview(frame.placements, t), [frame.placements, t]);
	// A person who has gone says so for a while, then the panel closes; a key never shown closes at once.
	const closeIn = selected === null ? null : shown === null ? 0 : shown.leftAt === null ? null : Math.max(0, LEFT_SHOWN_MS - (frame.now - shown.leftAt));
	useEffect(() => {
		if (closeIn === null) return;
		const timer = window.setTimeout(() => setSelected(null), closeIn);
		return () => window.clearTimeout(timer);
	}, [closeIn]);
	const stage = useRef<HTMLDivElement>(null);
	const choose = useCallback((key: string | null) => {
		const next = key === null || key === selectedNow.current ? null : key;
		selectedNow.current = next;
		setSelected(next);
		stepNow.current();
	}, [setSelected]);
	// Esc closes the panel and puts the focus back on the person's name when it is on screen, else on the scene.
	const closePanel = (): void => {
		const key = selected;
		choose(null);
		if (key === null) return;
		const tag = Array.from(box.current?.querySelectorAll<HTMLElement>("[data-id^='office-person-']") ?? []).find((el) => el.getAttribute("data-id") === `office-person-${key}`);
		const button = tag?.closest("[hidden]") === null ? tag?.querySelector<HTMLElement>("button") : null;
		(button ?? stage.current)?.focus();
	};
	const closeOnEscape = useRef(closePanel);
	useEffect(() => {
		closeOnEscape.current = closePanel;
	});
	// Esc anywhere in the office closes the panel (a listener, not a handler on the frame: the frame is not a control).
	useEffect(() => {
		const el = box.current;
		if (el === null || selected === null) return;
		const onKey = (e: globalThis.KeyboardEvent): void => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			closeOnEscape.current();
		};
		el.addEventListener("keydown", onKey);
		return () => el.removeEventListener("keydown", onKey);
	}, [selected, box]);
	const notes: { key: string; text: string; tone?: "warn"; retry?: boolean }[] = [];
	if (refusal !== null) notes.push({ key: "failed", text: refusalText(copy, refusal.err), tone: "warn", retry: isWatchLimit(refusal.err) });
	if (state.status === "live" && !state.reportsStaff) notes.push({ key: "staff", text: t.noStaff });
	if (state.power === "out") notes.push({ key: "power", text: t.powerOut, tone: "warn" });
	else if (state.status === "live" && state.awaitingSnapshot) notes.push({ key: "sync", text: t.catchingUp });
	if (state.session.hiddenActors > 0) notes.push({ key: "hidden", text: t.hidden(state.session.hiddenActors) });
	return (
		<div className="of" ref={box} data-id="office" data-size={size} data-column={column}>
			<div className="of-bar">
				<FramingButton framing={framing} onChange={setFraming} />
				<button
					type="button"
					className="of-toggle"
					aria-pressed={sound}
					title={t.soundHint}
					onClick={() => {
						rememberSound(!sound);
						setSound(!sound);
					}}
					data-id="office-sound"
				>
					{t.sound}
				</button>
			</div>
			{notes.map((n) => (
				<p key={n.key} className="of-note" data-tone={n.tone} role="status">
					{n.text}
					{n.retry === true && (
						<button
							type="button"
							className="btn btn-sm mx-btn-ghost of-retry"
							onClick={() => {
								setRefusal(null);
								connection.current?.retry();
							}}
							data-id="office-retry"
						>
							{copy.terminal.retry}
						</button>
					)}
				</p>
			))}
			{refusal !== null && isSessionGone(refusal.err) ? null : state.status === "loading" && !failed ? (
				<p className="of-note" role="status">
					{t.loading}
				</p>
			) : (
				<div className="of-body" ref={stage} tabIndex={-1} data-panel={shown === null ? undefined : "open"}>
					<Renderer
						state={state}
						placements={frame.placements}
						talks={frame.talks}
						layout={layout}
						framing={framing}
						size={size}
						daypart={officeDaypart(frame.now)}
						assets={assets}
						now={frame.now}
						sound={sound}
						selectedKey={shown?.key ?? null}
						onSelect={choose}
					/>
					{shown !== null ? <InspectorPanel held={shown} onClose={closePanel} /> : <OverviewPanel overview={overview} state={state} now={frame.now} compact={!column} onSelect={choose} />}
				</div>
			)}
		</div>
	);
}

/** `advisor`: who Advisor is to the viewer (their Advisor profile); null shows Advisor under its default name and first look. */
export default function OfficeView({
	link,
	threadId,
	info,
	online,
	advisor = null,
}: {
	link: MachineLink;
	threadId: string;
	info: MachineInfo | null;
	online: boolean;
	advisor?: OfficeAdvisor | null;
}) {
	const t = useMachinesCopy().office;
	let note: string | null = null;
	if (!OFFICE_LAYOUT.ok) note = t.layoutBroken;
	else if (info === null) note = online ? t.loading : t.offline;
	else if (!versionAtLeast(info.agentVersion, AGENT_OFFICE)) note = t.needsUpdate;
	if (note !== null || !OFFICE_LAYOUT.ok) {
		return (
			<div className="of" data-id="office">
				<p className="of-note" role="status">
					{note}
				</p>
			</div>
		);
	}
	// A new store and a closed panel for each session.
	return <LiveOffice key={threadId} link={link} threadId={threadId} layout={OFFICE_LAYOUT.value} advisor={advisor} />;
}
