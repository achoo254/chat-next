// The page observatory.e2e.ts opens: the real Live Map view (LiveMapView,
// with its PixiJS stage, drawer, detail and replay bar, on the app's styles
// and the AI-drawn plate of public/observatory/) watching one session of a
// fake machine. The machine is a link answering Observatory's requests in the
// page: the watch with a snapshot of a session that began 90 s ago, a
// station's numbers, an event's content, no older events. The test reads the
// requests asked and makes the machine send a live event through
// window.__observeHarness.
import { create } from "@bufbuild/protobuf";
import {
	FrameSchema,
	MachineInfoSchema,
	ObservatoryContentResultSchema,
	ObservatoryContentState,
	ObservatoryCoreState,
	ObservatoryEarlierResultSchema,
	ObservatoryEventSchema,
	ObservatoryEventsSchema,
	ObservatorySessionSource,
	ObservatorySnapshotSchema,
	ObservatoryStationResultSchema,
	type Frame,
	type ObservatoryEvent,
} from "@achoo254/chat-proto/remote/remote";
import { createRoot } from "react-dom/client";
import "../../src/styles/fonts.css";
import "@achoo254/app-shell/tokens.css";
import "../../src/styles/app.css";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import type { LinkState } from "../../src/machines/link/machine-link.ts";
import LiveMapView from "../../src/machines/observatory/live-map-view.tsx";
import type { ObservatoryLink } from "../../src/machines/observatory/observatory-client.ts";
import type { LiveMapHandle } from "../../src/machines/observatory/render/live-map-app.ts";

interface ObserveHarness {
	/** What the view asked of the machine, oldest first: `case` and the request's key (`observatoryContent tool:t1`). */
	requests(): string[];
	/** The machine sends one live event: a file written at the files station, now. */
	push(): void;
}

declare global {
	interface Window {
		__observeHarness?: ObserveHarness;
		/** The renderer, exposed by the stage while localStorage "observe.animationLog" is "1". */
		__liveMap?: Pick<LiveMapHandle, "frames" | "animationLog">;
	}
}

type Body = Frame["body"];
/** A request as the view sends it (its fields may be left out). */
type Request = Parameters<ObservatoryLink["request"]>[0];

const SESSION = "s1";
/** Within the 90 days a replay keeps, so the bar plays. */
const START = Date.now() - 90_000;
/** A Unix-ms moment of the session as the wire carries it. */
const at = (ms: number): bigint => BigInt(START + ms);

const toolCall = (id: string, ms: number, station: string, toolName: string, target: string, durationMs: number): ObservatoryEvent =>
	create(ObservatoryEventSchema, { at: at(ms), id: `tool:${id}`, kind: { case: "toolCall", value: { toolUseId: id, station, toolName, target, success: true, durationMs } } });

const EVENTS: ObservatoryEvent[] = [
	create(ObservatoryEventSchema, { seq: 1n, at: at(1_000), id: "prompt:p1", kind: { case: "prompt", value: { promptId: "p1" } } }),
	{ ...toolCall("t1", 5_000, "FILES", "Read", "src/app.ts", 40), seq: 2n },
	{ ...toolCall("t2", 20_000, "FILES", "Edit", "src/view.tsx", 120), seq: 3n },
	{ ...toolCall("t3", 40_000, "TESTING", "Bash", "pnpm test", 8_000), seq: 4n },
	create(ObservatoryEventSchema, { seq: 5n, at: at(50_000), id: "api:a1", kind: { case: "apiRequest", value: { model: "claude-opus", outputTokens: 900n, durationMs: 3_000 } } }),
];

const snapshot = (): Body => ({
	case: "observatorySnapshot",
	value: create(ObservatorySnapshotSchema, {
		sessionId: SESSION,
		epoch: 1n,
		seq: BigInt(EVENTS.length),
		session: {
			info: { sessionId: SESSION, projectKey: "github.com/acme/app", cwd: "~/app", source: ObservatorySessionSource.CLI, startedAt: BigInt(START), mainModel: "claude-opus" },
			live: { core: ObservatoryCoreState.IDLE, contextPercent: 40, contextTokens: 80_000n, contextWindow: 200_000n, mainModel: "claude-opus" },
		},
		events: EVENTS,
		earlier: "",
	}),
});

