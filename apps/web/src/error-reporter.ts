// Errors nothing caught (window "error", unhandled rejections, React render
// errors) are counted by the server for the operators' daily digest
// (FeedbackService.ReportClientError, plain JSON fetch: no protobuf runtime
// at startup). Sent is only the error's name and message (URLs cut), the
// top frame in this app's own code as "path:line:column", the build and the
// route's name: never ids, a query, or what the user typed. Each page load
// reports at most REPORTS_MAX errors, each kind of error once.
import { RPC_BASE_URL } from "./api/get-self.ts";
import { matchRoute } from "./router.tsx";

export const REPORTS_MAX = 5;
const MESSAGE_MAX = 300;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi;
const FRAME = /(https?:\/\/[^\s()]+?):(\d+):(\d+)/g;

export type ClientErrorKind = "error" | "rejection" | "render";

const WIRE_KINDS: Record<ClientErrorKind, string> = {
	error: "CLIENT_ERROR_KIND_ERROR",
	rejection: "CLIENT_ERROR_KIND_UNHANDLED_REJECTION",
	render: "CLIENT_ERROR_KIND_RENDER",
};

const seen = new Set<string>();

/** The build: the name of the chunk this code ships in (index-<hash> in production). */
function release(): string {
	return /([\w.-]+)\.[jt]sx?$/.exec(new URL(import.meta.url).pathname)?.[1] ?? "";
}

/** The first frame of `stack` in this origin's code, without the origin. */
export function topFrame(stack: string): string {
	for (const [, url = "", line, column] of stack.matchAll(FRAME)) {
		const at = new URL(url);
		if (at.origin === location.origin) return `${at.pathname.slice(1)}:${line}:${column}`;
	}
	return "";
}

/** Sends one report, unless this load already sent it or REPORTS_MAX reports. */
export function reportClientError(kind: ClientErrorKind, error: unknown): void {
	const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(URL_PATTERN, "[url]").slice(0, MESSAGE_MAX);
	const at = error instanceof Error && error.stack !== undefined ? topFrame(error.stack) : "";
	const key = `${kind}\n${message}\n${at}`;
	if (seen.size >= REPORTS_MAX || seen.has(key)) return;
	seen.add(key);
	const body = { kind: WIRE_KINDS[kind], message, location: at, release: release(), route: matchRoute(location.pathname)?.name ?? "other" };
	fetch(`${RPC_BASE_URL}/app.v1.FeedbackService/ReportClientError`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		credentials: "same-origin",
		keepalive: true,
	}).catch(() => undefined);
}

/** Listens for uncaught errors; render errors come through createRoot's onUncaughtError. */
export function installErrorReporter(): void {
	// Events without an Error (cross-origin "Script error.", ResizeObserver notices) say nothing useful.
	addEventListener("error", (event) => {
		if (event.error instanceof Error) reportClientError("error", event.error);
	});
	addEventListener("unhandledrejection", (event) => reportClientError("rejection", event.reason));
}
