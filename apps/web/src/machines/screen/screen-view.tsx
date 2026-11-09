// The machine's whole screen through macOS Screen Sharing (tunelo 2.0.13+),
// for what no browser page shows: a passkey sheet, a Keychain prompt.
// First it asks whether Screen Sharing is on: off, it shows the two steps to
// turn it on (tunelo never does); open to the network, it warns. Then noVNC
// (loaded only now) speaks VNC with the system's service through the
// machine's end-to-end encrypted link (vnc-channel.ts). Apple's sign-in asks
// for the Mac account and password: they go to noVNC and on to the service,
// and leave this page's state at once. Desktop: a large area; phone: full
// screen, noVNC's own gestures (tap, two-finger scroll, pinch) and a
// "Bàn phím" button. It closes after 10 minutes without input here.
import { useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";
import type { ScreenShareStatus } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../../components/screen-icons.tsx";
import { useDomId } from "../../messaging/ui/parts.tsx";
import { BrowserIcon } from "../browser/browser-icons.tsx";
import type { MachineLink } from "../link/machine-link.ts";
import { MachineIcon } from "../machine-icons.tsx";
import { errorText } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { keysymOfChar, keysymOfKey, VncChannel } from "./vnc-channel.ts";
import "./screen.css";

/** No input here for this long: the session closes. */
export const SCREEN_IDLE_MS = 10 * 60_000;

type Phase =
	| { readonly kind: "checking" }
	| { readonly kind: "off" }
	| { readonly kind: "ready"; readonly exposed: boolean }
	| { readonly kind: "connecting"; readonly exposed: boolean }
	| { readonly kind: "credentials"; readonly exposed: boolean; readonly user: boolean; readonly wrong: boolean }
	| { readonly kind: "live"; readonly exposed: boolean }
	| { readonly kind: "ended"; readonly idle: boolean };

interface ScreenViewProps {
	link: MachineLink;
	ai: string;
	online: boolean;
	inSession: boolean;
	onClose: () => void;
}

export default function ScreenView({ link, ai, online, inSession, onClose }: ScreenViewProps) {
	const t = useMachinesCopy();
	const s = t.screen;
	const id = useDomId("screen");
	const [phase, setPhase] = useState<Phase>({ kind: "checking" });
	const [status, setStatus] = useState<ScreenShareStatus | null>(null);
	const [error, setError] = useState("");
	const [user, setUser] = useState("");
	const [password, setPassword] = useState("");
	const [checks, setChecks] = useState(0);
	/** The screen at its own size (cut to the view) instead of fitted; with `pan`, a drag moves the view. */
	const [zoomed, setZoomed] = useState(false);
	const [pan, setPan] = useState(false);
	const target = useRef<HTMLDivElement>(null);
	const typing = useRef<HTMLInputElement>(null);
	const rfb = useRef<RFB | null>(null);
	const lastInput = useRef(0);
	const connectRef = useRef<(exposed: boolean) => Promise<void>>(() => Promise.resolve());

	// Is Screen Sharing on, and open to the network? (again on "Kiểm lại")
	useEffect(() => {
		if (!online) return;
		let active = true;
		link.request({ case: "screenShareStatusRequest", value: {} }).then(
			(frame) => {
				if (!active || frame.body.case !== "screenShareStatus") return;
				const st = frame.body.value;
				setStatus(st);
				setPhase(st.enabled ? { kind: "ready", exposed: st.exposed } : { kind: "off" });
				// Opening the view was the user's tap: connect at once unless there is a warning to read first.
				if (st.enabled && !st.exposed) void connectRef.current(false);
			},
			(err: unknown) => {
				if (active) setError(errorText(t, err, ai));
			},
		);
		return () => {
			active = false;
		};
	}, [link, online, checks, t, ai]);

	// Leaving the view ends the session.
	useEffect(
		() => () => {
			rfb.current?.disconnect();
			rfb.current = null;
		},
		[],
	);

	// No input for 10 minutes: close.
	useEffect(() => {
		if (phase.kind !== "live" && phase.kind !== "credentials") return;
		const timer = window.setInterval(() => {
			if (Date.now() - lastInput.current < SCREEN_IDLE_MS) return;
			rfb.current?.disconnect();
			rfb.current = null;
			setPhase({ kind: "ended", idle: true });
		}, 15_000);
		return () => window.clearInterval(timer);
	}, [phase.kind]);

	const exposed = status?.exposed === true;

	/** Opens the session; with the Mac account when the user retries a sign-in (it goes straight to noVNC). */
	const connect = async (exposed: boolean, credentials?: { username: string; password: string }) => {
		const el = target.current;
		if (el === null) return;
		setError("");
		setPhase({ kind: "connecting", exposed });
		lastInput.current = Date.now();
		try {
			const [{ default: Rfb }, channel] = await Promise.all([import("@novnc/novnc"), VncChannel.open(link)]);
			channel.onEnd = (byMachine) => {
				if (byMachine) setPhase((p) => (p.kind === "ended" ? p : { kind: "ended", idle: false }));
			};
			const r = new Rfb(el, channel, { shared: true, ...(credentials ? { credentials } : {}) });
			r.scaleViewport = true;
			r.qualityLevel = 6;
			r.compressionLevel = 2;
			r.addEventListener("connect", () => setPhase({ kind: "live", exposed }));
			r.addEventListener("credentialsrequired", (e) => {
				const types = (e as CustomEvent<{ types: string[] }>).detail.types;
				setPhase((p) => ({ kind: "credentials", exposed, user: types.includes("username"), wrong: p.kind === "credentials" }));
			});
			r.addEventListener("securityfailure", () => setPhase({ kind: "credentials", exposed, user: true, wrong: true }));
			r.addEventListener("disconnect", () => {
				rfb.current = null;
				setPhase((p) => (p.kind === "ended" || p.kind === "credentials" ? p : { kind: "ended", idle: false }));
			});
			rfb.current = r;
		} catch (err) {
			setError(errorText(t, err, ai));
			setPhase({ kind: "ready", exposed });
		}
	};

	useEffect(() => {
		connectRef.current = (shown: boolean) => connect(shown);
	});

	const signIn = () => {
		if (password === "") return;
		// Out of this page's state at once, whatever the machine answers.
		const creds = { username: user, password };
		setPassword("");
		lastInput.current = Date.now();
		const r = rfb.current;
		if (r === null) {
			// A wrong password ended the last attempt: start again with these.
			void connect(exposed, creds);
			return;
		}
		setPhase({ kind: "connecting", exposed });
		r.sendCredentials(creds);
	};

	const zoom = (on: boolean) => {
		const r = rfb.current;
		if (r === null) return;
		r.scaleViewport = !on;
		r.clipViewport = on;
		r.dragViewport = false;
		setZoomed(on);
		setPan(false);
	};

	const togglePan = () => {
		const r = rfb.current;
		if (r === null) return;
		r.dragViewport = !pan;
		setPan(!pan);
	};

	const close = () => {
		rfb.current?.disconnect();
		rfb.current = null;
		onClose();
	};

	const typed = () => {
		const el = typing.current;
		const r = rfb.current;
		if (el === null || r === null || el.value === "") return;
		lastInput.current = Date.now();
		for (const ch of el.value) r.sendKey(keysymOfChar(ch), null);
		el.value = "";
	};

	const live = phase.kind === "live";
	return (
		<div className={`mx-screen${inSession ? " in-session" : ""}`} role="dialog" aria-modal={!inSession} aria-labelledby={`${id}-title`} data-id="screen-view">
			<header className="mx-screen-head">
				<h3 id={`${id}-title`}>
					<MachineIcon name="monitor" />
					<span>{s.title}</span>
				</h3>
				<button type="button" className="icon-btn" aria-label={s.close} title={s.close} onClick={close} data-id="screen-view-close">
					<BrowserIcon name="x" />
				</button>
			</header>
			{exposed && phase.kind !== "off" && (
				<div className="mx-warn mx-screen-warn" role="alert" data-id="screen-view-exposed">
					<Icon name="alert-triangle" />
					<div>
						<strong>{s.exposedTitle}</strong>
						<p>{s.exposedBody}</p>
					</div>
				</div>
			)}
			{/* The remote screen: noVNC draws its canvas here and handles pointer, wheel and gestures on it. */}
			<div
				ref={target}
				className="mx-screen-surface"
				data-live={live ? "" : undefined}
				onPointerDownCapture={() => (lastInput.current = Date.now())}
				onKeyDownCapture={() => (lastInput.current = Date.now())}
				data-id="screen-view-surface"
			>
				{!live && (
					<div className="mx-screen-panel">
						{phase.kind === "checking" && <p className="muted">{s.checking}</p>}
						{phase.kind === "off" && (
							<div className="mx-screen-off" data-id="screen-view-off">
								<h4>{s.offTitle}</h4>
								<ol>
									{s.offSteps.map((step) => (
										<li key={step}>{step}</li>
									))}
								</ol>
								<p className="note">{s.offNote}</p>
								<button type="button" className="btn btn-sm" onClick={() => setChecks((n) => n + 1)} data-id="screen-view-recheck">
									{s.recheck}
								</button>
							</div>
						)}
						{phase.kind === "ready" && (
							<>
								<p className="note">{s.note}</p>
								<button type="button" className="btn btn-primary btn-sm" disabled={!online} onClick={() => void connect(exposed)} data-id="screen-view-connect">
									{s.connect}
								</button>
							</>
						)}
						{phase.kind === "connecting" && <p className="muted">{s.connecting}</p>}
						{phase.kind === "credentials" && (
							<div className="mx-screen-signin" data-id="screen-view-signin">
								{phase.wrong && (
									<p className="mx-error" role="alert">
										{s.wrongPassword}
									</p>
								)}
								{phase.user && (
									<label className="field">
										<span>{s.user}</span>
										<input className="input" value={user} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setUser(e.target.value)} data-id="screen-view-user" />
									</label>
								)}
								<label className="field">
									<span>{s.password}</span>
									<input
										className="input"
										type="password"
										value={password}
										autoComplete="off"
										onChange={(e) => setPassword(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") signIn();
										}}
										data-id="screen-view-password"
									/>
								</label>
								<p className="note">{s.credentialsNote}</p>
								<button type="button" className="btn btn-primary btn-sm" disabled={password === ""} onClick={signIn} data-id="screen-view-sign-in">
									{s.signIn}
								</button>
							</div>
						)}
						{phase.kind === "ended" && (
							<>
								<p className="muted">{phase.idle ? s.idleEnded : s.ended}</p>
								<button type="button" className="btn btn-sm" onClick={() => setChecks((n) => n + 1)}>
									{s.connect}
								</button>
							</>
						)}
						{error !== "" && (
							<p className="mx-error" role="alert">
								{error}
							</p>
						)}
					</div>
				)}
			</div>
			{live && (
				<footer className="mx-screen-foot">
					<button type="button" className="btn btn-sm" onClick={() => typing.current?.focus()} data-id="screen-view-keyboard">
						<BrowserIcon name="keyboard" small />
						{s.keyboard}
					</button>
					<button type="button" className="btn btn-sm" aria-pressed={zoomed} onClick={() => zoom(!zoomed)} data-id="screen-view-zoom">
						{zoomed ? s.zoomFit : s.zoomIn}
					</button>
					{zoomed && (
						<button type="button" className="btn btn-sm" aria-pressed={pan} onClick={togglePan} data-id="screen-view-pan">
							{s.pan}
						</button>
					)}
					<input
						ref={typing}
						className="mx-browser-typing"
						aria-label={s.typeHere}
						autoComplete="off"
						autoCorrect="off"
						autoCapitalize="off"
						spellCheck={false}
						onInput={typed}
						onKeyDown={(e) => {
							const keysym = keysymOfKey(e.key);
							if (keysym === null || rfb.current === null) return;
							e.preventDefault();
							lastInput.current = Date.now();
							rfb.current.sendKey(keysym, e.code || null);
						}}
					/>
					<p className="note">{t.browser.e2e}</p>
				</footer>
			)}
		</div>
	);
}
