// A Localman request the AI sent (localman_send_request) as a card under its
// tool row: method and URL, the status colored by class, the time, the
// response headers (secret ones masked) and the body folded to a few lines.
// «Mở trong Localman» shows when the result names its history page;
// «Chép kết quả gọn» puts a short form into the chat's composer when the
// session shows in the Chat app's AI panel. A result that is not the
// request's JSON keeps the generic output instead (parseLocalmanResult null).
import { useContext, useState } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { formatBytes } from "../../messaging/media/media-format.ts";
import type { MachinesCopy } from "../copy-vi.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { UseTextContext } from "./use-text-context.ts";

export interface LocalmanResult {
	readonly method: string;
	readonly url: string;
	readonly status: number;
	readonly statusText: string;
	readonly ms: number;
	readonly headers: readonly { readonly name: string; readonly value: string }[];
	readonly body: string;
	readonly binary: boolean;
	readonly size: number;
	readonly truncated: boolean;
	/** Localman's page of this request in its history (https only); "" when the result names none. */
	readonly historyUrl: string;
}

/** Lines of the body shown before «Xem thêm». */
export const BODY_LINES = 6;
/** Lines of the body the short copy carries. */
const COPY_LINES = 5;
const MASKED = "••••••";
/** Headers whose values are secrets: credentials, cookies, keys and tokens. */
const SECRET_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie)$|api[-_]?key|token|secret|session|password|auth/i;

/** The tool, under any client prefix ("mcp__tunelo__localman_send_request"). */
export function isLocalmanSend(name: string): boolean {
	return name === "localman_send_request" || name.endsWith("__localman_send_request");
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parse(text: string): Record<string, unknown> | null {
	try {
		return record(JSON.parse(text));
	} catch {
		return null;
	}
}

/** The response object, bare or inside an MCP result (structuredContent, or a text content holding it). */
function responseOf(output: string): Record<string, unknown> | null {
	const top = parse(output);
	if (top === null) return null;
	if (typeof top.status === "number") return top;
	const structured = record(top.structuredContent);
	if (structured !== null && typeof structured.status === "number") return structured;
	if (Array.isArray(top.content)) {
		for (const part of top.content) {
			const item = record(part);
			const inner = item !== null && typeof item.text === "string" ? parse(item.text) : null;
			if (inner !== null && typeof inner.status === "number") return inner;
		}
	}
	return null;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The card's data from the call's input and its output; null when the output is not the request's JSON. */
export function parseLocalmanResult(input: string, output: string): LocalmanResult | null {
	const response = responseOf(output);
	if (response === null || typeof response.status !== "number") return null;
	const call = parse(input) ?? {};
	const timings = record(response.timings);
	const headers = Array.isArray(response.headers)
		? response.headers.flatMap((h) => {
				const header = record(h);
				return header !== null && typeof header.name === "string" && typeof header.value === "string" ? [{ name: header.name, value: header.value }] : [];
			})
		: [];
	const history = str(response.historyUrl);
	return {
		method: (str(call.method) || "GET").toUpperCase(),
		url: str(response.finalUrl) || str(call.url),
		status: response.status,
		statusText: str(response.statusText),
		ms: typeof timings?.total === "number" ? Math.round(timings.total) : 0,
		headers,
		body: str(response.body),
		binary: response.bodyEncoding === "base64",
		size: typeof response.size === "number" ? response.size : 0,
		truncated: response.truncated === true,
		historyUrl: history.startsWith("https://") ? history : "",
	};
}

/** A header value as the card shows it: secrets masked. */
export function shownHeader(name: string, value: string): string {
	return SECRET_HEADER.test(name) ? MASKED : value;
}

/** The status's class for its color: ok (2xx), redirect (3xx), client (4xx), server (5xx and anything else). */
export function statusClass(status: number): "ok" | "redirect" | "client" | "server" {
	if (status >= 200 && status < 300) return "ok";
	if (status >= 300 && status < 400) return "redirect";
	if (status >= 400 && status < 500) return "client";
	return "server";
}

/** "<METHOD> <URL> → <status> (<ms> ms)" and up to five lines of a text body: what a chat reply needs. */
export function shortResult(result: LocalmanResult): string {
	const head = `${result.method} ${result.url} → ${result.status} (${result.ms} ms)`;
	if (result.binary || result.body.trim() === "") return head;
	return [head, ...result.body.split("\n").slice(0, COPY_LINES)].join("\n");
}

export function LocalmanResultCard({ result }: { result: LocalmanResult }) {
	const t: MachinesCopy = useMachinesCopy();
	const c = t.transcript.localman;
	const { locale } = useI18n();
	const toComposer = useContext(UseTextContext);
	const [open, setOpen] = useState(false);
	const lines = result.body.split("\n");
	const long = !result.binary && lines.length > BODY_LINES;
	const body = long && !open ? lines.slice(0, BODY_LINES).join("\n") : result.body;
	return (
		<section className="mx-lm" aria-label={c.label}>
			<div className="mx-lm-head">
				<b>{result.method}</b>
				<span className="mono" title={result.url}>
					{result.url}
				</span>
			</div>
			<div className="mx-lm-meta">
				<span className={`mx-lm-status ${statusClass(result.status)}`} data-status-class={statusClass(result.status)}>
					{result.statusText === "" ? result.status : `${result.status} ${result.statusText}`}
				</span>
				<span>{result.ms} ms</span>
				{result.size > 0 && <span>{formatBytes(result.size, locale)}</span>}
			</div>
			{result.headers.length > 0 && (
				<details className="mx-lm-headers">
					<summary>{c.headers(result.headers.length)}</summary>
					<dl>
						{result.headers.map((h, i) => (
							<div key={`${i}:${h.name}`}>
								<dt>{h.name}</dt>
								<dd className="mono">{shownHeader(h.name, h.value)}</dd>
							</div>
						))}
					</dl>
				</details>
			)}
			{result.binary ? (
				<p className="muted">{c.binary(formatBytes(result.size, locale))}</p>
			) : result.body === "" ? (
				<p className="muted">{c.empty}</p>
			) : (
				<pre className="mx-pre mx-lm-body">{body}</pre>
			)}
			{result.truncated && <p className="muted">{c.truncated}</p>}
			{(long || result.historyUrl !== "" || toComposer !== null) && (
				<div className="mx-lm-acts">
					{long && (
						<button type="button" className="mx-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
							{open ? c.less : c.more}
						</button>
					)}
					{result.historyUrl !== "" && (
						<a className="btn btn-sm" href={result.historyUrl} target="_blank" rel="noopener noreferrer">
							<Icon name="external" small />
							{c.open}
						</a>
					)}
					{toComposer !== null && (
						<button type="button" className="btn btn-sm" onClick={() => void toComposer(shortResult(result), true)}>
							<Icon name="copy" small />
							{c.copyShort}
						</button>
					)}
				</div>
			)}
		</section>
	);
}
