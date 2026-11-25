// The machine's browser, live, for a takeover: the tab's picture (a
// screencast the machine sends only while this view is open and the page is
// visible), the read-only address and the tabs, and the user's own input on
// it. Desktop: click, drag, wheel and keys on the picture, paste for text.
// Phone: full screen; a tap clicks, one finger scrolls the page, two fingers
// zoom and pan the picture here; "Bàn phím" opens the phone's keyboard,
// whose text goes to the page (as a password field when the page's field is
// one, so the keyboard does not learn it). Nothing typed is kept here: each
// input goes out at once over the end-to-end encrypted link and the field
// is emptied. "Trả lại cho <AI>" ends the takeover; "Thu nhỏ" only closes the
// view.
//
// Embedded (a tab of the dock, browser-pane.tsx) it has no title bar and no
// "give back": the address is editable, with back, forward, reload, new tab
// and close tab, and the picture streams only while its tab is the one shown.
import { useEffect, useRef, useState, type FormEvent, type ClipboardEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { BrowserMouseType, BrowserNavigateAction, type BrowserInputSchema, type BrowserTab, type BrowserTakeover } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../../components/screen-icons.tsx";
import { useDomId } from "../../messaging/ui/parts.tsx";
import type { MachineLink } from "../link/machine-link.ts";
import { addressToUrl } from "./address.ts";
import { BrowserIcon } from "./browser-icons.tsx";
import { errorText } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { keyPress, modifiersOf, NO_ZOOM, pagePoint, pageScale, phoneKey, pinch, TAP_MS, TAP_SLOP, wheelPixels, type KeyPress, type PageSize, type Point, type Zoom } from "./input-map.ts";
import "./takeover.css";

type Action = NonNullable<MessageInitShape<typeof BrowserInputSchema>["action"]>;

/** Pointer moves and wheel turns go out at most this often. */
const MOVE_MS = 50;
const PING_MS = 3_000;
const MAX_TEXT = 1000;

interface TakeoverViewProps {
	link: MachineLink;
	takeover: BrowserTakeover;
	ai: string;
	/** The machine's link is open. */
	online: boolean;
	inSession: boolean;
	onMinimize: () => void;
	/** A tab of the dock: editable address and tab buttons, no title bar, nothing to give back. */
	embedded?: boolean;
	/** Embedded and its tab is not the one shown: the machine stops streaming it (default: shown). */
	active?: boolean;
}

interface Picture {
	readonly src: string;
	readonly page: PageSize;
}

/** The largest picture worth asking for on this screen. */
function wantedSize(): { maxWidth: number; maxHeight: number } {
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	return { maxWidth: Math.min(1600, Math.round(window.innerWidth * dpr)), maxHeight: Math.min(1600, Math.round(window.innerHeight * dpr)) };
}

export default function TakeoverView({ link, takeover, ai, online, inSession, onMinimize, embedded = false, active = true }: TakeoverViewProps) {
	const t = useMachinesCopy();
	const b = t.browser;
	const id = useDomId("browser");
	const takeoverId = takeover.takeoverId;
	const [picture, setPicture] = useState<Picture | null>(null);
	const [tabs, setTabs] = useState<readonly BrowserTab[]>([]);
	const [shown, setShown] = useState("");
	const [password, setPassword] = useState(false);
	const [rtt, setRtt] = useState<number | null>(null);
	const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
	const [error, setError] = useState("");
	const [ending, setEnding] = useState(false);
	const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
	/** The address being typed; null: the bar shows the page's address. */
	const [draft, setDraft] = useState<string | null>(null);
	const surface = useRef<HTMLDivElement>(null);
	const image = useRef<HTMLImageElement>(null);
	const typing = useRef<HTMLInputElement>(null);

	// Pictures and tabs: straight from the link, never through its state.
	useEffect(() => {
		let last = "";
		const stop = link.onFrame((body) => {
			if (body.case === "browserState") {
				if (body.value.takeoverId !== takeoverId) return;
				setTabs(body.value.tabs);
				setShown(body.value.targetId);
				setPassword(body.value.passwordFocused);
				return;
			}
			if (body.case !== "browserFrame") return;
			const f = body.value;
			if (f.takeoverId !== takeoverId) return;
			const src = URL.createObjectURL(new Blob([new Uint8Array(f.jpeg)], { type: "image/jpeg" }));
			setPicture({ src, page: { width: f.pageWidth, height: f.pageHeight } });
			if (last !== "") URL.revokeObjectURL(last);
			last = src;
		});
		return () => {
			stop();
			if (last !== "") URL.revokeObjectURL(last);
		};
	}, [link, takeoverId]);

	useEffect(() => {
		const changed = () => setVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", changed);
		return () => document.removeEventListener("visibilitychange", changed);
	}, []);

	// The machine streams only while this view shows on a visible page (again after a reconnect);
	// it goes on with the tab shown last.
	useEffect(() => {
		if (!online || !visible || !active) return;
		link.request({ case: "browserView", value: { takeoverId, targetId: "", on: true, ...wantedSize() } }).catch((err: unknown) => setError(errorText(t, err, ai)));
		return () => {
			link.request({ case: "browserView", value: { takeoverId, targetId: "", on: false, maxWidth: 0, maxHeight: 0 } }).catch(() => undefined);
		};
	}, [link, takeoverId, online, visible, active, t, ai]);

	// How long the machine takes to answer, while the view shows.
	useEffect(() => {
		if (!online || !visible || !active) return;
		let measuring = true;
		const measure = () => {
			const start = performance.now();
			link.request({ case: "ping", value: {} }).then(
				() => {
					if (measuring) setRtt(Math.round(performance.now() - start));
				},
				() => undefined,
			);
		};
		measure();
		const timer = window.setInterval(measure, PING_MS);
		return () => {
			measuring = false;
			window.clearInterval(timer);
		};
	}, [link, online, visible, active]);

	const send = (action: Action) => {
		link.request({ case: "browserInput", value: { takeoverId, targetId: shown, action } }).catch((err: unknown) => setError(errorText(t, err, ai)));
	};
	const sendKey = (k: KeyPress) => send({ case: "key", value: k });
	const sendText = (text: string) => {
		for (let i = 0; i < text.length; i += MAX_TEXT) send({ case: "text", value: text.slice(i, i + MAX_TEXT) });
	};

	// --- pointer ---------------------------------------------------------------

	const gesture = useRef<{
		pointers: Map<number, Point>;
		start: Map<number, Point>;
		downAt: number;
		dragged: boolean;
		zoomStart: Zoom;
		lastMove: number;
		wheel: { x: number; y: number; at: Point | null; timer: number };
	}>({ pointers: new Map(), start: new Map(), downAt: 0, dragged: false, zoomStart: NO_ZOOM, lastMove: 0, wheel: { x: 0, y: 0, at: null, timer: 0 } });

	const pointOf = (clientX: number, clientY: number) => {
		const img = image.current;
		if (img === null || picture === null) return null;
		return pagePoint(clientX, clientY, img.getBoundingClientRect(), picture.page);
	};

	const mouse = (type: BrowserMouseType, at: { x: number; y: number }, extra: { button?: number; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: number } = {}) =>
		send({ case: "mouse", value: { type, x: at.x, y: at.y, button: extra.button ?? 0, clickCount: extra.clickCount ?? 0, deltaX: extra.deltaX ?? 0, deltaY: extra.deltaY ?? 0, modifiers: extra.modifiers ?? 0 } });

	/** Wheel turns and finger scrolls close together go out as one. */
	const scrollBy = (at: { x: number; y: number }, dx: number, dy: number) => {
		const w = gesture.current.wheel;
		w.x += dx;
		w.y += dy;
		w.at = at;
		if (w.timer !== 0) return;
		w.timer = window.setTimeout(() => {
			w.timer = 0;
			if (w.at !== null && (w.x !== 0 || w.y !== 0)) mouse(BrowserMouseType.WHEEL, w.at, { deltaX: Math.round(w.x), deltaY: Math.round(w.y) });
			w.x = 0;
			w.y = 0;
		}, MOVE_MS);
	};

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		const g = gesture.current;
		if (e.pointerType === "touch") {
			g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			g.start.set(e.pointerId, { x: e.clientX, y: e.clientY });
			g.downAt = performance.now();
			g.dragged = g.pointers.size > 1;
			g.zoomStart = zoom;
			e.currentTarget.setPointerCapture(e.pointerId);
			return;
		}
		const at = pointOf(e.clientX, e.clientY);
		if (at === null) return;
		e.preventDefault();
		surface.current?.focus();
		e.currentTarget.setPointerCapture(e.pointerId);
		mouse(BrowserMouseType.DOWN, at, { button: e.button, clickCount: Math.max(e.detail, 1), modifiers: modifiersOf(e) });
	};

	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		const g = gesture.current;
		if (e.pointerType === "touch") {
			const before = g.pointers.get(e.pointerId);
			if (before === undefined) return;
			const now = { x: e.clientX, y: e.clientY };
			g.pointers.set(e.pointerId, now);
			const start = g.start.get(e.pointerId) ?? now;
			if (Math.hypot(now.x - start.x, now.y - start.y) > TAP_SLOP) g.dragged = true;
			if (g.pointers.size >= 2) {
				const [a, c] = [...g.pointers.keys()];
				if (a === undefined || c === undefined) return;
				const from = [g.start.get(a) ?? now, g.start.get(c) ?? now] as const;
				const to = [g.pointers.get(a) ?? now, g.pointers.get(c) ?? now] as const;
				setZoom(pinch(g.zoomStart, from, to));
				return;
			}
			const img = image.current;
			const at = pointOf(now.x, now.y);
			if (!g.dragged || img === null || picture === null || at === null) return;
			// The finger moves the page under it: scroll the other way.
			const k = pageScale(img.getBoundingClientRect(), picture.page);
			scrollBy(at, (before.x - now.x) * k, (before.y - now.y) * k);
			return;
		}
		const nowMs = performance.now();
		if (nowMs - g.lastMove < MOVE_MS) return;
		const at = pointOf(e.clientX, e.clientY);
		if (at === null) return;
		g.lastMove = nowMs;
		mouse(BrowserMouseType.MOVE, at, { modifiers: modifiersOf(e) });
	};

	const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
		const g = gesture.current;
		if (e.pointerType === "touch") {
			const start = g.start.get(e.pointerId);
			g.pointers.delete(e.pointerId);
			g.start.delete(e.pointerId);
			if (g.pointers.size > 0) {
				// One finger left of a pinch: it starts over from here.
				g.zoomStart = zoom;
				for (const [k, p] of g.pointers) g.start.set(k, p);
				return;
			}
			const at = pointOf(e.clientX, e.clientY);
			if (!g.dragged && start !== undefined && at !== null && performance.now() - g.downAt < TAP_MS) {
				mouse(BrowserMouseType.MOVE, at);
				mouse(BrowserMouseType.DOWN, at, { clickCount: 1 });
				mouse(BrowserMouseType.UP, at, { clickCount: 1 });
			}
			return;
		}
		const at = pointOf(e.clientX, e.clientY);
		if (at !== null) mouse(BrowserMouseType.UP, at, { button: e.button, clickCount: Math.max(e.detail, 1), modifiers: modifiersOf(e) });
	};

	const onWheel = (e: WheelEvent<HTMLDivElement>) => {
		const at = pointOf(e.clientX, e.clientY);
		if (at === null) return;
		scrollBy(at, wheelPixels(e.deltaX, e.deltaMode), wheelPixels(e.deltaY, e.deltaMode));
	};

	// The page under the picture must not scroll with the wheel meanwhile.
	useEffect(() => {
		const el = surface.current;
		if (el === null) return;
		const stop = (e: globalThis.WheelEvent) => e.preventDefault();
		el.addEventListener("wheel", stop, { passive: false });
		return () => el.removeEventListener("wheel", stop);
	}, []);

	// --- keys ------------------------------------------------------------------

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape" && e.shiftKey && !embedded) return onMinimize();
		const k = keyPress(e);
		if (k === null) return;
		e.preventDefault();
		sendKey(k);
	};

	const onPaste = (e: ClipboardEvent<HTMLElement>) => {
		const text = e.clipboardData.getData("text/plain");
		e.preventDefault();
		if (text !== "") sendText(text);
	};

	// The phone's keyboard: its text goes out as typed, then the field is emptied.
	const onPhoneInput = () => {
		const el = typing.current;
		if (el === null || el.value === "") return;
		const text = el.value;
		el.value = "";
		sendText(text);
	};
	const [composing, setComposing] = useState(false);

	const onPhoneKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		const k = phoneKey(e.key);
		if (k === null || composing) return;
		e.preventDefault();
		sendKey(k);
	};

	const giveBack = () => {
		setEnding(true);
		link.request({ case: "browserTakeoverEnd", value: { takeoverId } }).then(
			() => {
				link.dropTakeover(takeoverId);
				onMinimize();
			},
			(err: unknown) => {
				setEnding(false);
				setError(errorText(t, err, ai));
			},
		);
	};

	const choose = (targetId: string) => {
		setShown(targetId);
		link.request({ case: "browserView", value: { takeoverId, targetId, on: true, ...wantedSize() } }).catch((err: unknown) => setError(errorText(t, err, ai)));
	};

	/** The address bar and tab buttons (embedded only). */
	const navigate = (action: BrowserNavigateAction, to = "") => {
		link.request({ case: "browserNavigate", value: { takeoverId, targetId: shown, action, url: to } }).catch((err: unknown) => setError(errorText(t, err, ai)));
	};
	const go = (e: FormEvent) => {
		e.preventDefault();
		const to = addressToUrl(draft ?? "");
		setDraft(null);
		if (to !== null) navigate(BrowserNavigateAction.GOTO, to);
		surface.current?.focus();
	};
	const tabName = (tab: BrowserTab) => tab.title || (tab.url === "" || tab.url === "about:blank" ? b.blankTab : tab.url);

	const current = tabs.find((x) => x.targetId === shown);
	const url = current?.url ?? takeover.url;
	const expires = new Date(Number(takeover.expiresAt)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const forSession = takeover.threadId !== "";
	return (
		<div
			className={`mx-browser${embedded ? " embedded" : inSession ? " in-session" : ""}`}
			role={embedded ? "region" : "dialog"}
			aria-modal={embedded ? undefined : !inSession}
			aria-labelledby={`${id}-title`}
			data-id="browser-view"
		>
			{embedded && (
				<h3 id={`${id}-title`} className="sr-only">
					{b.viewTitle}
				</h3>
			)}
			{!embedded && (
			<header className="mx-browser-head">
				<div className="mx-browser-title">
					<h3 id={`${id}-title`}>
						<Icon name="globe" />
						<span>{b.viewTitle}</span>
					</h3>
					{forSession && takeover.reason !== "" && <p className="mx-browser-reason">{takeover.reason}</p>}
				</div>
				<span className={`chip mx-browser-live${online ? " on" : ""}`} role="status">
					{online ? (rtt === null ? b.liveNoMs : b.live(rtt)) : b.connecting}
				</span>
				<button type="button" className="icon-btn" aria-label={b.minimize} title={b.minimize} onClick={onMinimize} data-id="browser-view-minimize">
					<BrowserIcon name="x" />
				</button>
			</header>
			)}
			{embedded ? (
				<form className="mx-browser-bar" onSubmit={go}>
					<button type="button" className="icon-btn" aria-label={b.back} title={b.back} onClick={() => navigate(BrowserNavigateAction.BACK)} data-id="browser-view-back">
						<BrowserIcon name="back" small />
					</button>
					<button type="button" className="icon-btn" aria-label={b.forward} title={b.forward} onClick={() => navigate(BrowserNavigateAction.FORWARD)} data-id="browser-view-forward">
						<BrowserIcon name="forward" small />
					</button>
					<button type="button" className="icon-btn" aria-label={b.reload} title={b.reload} onClick={() => navigate(BrowserNavigateAction.RELOAD)} data-id="browser-view-reload">
						<BrowserIcon name="reload" small />
					</button>
					<label className="sr-only" htmlFor={`${id}-url`}>
						{b.addressEdit}
					</label>
					<input
						id={`${id}-url`}
						className="input mono mx-browser-url"
						value={draft ?? url}
						title={current?.title ?? ""}
						placeholder={b.addressEdit}
						autoComplete="off"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						enterKeyHint="go"
						onFocus={(e) => e.currentTarget.select()}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={() => setDraft(null)}
						data-id="browser-view-url"
					/>
					<select className="input mx-browser-tabs" aria-label={b.tab} value={shown} onChange={(e) => choose(e.target.value)} data-id="browser-view-tabs">
						{tabs.map((tab) => (
							<option key={tab.targetId} value={tab.targetId}>
								{tabName(tab)}
							</option>
						))}
					</select>
					<button type="button" className="icon-btn" aria-label={b.newTab} title={b.newTab} onClick={() => navigate(BrowserNavigateAction.NEW_TAB)} data-id="browser-view-new-tab">
						<BrowserIcon name="plus" small />
					</button>
					<button type="button" className="icon-btn" aria-label={b.closeTab} title={b.closeTab} onClick={() => navigate(BrowserNavigateAction.CLOSE_TAB)} data-id="browser-view-close-tab">
						<BrowserIcon name="x" small />
					</button>
				</form>
			) : (
				<div className="mx-browser-bar">
					<label className="sr-only" htmlFor={`${id}-url`}>
						{b.address}
					</label>
					<input id={`${id}-url`} className="input mono mx-browser-url" readOnly value={url} title={current?.title ?? ""} data-id="browser-view-url" />
					{tabs.length > 1 && (
						<select className="input mx-browser-tabs" aria-label={b.tab} value={shown} onChange={(e) => choose(e.target.value)} data-id="browser-view-tabs">
							{tabs.map((tab) => (
								<option key={tab.targetId} value={tab.targetId}>
									{tab.title || tab.url}
								</option>
							))}
						</select>
					)}
				</div>
			)}
			{/* The remote page itself: like a canvas, every pointer and key on it goes to the machine's tab. */}
			{/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- role "application" hands all input to the remote page */}
			<div
				ref={surface}
				className="mx-browser-surface"
				role="application"
				aria-label={current?.title || b.viewTitle}
				// eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- it takes the keys typed for the remote page
				tabIndex={0}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
				onWheel={onWheel}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				onContextMenu={(e) => e.preventDefault()}
				data-id="browser-view-surface"
			>
				{picture === null ? (
					<p className="muted mx-browser-wait">{b.waitingPicture}</p>
				) : (
					<img
						ref={image}
						src={picture.src}
						alt=""
						draggable={false}
						style={zoom.scale === 1 ? undefined : { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
					/>
				)}
			</div>
			<input
				ref={typing}
				className="mx-browser-typing"
				type={password ? "password" : "text"}
				aria-label={b.typeHere}
				autoComplete="off"
				autoCorrect="off"
				autoCapitalize="off"
				spellCheck={false}
				enterKeyHint="go"
				onInput={() => {
					if (!composing) onPhoneInput();
				}}
				onCompositionStart={() => setComposing(true)}
				onCompositionEnd={() => {
					setComposing(false);
					onPhoneInput();
				}}
				onKeyDown={onPhoneKeyDown}
				onPaste={onPaste}
				data-id="browser-view-typing"
			/>
			<footer className="mx-browser-foot">
				<div className="mx-browser-tools">
					<button type="button" className="btn btn-sm" onClick={() => typing.current?.focus()} data-id="browser-view-keyboard">
						<BrowserIcon name="keyboard" small />
						{b.keyboard}
					</button>
					{zoom.scale > 1 && (
						<button type="button" className="btn btn-sm" onClick={() => setZoom(NO_ZOOM)}>
							<BrowserIcon name="zoom-out" small />
							{b.resetZoom}
						</button>
					)}
				</div>
				<p className="note mx-browser-note">
					{password ? (
						<strong className="mx-browser-password">
							<Icon name="shield" />
							{b.passwordField}
						</strong>
					) : (
						b.e2e
					)}{" "}
					{!embedded && <span className="muted">{b.expires(expires)}</span>}
				</p>
				{!embedded && (
					<button type="button" className="btn btn-primary btn-sm" disabled={ending} onClick={giveBack} data-id="browser-view-give-back">
						{forSession ? b.giveBack(ai) : b.close}
					</button>
				)}
			</footer>
			{error !== "" && (
				<p className="mx-error mx-browser-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
