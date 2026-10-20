// The Mini App container (mockups/bots.html#mini-app, #mini-app-permission,
// #mini-app-minimized, mobile.html#mini-app; phase-16 "Hợp đồng R6 web"):
// docked in the info column's place (full screen when narrow, placed by
// ui/mini-app-slot.tsx) with a header the app draws, so the Mini App cannot
// fake it: the bot's name, the real host of the URL, the "⋯" menu (reload,
// minimize, the bot's profile, report) and close. Minimized, it keeps running
// hidden and a chip brings it back; the Mini App hears "deactivated" and
// "activated" down the bridge. The Mini App runs in a
// sandboxed iframe on the bot owner's own domain, never on the app's, so it
// reads none of the app's cookies or storage and cannot navigate the app
// (no allow-top-navigation). It talks to the app only through the bridge
// (mini-app-bridge.ts): messages from that iframe at the Mini App's origin,
// answered with that origin as the target, never "*". The main button and
// the popups asking for permission or before opening a link are drawn by
// the app too. Loaded with the first Mini App opened, with its own styles.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useChat, useServices, useUser } from "../data/services.tsx";
import { ChatAvatar, useDomId } from "../ui/parts.tsx";
import { PopupMenu } from "../ui/popup-menu.tsx";
import { isAllowedLink } from "../ui/rich-text.tsx";
import { closeMiniApp, minimizeMiniApp, useUi, type MiniAppRequest } from "../ui/ui-context.tsx";
import { miniAppFrameSrc, miniAppTarget, parseBridgeMessage, type BridgeEvent, type BridgeMessage, type ColorScheme } from "./mini-app-bridge.ts";
import { launchMiniApp } from "./mini-app-launch.ts";
import { useBotsCopy } from "./use-bots-copy.ts";
import "./mini-app.css";

/** What the sandbox allows: scripts, forms, its own origin's storage and popups (opened links); never top navigation. */
export const MINI_APP_SANDBOX = "allow-scripts allow-forms allow-same-origin allow-popups";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The app's theme now: the one chosen in Settings, else the system's. */
function currentScheme(): ColorScheme {
	const chosen = document.documentElement.dataset.theme;
	if (chosen === "light" || chosen === "dark") return chosen;
	return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function subscribeScheme(listener: () => void): () => void {
	const observer = new MutationObserver(listener);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	const media = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
	media?.addEventListener("change", listener);
	return () => {
		observer.disconnect();
		media?.removeEventListener("change", listener);
	};
}

interface MainButton {
	readonly text: string;
	readonly visible: boolean;
	readonly enabled: boolean;
}

type Popup = { readonly kind: "write" } | { readonly kind: "link"; readonly url: string; readonly host: string };

/** The host a link names in the confirmation ("" for links without one, such as mailto:). */
function linkHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
}

