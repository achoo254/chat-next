import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Opens a URL in the default browser — cross-platform, no deps. Best effort:
 *  the URL is printed too, for headless machines. */
export async function openBrowser(url: string): Promise<void> {
	if (process.env.TUNELO_NO_BROWSER) return;
	try {
		if (process.platform === "darwin") await run("open", [url]);
		else if (process.platform === "win32")
			await run("cmd", ["/c", "start", "", url]);
		else await run("xdg-open", [url]);
	} catch {
		// ignore — the URL is printed for manual opening
	}
}
