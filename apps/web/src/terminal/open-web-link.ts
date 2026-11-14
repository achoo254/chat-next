// A link in the terminal's text opens in a new tab. xterm asks the user to
// confirm links that a program sets itself (OSC 8, as agy's "Click here to
// authenticate" does) before it hands them over; a handler of our own takes
// that question over, so both kinds of link (plain text and OSC 8) go through
// here and a click goes straight to the page. Only web addresses open: the
// text of a terminal is whatever its program prints, so a "javascript:" or
// "file:" target never runs.

/** Opens `uri` in a new tab when it is an http(s) address; anything else is ignored. */
export function openWebLink(uri: string): boolean {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return false;
	window.open(url.href, "_blank", "noopener,noreferrer");
	return true;
}
