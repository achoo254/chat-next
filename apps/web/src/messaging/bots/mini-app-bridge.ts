// The Mini App bridge (phase-16 "Hợp đồng R6 web"): what a Mini App may ask
// the container through window.parent.postMessage({type, data}, "*"), and
// the frame URL that hands it its init data. The container only takes
// messages from its own iframe at the Mini App's origin (mini-app.tsx);
// this file checks their shape. Each message is at most 4 KB as JSON;
// unknown types and malformed data are dropped.

/** Largest bridge message, as UTF-8 JSON. */
export const BRIDGE_MAX_BYTES = 4096;
/** Longest main button text the container draws. */
const MAIN_BUTTON_TEXT_MAX = 64;
/** Longest link a Mini App may ask to open. */
const LINK_MAX = 2048;

export type ColorScheme = "light" | "dark";

/** A message from the Mini App, checked. */
export type BridgeMessage =
	| { readonly type: "ready" }
	| { readonly type: "close" }
	| { readonly type: "request_write_access" }
	| { readonly type: "main_button"; readonly text: string; readonly visible: boolean; readonly enabled: boolean }
	| { readonly type: "open_link"; readonly url: string }
	| { readonly type: "data_send"; readonly data: string };

/** Messages the container posts down to the Mini App. */
export type BridgeEvent =
	| { readonly type: "theme"; readonly data: { readonly scheme: ColorScheme } }
	| { readonly type: "main_button_pressed" }
	| { readonly type: "write_access"; readonly data: { readonly granted: boolean } };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Size of a value as UTF-8 JSON; null when it is not JSON (a cycle, a function, a BigInt…). */
function jsonBytes(value: unknown): number | null {
	try {
		const json = JSON.stringify(value) as string | undefined;
		return json === undefined ? null : new TextEncoder().encode(json).length;
	} catch {
		return null;
	}
}

/** The message a Mini App posted, or null to drop it (too large, unknown type, wrong data). */
export function parseBridgeMessage(raw: unknown): BridgeMessage | null {
	if (!isRecord(raw) || typeof raw.type !== "string") return null;
	const size = jsonBytes(raw);
	if (size === null || size > BRIDGE_MAX_BYTES) return null;
	const data = raw.data;
	switch (raw.type) {
		case "ready":
		case "close":
		case "request_write_access":
			return { type: raw.type };
		case "main_button": {
			if (!isRecord(data)) return null;
			const { text, visible, enabled } = data;
			if (typeof text !== "string" || typeof visible !== "boolean" || typeof enabled !== "boolean") return null;
			if ([...text].length > MAIN_BUTTON_TEXT_MAX) return null;
			return { type: "main_button", text: text.trim(), visible, enabled };
		}
		case "open_link":
			if (!isRecord(data) || typeof data.url !== "string" || data.url === "" || data.url.length > LINK_MAX) return null;
			return { type: "open_link", url: data.url };
		case "data_send":
			if (!isRecord(data) || typeof data.data !== "string" || data.data === "") return null;
			return { type: "data_send", data: data.data };
		default:
			return null;
	}
}

/** Origin and host of a Mini App URL; null unless it is https (the server only hands out https). */
export function miniAppTarget(url: string): { readonly origin: string; readonly host: string } | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" ? { origin: parsed.origin, host: parsed.host } : null;
	} catch {
		return null;
	}
}

/** The iframe's src: the URL with the init data and the theme in its fragment (never sent to a server). */
export function miniAppFrameSrc(url: string, initData: string, scheme: ColorScheme): string {
	const parsed = new URL(url);
	parsed.hash = `chatAppData=${encodeURIComponent(initData)}&chatAppTheme=${scheme}`;
	return parsed.href;
}