/** `minimized`: kept mounted (the frame keeps its state) but hidden. */
export default function MiniApp({ request, minimized }: { request: MiniAppRequest; minimized: boolean }) {
	const t = useBotsCopy().miniApp;
	const { bots, toasts, backend } = useServices();
	const ui = useUi();
	const user = useUser(request.botId);
	const name = user?.name ?? "";
	// Data goes to the bot only from a Mini App opened in the private chat
	// with it (or its profile, chat 0): the server cannot tell where it was
	// opened, so a Mini App opened from a group cannot post as the user.
	const opened = useChat(request.chatId);
	const maySend = request.chatId === 0 || (opened?.type === "private" && opened.peerUserId === request.botId);
	const scheme = useSyncExternalStore(subscribeScheme, currentScheme);
	const [target] = useState(() => miniAppTarget(request.url));
	const [src] = useState(() => (target === null ? "" : miniAppFrameSrc(request.url, request.initData, currentScheme())));
	const frame = useRef<HTMLIFrameElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const moreButton = useRef<HTMLButtonElement>(null);
	const moreAnchor = useRef<HTMLDivElement>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	// "Tải lại": OpenMiniApp in flight; its answer opens the Mini App afresh in this one's place.
	const [reloading, setReloading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [main, setMain] = useState<MainButton | null>(null);
	const [popup, setPopup] = useState<Popup | null>(null);
	// AllowMiniAppWrite or SendMiniAppData in flight.
	const [busy, setBusy] = useState(false);
	const titleId = useDomId("ma-popup");
	const bodyId = useDomId("ma-popup-body");

	/** Posts to the Mini App, addressed to its origin only. */
	const post = (event: BridgeEvent) => {
		if (target !== null) frame.current?.contentWindow?.postMessage(event, target.origin);
	};

	const close = () => closeMiniApp(ui.miniApp, request.id);

	// The server only hands out https URLs; anything else is not loaded.
	useEffect(() => {
		if (target !== null) return;
		toasts.show(t.openFailed);
		closeMiniApp(ui.miniApp, request.id);
	}, [target, toasts, t, ui, request.id]);

	useEffect(() => {
		closeButton.current?.focus();
	}, []);

	// The theme the Mini App got in its URL; changes go down the bridge.
	const sentScheme = useRef(scheme);
	useEffect(() => {
		if (sentScheme.current === scheme) return;
		sentScheme.current = scheme;
		post({ type: "theme", data: { scheme } });
	});

	// Minimized and shown again: the Mini App hears it, and focus comes back to the header.
	const sentShown = useRef(!minimized);
	useEffect(() => {
		if (sentShown.current === !minimized) return;
		sentShown.current = !minimized;
		post({ type: minimized ? "deactivated" : "activated" });
		if (!minimized) closeButton.current?.focus();
	});

	const handle = (message: BridgeMessage) => {
		switch (message.type) {
			case "ready":
				setLoaded(true);
				return;
			case "close":
				close();
				return;
			case "main_button":
				setMain({ text: message.text, visible: message.visible, enabled: message.enabled });
				return;
			case "open_link":
				if (popup !== null) return;
				if (!isAllowedLink(message.url)) {
					toasts.show(t.linkBlocked);
					return;
				}
				setPopup({ kind: "link", url: message.url, host: linkHost(message.url) });
				return;
			case "request_write_access":
				if (popup === null) setPopup({ kind: "write" });
				return;
			case "data_send":
				if (busy || !maySend) return;
				setBusy(true);
				bots.sendMiniAppData(request.botId, message.data, request.buttonText).then(close, () => {
					toasts.show(t.sendFailed);
					setBusy(false);
				});
				return;
		}
	};
	// The listener stays for the panel's life and calls the newest handler.
	const handler = useRef(handle);
	useLayoutEffect(() => {
		handler.current = handle;
	});
	useEffect(() => {
		if (target === null) return;
		const onMessage = (event: MessageEvent) => {
			// Only the Mini App's own frame, at its origin, is heard.
			const source = frame.current?.contentWindow;
			if (source == null || event.source !== source || event.origin !== target.origin) return;
			const message = parseBridgeMessage(event.data);
			if (message !== null) handler.current(message);
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [target]);

	const answerWrite = (granted: boolean) => {
		post({ type: "write_access", data: { granted } });
		setPopup(null);
	};
	const allowWrite = () => {
		setBusy(true);
		bots.allowMiniAppWrite(request.botId).then(
			() => {
				setBusy(false);
				answerWrite(true);
			},
			() => {
				setBusy(false);
				toasts.show(t.allowFailed);
				answerWrite(false);
			},
		);
	};
	const openLink = (url: string) => {
		setPopup(null);
		window.open(url, "_blank", "noopener,noreferrer");
	};
	const dismissPopup = () => {
		if (popup?.kind === "write") answerWrite(false);
		else setPopup(null);
	};

	const onKey = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		event.preventDefault();
		if (popup === null) close();
		else if (!busy) dismissPopup();
	};

	const closeMenu = () => {
		setMenuOpen(false);
		moreButton.current?.focus();
	};
	const reload = () => {
		setMenuOpen(false);
		setReloading(true);
		const again = { botId: request.botId, chatId: request.chatId, seq: request.seq, url: request.buttonUrl, buttonText: request.buttonText };
		launchMiniApp(bots, ui, again).catch(() => {
			setReloading(false);
			toasts.show(t.reloadFailed);
		});
	};
	const minimize = () => {
		setMenuOpen(false);
		minimizeMiniApp(ui.miniApp, request.id, true);
	};
	const openProfile = () => {
		setMenuOpen(false);
		ui.dialog.set({ kind: "profile", userId: request.botId });
	};
	const report = () => {
		setMenuOpen(false);
		ui.dialog.set({ kind: "report", target: { kind: "user", userId: request.botId }, name, blockUserId: request.botId });
	};

	if (target === null) return null;
	const covered = popup !== null;
	return (
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc pressed on any control inside the panel bubbles here to close it or its popup
		<section className="mini-app" aria-label={t.label(name)} hidden={minimized} onKeyDown={onKey}>
			<header className="ma-head" inert={covered}>
				<div className="ma-title">
					<strong>{name}</strong>
					<span className="ma-origin">
						<Icon name="lock" small />
						<span>{target.host}</span>
					</span>
				</div>
				<div className="menu-anchor" ref={moreAnchor}>
					<button
						ref={moreButton}
						type="button"
						className="icon-btn"
						aria-label={t.more}
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						onClick={() => setMenuOpen((open) => !open)}
					>
						<Icon name="dots" />
					</button>
					{menuOpen && !minimized && (
						<PopupMenu label={t.menu} className="ma-menu" boundary={moreAnchor} onClose={closeMenu}>
							<button type="button" role="menuitem" disabled={reloading || busy} onClick={reload}>
								<Icon name="refresh" />
								{t.reload}
							</button>
							<button type="button" role="menuitem" onClick={minimize}>
								<Icon name="minimize" />
								{t.minimize}
							</button>
							<button type="button" role="menuitem" onClick={openProfile}>
								<Icon name="user" />
								{t.profile}
							</button>
							{backend.features.has("report") && (
								<button type="button" role="menuitem" className="danger" onClick={report}>
									<Icon name="flag" />
									{t.report}
								</button>
							)}
						</PopupMenu>
					)}
				</div>
				<button ref={closeButton} type="button" className="icon-btn" aria-label={t.close} onClick={close}>
					<Icon name="x" />
				</button>
			</header>
			<div className="ma-frame" inert={covered}>
				{(!loaded || reloading) && (
					<div className="ma-loading" role="status">
						{t.loading}
					</div>
				)}
				<iframe ref={frame} title={t.label(name)} src={src} sandbox={MINI_APP_SANDBOX} onLoad={() => setLoaded(true)} />
			</div>
			{main !== null && main.visible && main.text !== "" && (
				<div className="ma-main" inert={covered}>
					<button type="button" className="btn btn-primary" disabled={!main.enabled || busy} onClick={() => post({ type: "main_button_pressed" })}>
						{main.text}
					</button>
				</div>
			)}
			{popup !== null && (
				<div className="ma-popup-layer">
					<div className="panel popup" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId}>
						{popup.kind === "write" ? (
							<>
								<div className="dlg-body">
									<span className="popup-from">
										<ChatAvatar id={request.botId} name={name} size="sm" bot photoOf={request.botId} photoId={user?.photoId ?? ""} />
										{name}
									</span>
									<h2 id={titleId}>{t.writeTitle}</h2>
									<p id={bodyId}>{t.writeBody(name)}</p>
								</div>
								<div className="dlg-foot">
									<button type="button" className="btn" disabled={busy} onClick={() => answerWrite(false)}>
										{t.deny}
									</button>
									{/* eslint-disable-next-line jsx-a11y/no-autofocus -- the alertdialog takes focus when it opens (WAI-ARIA dialog pattern) */}
									<button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy} autoFocus onClick={allowWrite}>
										{t.allow}
									</button>
								</div>
							</>
						) : (
							<>
								<div className="dlg-body">
									<span className="popup-from">
										<Icon name="alert" small />
										{t.linkFrom}
									</span>
									<h2 id={titleId}>
										{t.linkTitle} {popup.host === "" ? null : <span className="host">{popup.host}</span>}
									</h2>
									<p id={bodyId}>{t.linkBody}</p>
									<span className="url-line">{popup.url}</span>
								</div>
								<div className="dlg-foot">
									<button type="button" className="btn" onClick={() => setPopup(null)}>
										{t.cancel}
									</button>
									{/* eslint-disable-next-line jsx-a11y/no-autofocus -- the alertdialog takes focus when it opens (WAI-ARIA dialog pattern) */}
									<button type="button" className="btn btn-primary" autoFocus onClick={() => openLink(popup.url)}>
										{t.openLink}
									</button>
								</div>
							</>
						)}
					</div>
				</div>
			)}
		</section>
	);
}

