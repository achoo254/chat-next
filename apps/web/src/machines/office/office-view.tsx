// The "Văn phòng" tab of a session: watches the session's office on the
// machine (office-client.ts), keeps it in an OfficeStore, places everyone
// (office-placement.ts), follows the work between floors, and hands all of
// that to a renderer. View only: no input, the chat is untouched. A machine
// whose tunelo predates the office gets a note to update and no frame.
// Loaded on demand with the rest of machines/office/ (and its styles).
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type RefObject } from "react";
import { ErrorReason, type MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { AGENT_OFFICE, versionAtLeast } from "../agent-version.ts";
import type { MachinesCopy } from "../copy-vi.ts";
import { RemoteError, type MachineLink } from "../link/machine-link.ts";
import { errorText } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { isPhone } from "../viewport-fit.ts";
import { Office2D } from "./office-2d.tsx";
import { loadOfficeAssets, type OfficeAssets } from "./office-assets.ts";
import { connectOffice, documentVisibility, type OfficeConnection } from "./office-client.ts";
import { officeDaypart } from "./office-daypart.ts";
import { busyFloors, FIRST_FLOOR, followPreference, latestWork, nextFloor, OfficeFloorTabs, pickFloor, rememberFollow, type FollowState } from "./office-floor-tabs.tsx";
import { deskOrder, type ScreenSize } from "./office-geometry.ts";
import type { Parsed } from "./office-json.ts";
import { OFFICE_LAYOUT, type OfficeLayout } from "./office-layout.ts";
import { EMPTY_MEMORY, officePlacement, type Placement, type PlacementMemory } from "./office-placement.ts";
import type { OfficeRendererProps } from "./office-renderer.ts";
import { createOfficeStore, type OfficeState } from "./office-store.ts";
import "./office.css";

/** The office's frame below this width uses the phone framing and six desks. */
export const PHONE_WIDTH = 640;
/** How often placement and following look at the clock. */
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
function useScreenSize(ref: RefObject<HTMLDivElement | null>): ScreenSize {
	const [size, setSize] = useState<ScreenSize>(() => (isPhone() ? "phone" : "desktop"));
	useEffect(() => {
		const el = ref.current;
		if (el === null || typeof ResizeObserver !== "function") return;
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			if (width > 0) setSize(width < PHONE_WIDTH ? "phone" : "desktop");
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

/** What the office shows at one moment: everyone's place (with the memory that keeps people from running about) and the floor. */
interface Frame {
	readonly now: number;
	readonly placements: readonly Placement[];
	readonly memory: PlacementMemory;
	readonly floor: FollowState;
}

const EMPTY_FRAME: Frame = { now: 0, placements: [], memory: EMPTY_MEMORY, floor: FIRST_FLOOR };

/** The next frame: places from the store's state at `now`, then the floor following the newest work. */
export function advanceFrame(prev: Frame, state: OfficeState, layout: OfficeLayout, now: number, follow: boolean): Frame {
	const placed = officePlacement(state, layout, now, prev.memory);
	return { now, placements: placed.placements, memory: placed.memory, floor: nextFloor(prev.floor, { follow, now, latest: latestWork(placed.placements) }) };
}

function LiveOffice({ link, threadId, layout }: { link: MachineLink; threadId: string; layout: OfficeLayout }) {
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
	const size = useScreenSize(box);
	// The phone uses six of the eight desks: people keep theirs when it stays offered.
	useEffect(() => store.setDesks(deskOrder(layout, size)), [store, layout, size]);
	const [follow, setFollow] = useState(followPreference);
	const [frame, setFrame] = useState<Frame>(() => advanceFrame(EMPTY_FRAME, store.state(), layout, Date.now(), follow));
	// The frame moves on with every change of the store and every second while the page shows (holds and following run on the clock).
	const following = useRef(follow);
	useEffect(() => {
		following.current = follow;
	}, [follow]);
	useEffect(() => {
		const step = (): void => {
			if (documentVisibility.hidden()) return;
			setFrame((prev) => advanceFrame(prev, store.state(), layout, Date.now(), following.current));
		};
		const off = store.subscribe(step);
		const timer = window.setInterval(step, FRAME_TICK_MS);
		return () => {
			off();
			window.clearInterval(timer);
		};
	}, [store, layout]);
	const [Renderer] = useState(chooseRenderer);
	const [assets, setAssets] = useState<Parsed<OfficeAssets> | null>(null);
	useEffect(() => {
		let alive = true;
		void loadOfficeAssets(layout).then((result) => {
			if (alive) setAssets(result);
		});
		return () => {
			alive = false;
		};
	}, [layout]);
	const [sound, setSound] = useState(soundPreference);
	const notes: { key: string; text: string; tone?: "warn"; retry?: boolean }[] = [];
	if (refusal !== null) notes.push({ key: "failed", text: refusalText(copy, refusal.err), tone: "warn", retry: isWatchLimit(refusal.err) });
	if (state.status === "live" && !state.reportsStaff) notes.push({ key: "staff", text: t.noStaff });
	if (state.power === "out") notes.push({ key: "power", text: t.powerOut, tone: "warn" });
	else if (state.off) notes.push({ key: "closed", text: t.closed });
	else if (state.status === "live" && state.awaitingSnapshot) notes.push({ key: "sync", text: t.catchingUp });
	if (state.session.hiddenActors > 0) notes.push({ key: "hidden", text: t.hidden(state.session.hiddenActors) });
	return (
		<div className="of" ref={box} data-id="office" data-size={size}>
			<div className="of-bar">
				<OfficeFloorTabs
					floor={frame.floor.floor}
					busy={busyFloors(frame.placements)}
					follow={follow}
					onPick={(level) => setFrame((prev) => ({ ...prev, floor: pickFloor(level, Date.now()) }))}
					onFollow={(on) => {
						rememberFollow(on);
						setFollow(on);
					}}
				/>
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
			{state.status === "loading" && !failed ? (
				<p className="of-note" role="status">
					{t.loading}
				</p>
			) : (
				<Renderer state={state} placements={frame.placements} layout={layout} floor={frame.floor.floor} size={size} daypart={officeDaypart(frame.now, state.off)} assets={assets} now={frame.now} sound={sound} />
			)}
		</div>
	);
}

export default function OfficeView({ link, threadId, info, online }: { link: MachineLink; threadId: string; info: MachineInfo | null; online: boolean }) {
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
	return <LiveOffice link={link} threadId={threadId} layout={OFFICE_LAYOUT.value} />;
}
