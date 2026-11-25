// What the address bar's text means: an address (https when it names no scheme), an address on the
// machine itself (localhost and numeric addresses go over http, as nothing there has a certificate),
// or words to search for. Pure; the machine still refuses anything but http and https.

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i;
const HOST = /^[^\s/?#:]+\.[^\s/?#:]+(:\d+)?([/?#]|$)/;

export const SEARCH_URL = "https://www.google.com/search?q=";

/** The address to go to for what was typed; null when nothing was. */
export function addressToUrl(input: string): string | null {
	const text = input.trim();
	if (text === "") return null;
	if (SCHEME.test(text)) return text;
	if (/\s/.test(text)) return `${SEARCH_URL}${encodeURIComponent(text)}`;
	if (LOCAL.test(text)) return `http://${text}`;
	if (HOST.test(text)) return `https://${text}`;
	return `${SEARCH_URL}${encodeURIComponent(text)}`;
}