/**
 * A minimized Mini App (mockups/bots.html#mini-app-minimized): click to show
 * it again, x to close it. `floating`: the narrow screens' pill above the
 * composer, or on the screen when no conversation shows.
 */
export function MiniAppChip({ request, floating }: { request: MiniAppRequest; floating: boolean }) {
	const t = useBotsCopy().miniApp;
	const ui = useUi();
	const name = useUser(request.botId)?.name ?? "";
	const restoreButton = useRef<HTMLButtonElement>(null);
	// Minimizing hid the focused control: focus moves here instead of being lost.
	useEffect(() => {
		const active = document.activeElement;
		if (active === null || active === document.body || active.closest(".mini-app") !== null) restoreButton.current?.focus();
	}, []);
	return (
		<div className={floating ? "ma-chip floating" : "ma-chip"}>
			<button ref={restoreButton} type="button" className="ma-chip-open" aria-label={t.restore(name)} onClick={() => minimizeMiniApp(ui.miniApp, request.id, false)}>
				<Icon name="robot" small />
				<span>{t.chip(name)}</span>
			</button>
			<button type="button" className="icon-btn" aria-label={t.close} onClick={() => closeMiniApp(ui.miniApp, request.id)}>
				<Icon name="x" small />
			</button>
		</div>
	);
}
