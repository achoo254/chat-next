import type { Command } from "commander";
import {
	fetchInspectorRequest,
	fetchInspectorRequests,
} from "./inspector-client.js";
import type { InspectorEntrySummary } from "./request-store.js";
import { type RunRecord, listRecords } from "./run-registry.js";
import { pickHttpRun, targetSubdomain } from "./run-target.js";
import {
	type WatchFilter,
	formatDetails,
	formatLine,
	isStatusFilter,
	matchesFilter,
} from "./watch-format.js";

interface WatchOptions {
	lines: string;
	status?: string;
	path?: string;
	headers?: boolean;
	body?: boolean;
}

function fail(message: string): never {
	console.error(`  ${message}`);
	process.exit(1);
}

/** The one running HTTP tunnel `target` names (or the only one running). */
function pickRun(target: string | undefined): RunRecord {
	const pick = pickHttpRun(listRecords(), target);
	if (pick.kind === "one") return pick.run;
	if (pick.kind === "none") {
		fail(
			target
				? `No running HTTP tunnel matches "${target}" (see: tunelo status).`
				: "No HTTP tunnel is running. Start one with: tunelo http <port>",
		);
	}
	console.error("  Several tunnels are running; name one:");
	for (const record of pick.matches) {
		const urls = record.tunnels.map((tunnel) => tunnel.url).join(", ");
		console.error(`    PID ${record.pid}  ${urls || "(connecting…)"}`);
	}
	fail("Run: tunelo watch <PID|subdomain|URL>");
}

/** Prints each new SSE `data:` event of the inspector until it closes. */
async function streamEvents(
	base: string,
	onEntry: (entry: InspectorEntrySummary) => Promise<void>,
): Promise<void> {
	const response = await fetch(`${base}/api/events`);
	if (!response.ok || !response.body) {
		throw new Error(`inspector answered ${response.status}`);
	}
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of response.body) {
		buffer += decoder.decode(chunk, { stream: true });
		let end = buffer.indexOf("\n\n");
		while (end !== -1) {
			const event = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			for (const line of event.split("\n")) {
				if (line.startsWith("data: ")) {
					await onEntry(JSON.parse(line.slice(6)) as InspectorEntrySummary);
				}
			}
			end = buffer.indexOf("\n\n");
		}
	}
}

export function registerWatchCommand(program: Command): void {
	program
		.command("watch [target]")
		.description(
			"Show the requests of a running tunnel as they happen (PID, subdomain or URL)",
		)
		.option(
			"-n, --lines <count>",
			"Recent requests to show first (0: only new ones)",
			"10",
		)
		.option("--status <code>", "Only these statuses: 2xx, 4xx, 5xx or a code")
		.option("--path <text>", "Only paths containing this text")
		.option("--headers", "Also print request and response headers")
		.option("--body", "Also print request and response bodies")
		.action(async (target: string | undefined, options: WatchOptions) => {
			const count = Number(options.lines);
			if (!Number.isInteger(count) || count < 0) {
				fail("--lines takes a whole number (0 or more).");
			}
			if (options.status && !isStatusFilter(options.status)) {
				fail("--status takes 2xx, 4xx, 5xx or a code such as 404.");
			}
			const run = pickRun(target);
			if (!run.inspectorPort) {
				fail(
					"This tunnel has no inspector to read (started with --no-inspect, or by a CLI older than 1.9.0).",
				);
			}
			const inspectorPort = run.inspectorPort;
			const base = `http://127.0.0.1:${inspectorPort}`;
			const subdomain = target ? targetSubdomain(run, target) : undefined;
			const filter: WatchFilter = {
				subdomain,
				status: options.status,
				path: options.path,
			};
			const showSubdomain = !subdomain && run.tunnels.length > 1;
			const details = {
				headers: options.headers === true,
				body: options.body === true,
			};

			const print = async (entry: InspectorEntrySummary): Promise<void> => {
				if (!matchesFilter(entry, filter)) return;
				console.log(formatLine(entry, showSubdomain));
				if (!details.headers && !details.body) return;
				const full = await fetchInspectorRequest(inspectorPort, entry.id).catch(
					() => null,
				);
				if (full)
					for (const line of formatDetails(full, details)) console.log(line);
			};

			try {
				const urls = run.tunnels.map((tunnel) => tunnel.url).join(", ");
				console.error(
					`  Watching ${urls || `PID ${run.pid}`} (Ctrl+C to stop)`,
				);
				if (count > 0) {
					const recent = await fetchInspectorRequests(inspectorPort);
					const shown = recent.filter((entry) => matchesFilter(entry, filter));
					for (const entry of shown.slice(0, count).reverse())
						await print(entry);
				}
				await streamEvents(base, print);
				fail("The tunnel stopped.");
			} catch (err) {
				fail(
					`Cannot read the tunnel's inspector (${(err as Error).message}); is it still running?`,
				);
			}
		});
}
