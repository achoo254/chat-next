// The compact chat window is a Document Picture-in-Picture window: a small
// always-on-top window with its own document that runs in this page's
// JavaScript context, so the chat core and its data are shared and nothing
// syncs twice. Only Chromium desktop has it; elsewhere the entry points hide.

interface PictureInPictureApi {
	requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

function pictureInPictureApi(): PictureInPictureApi | null {
	if (typeof window === "undefined") return null;
	const api = (window as unknown as { documentPictureInPicture?: PictureInPictureApi }).documentPictureInPicture;
	return api ?? null;
}

export function isPictureInPictureSupported(): boolean {
	return pictureInPictureApi() !== null;
}

export interface WindowSize {
	readonly width: number;
	readonly height: number;
}

/**
 * Copies the page's styles into the picture-in-picture document: stylesheets
 * by link (the CSP allows files of this origin only, never inline CSS in
 * production) and, in development, the style elements the bundler injects.
 */
export function copyDocumentStyles(from: Document, to: Document): void {
	for (const node of from.head.querySelectorAll<HTMLElement>('link[rel="stylesheet"], style')) {
		to.head.append(node.cloneNode(true));
	}
}

/** The root element's attributes the styles depend on: language, theme, message font size. */
const ROOT_ATTRIBUTES = ["lang", "data-theme", "class", "style", "dir"] as const;

function copyRootAttributes(from: HTMLElement, to: HTMLElement): void {
	for (const name of ROOT_ATTRIBUTES) {
		const value = from.getAttribute(name);
		if (value === null) to.removeAttribute(name);
		else to.setAttribute(name, value);
	}
}

/** Keeps the picture-in-picture root in step with the page's; returns the stop function. */
export function mirrorRootAttributes(from: HTMLElement, to: HTMLElement): () => void {
	copyRootAttributes(from, to);
	const observer = new MutationObserver(() => copyRootAttributes(from, to));
	observer.observe(from, { attributes: true, attributeFilter: [...ROOT_ATTRIBUTES] });
	return () => observer.disconnect();
}

export interface OpenedWindow {
	readonly window: Window;
	/** Stops mirroring the root attributes; called when the window closes. */
	readonly stopMirroring: () => void;
}

/**
 * Opens the window. Chromium only allows it from a user gesture, so call this
 * from an event handler. Resolves null when the browser has no such window or
 * refuses it.
 */
export async function openPictureInPicture(size: WindowSize): Promise<OpenedWindow | null> {
	const api = pictureInPictureApi();
	if (api === null) return null;
	let pip: Window;
	try {
		pip = await api.requestWindow({ width: size.width, height: size.height });
	} catch {
		return null;
	}
	copyDocumentStyles(document, pip.document);
	// The page's body classes (platform, density) the styles key on.
	pip.document.body.className = document.body.className;
	const stopMirroring = mirrorRootAttributes(document.documentElement, pip.document.documentElement);
	return { window: pip, stopMirroring };
}