/** A station's numbers as the machine counts them: the files station's three calls, the others none. */
function stationResult(station: string, upTo: bigint): Body {
	const files = station === "FILES";
	return {
		case: "observatoryStationResult",
		value: create(ObservatoryStationResultSchema, {
			sessionId: SESSION,
			station,
			at: upTo,
			numbers: files ? { calls: 3, failures: 0, ended: 3, p50Ms: 40, p95Ms: 120 } : {},
			parts: files ? [{ kind: "file", key: "src/app.ts", numbers: { calls: 2, ended: 2, p95Ms: 40 } }] : [],
			recent: files ? EVENTS.filter((e) => e.kind.case === "toolCall" && e.kind.value.station === "FILES") : [],
		}),
	};
}

const frameListeners = new Set<(body: Body) => void>();
const asked: string[] = [];
let seq = EVENTS.length;

function keyOf(body: Request): string {
	switch (body.case) {
		case "observatoryWatch":
			return body.value.on === true ? "on" : "off";
		case "observatoryStation":
			return `${body.value.station ?? ""}@${body.value.at ?? 0n}`;
		case "observatoryContent":
			return body.value.eventId ?? "";
		default:
			return "";
	}
}

/** The machine's answer to a request (undefined: a request this machine does not serve). */
function answer(body: Request): Body | undefined {
	switch (body.case) {
		case "observatoryWatch":
			return body.value.on === true ? snapshot() : { case: undefined };
		case "observatoryStation":
			return stationResult(body.value.station ?? "", body.value.at ?? 0n);
		case "observatoryContent":
			return {
				case: "observatoryContentResult",
				value: create(ObservatoryContentResultSchema, { sessionId: SESSION, eventId: body.value.eventId ?? "", state: ObservatoryContentState.STORED, text: `content of ${body.value.eventId ?? ""}` }),
			};
		case "observatoryEarlier":
			return { case: "observatoryEarlierResult", value: create(ObservatoryEarlierResultSchema, { sessionId: SESSION, events: [], earlier: "" }) };
		default:
			return undefined;
	}
}

const link: ObservatoryLink = {
	request(body) {
		asked.push(`${String(body.case)} ${keyOf(body)}`.trim());
		const reply = answer(body);
		if (reply === undefined) return Promise.reject(new Error(`the fake machine does not serve ${String(body.case)}`));
		// A snapshot reaches the watch as a frame (the machine also answers the request with it).
		if (reply.case === "observatorySnapshot") queueMicrotask(() => frameListeners.forEach((listener) => listener(reply)));
		return Promise.resolve(create(FrameSchema, { id: "fake", body: reply }));
	},
	onFrame(listener) {
		frameListeners.add(listener);
		return () => frameListeners.delete(listener);
	},
	// Always connected: nothing to tell.
	subscribe: () => () => undefined,
	// Observatory reads only the link's status; the rest of a machine's state (threads, journals) is not this view's.
	snapshot: () => ({ status: { kind: "open" } }) as LinkState,
};

window.__observeHarness = {
	requests: () => [...asked],
	push() {
		seq += 1;
		const event = { ...toolCall(`t${seq}`, Date.now() - START, "FILES", "Write", "src/new-file.ts", 30), seq: BigInt(seq) };
		const body: Body = { case: "observatoryEvents", value: create(ObservatoryEventsSchema, { sessionId: SESSION, epoch: 1n, events: [event] }) };
		frameListeners.forEach((listener) => listener(body));
	},
};

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");
createRoot(root).render(
	<I18nProvider>
		<main style={{ padding: "var(--space-3)" }}>
			<LiveMapView link={link} machine="1" info={create(MachineInfoSchema, { agentVersion: "3.26.0" })} online target={{ kind: "session", sessionId: SESSION }} />
		</main>
	</I18nProvider>,
);
