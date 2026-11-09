// The part of noVNC's RFB (@novnc/novnc, MPL-2.0) this app uses. The package
// ships no types.
declare module "@novnc/novnc" {
	export interface RfbCredentials {
		username?: string;
		password?: string;
	}

	export default class RFB extends EventTarget {
		constructor(target: HTMLElement, urlOrChannel: string | object, options?: { credentials?: RfbCredentials; shared?: boolean });
		scaleViewport: boolean;
		clipViewport: boolean;
		dragViewport: boolean;
		resizeSession: boolean;
		focusOnClick: boolean;
		viewOnly: boolean;
		qualityLevel: number;
		compressionLevel: number;
		sendCredentials(credentials: RfbCredentials): void;
		sendKey(keysym: number, code: string | null, down?: boolean): void;
		focus(): void;
		disconnect(): void;
	}
}
