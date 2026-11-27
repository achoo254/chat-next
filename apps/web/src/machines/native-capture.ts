// A screenshot from the Chat composer taken by tunelo-capture on the
// computer the user sits at (ADR 0031): the region is picked on the machine's
// own screens, with no browser picker, and the picture comes back over the
// machine's encrypted link into the composer's tray. Loaded on demand.
//
// Which machine is "this computer": the one this browser remembers; else,
// when exactly one machine of the account runs the browser's system, is
// online and has tunelo-capture, that one; several such machines are offered
// once and the pick is remembered. None: the browser's own capture.
import { CaptureOutcome } from "@achoo254/chat-proto/remote/remote";
import type { HubSlot } from "./link/connection-provider.tsx";
import type { LinkHub } from "./link/link-hub.ts";
import type { MachineLink } from "./link/machine-link.ts";
import { createHub } from "./use-machines.ts";

type Transport = Parameters<typeof createHub>[0];

const KEY = "chat.capture.machine";
/** "web": the user chose the browser's capture. */
const WEB = "web";
/** How long a machine may take to say whether it can capture. */
const PROBE_MS = 4_000;

export interface CaptureMachine {
	readonly ref: string;
	readonly name: string;
}

export type CaptureTarget = { readonly kind: "web" } | { readonly kind: "native"; readonly machine: CaptureMachine } | { readonly kind: "choose"; readonly machines: readonly CaptureMachine[] };

function remembered(): string | null {
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

/** Remembers the machine (or "web") screenshots go to from this browser. */
export function rememberCaptureMachine(ref: string | "web"): void {
	try {
		localStorage.setItem(KEY, ref);
	} catch {
		// Private mode: asked again next time.
	}
}

/** Whether this browser remembers a machine for screenshots (a shortcut then goes there at once). */
export function rememberedCaptureMachine(): string | null {
	const ref = remembered();
	return ref === null || ref === WEB ? null : ref;
}

/** The machine OS (process.platform) of this browser's computer; null on a phone or tablet. */
export function osOfBrowser(userAgent: string): string | null {
	if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return null;
	if (/Mac OS X|Macintosh/i.test(userAgent)) return "darwin";
	if (/Windows/i.test(userAgent)) return "win32";
	if (/Linux|X11|CrOS/i.test(userAgent)) return "linux";
	return null;
}

export function hubOf(slot: HubSlot, transport: Transport, localName: string): LinkHub {
	return slot.get(() => createHub(transport, localName));
}

/** The link to `ref`, open and with the machine's info, or null when it does not come in time. */
function ready(link: MachineLink, ms = PROBE_MS): Promise<MachineLink | null> {
	link.start();
	const ok = () => link.snapshot().status.kind === "open" && link.snapshot().info !== null;
	if (ok()) return Promise.resolve(link);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			stop();
			resolve(null);
		}, ms);
		const stop = link.subscribe(() => {
			if (!ok()) return;
			clearTimeout(timer);
			stop();
			resolve(link);
		});
	});
}

async function canCapture(hub: LinkHub, ref: string): Promise<boolean> {
	const link = await ready(hub.link(ref));
	return link?.snapshot().info?.capture?.available === true;
}

/** Where a screenshot from this browser goes now. */
export async function resolveCaptureTarget(hub: LinkHub, userAgent = navigator.userAgent): Promise<CaptureTarget> {
	const pick = remembered();
	if (pick === WEB) return { kind: "web" };
	const os = osOfBrowser(userAgent);
	if (os === null) return { kind: "web" };
	const machines = await hub.refresh().catch(() => hub.directory().machines);
	if (pick !== null) {
		const chosen = machines.find((m) => m.ref === pick);
		if (chosen !== undefined && chosen.tunnelUrl !== "" && (await canCapture(hub, chosen.ref))) return { kind: "native", machine: { ref: chosen.ref, name: chosen.name } };
	}
	const online = machines.filter((m) => m.os === os && m.tunnelUrl !== "");
	const able: CaptureMachine[] = [];
	for (const m of online) if (await canCapture(hub, m.ref)) able.push({ ref: m.ref, name: m.name });
	if (able.length === 0) return { kind: "web" };
	const [only] = able;
	if (able.length === 1 && only !== undefined) return { kind: "native", machine: only };
	return { kind: "choose", machines: able };
}

function newRequestId(): string {
	return `cap-${crypto.randomUUID()}`;
}

/**
 * Opens tunelo-capture's overlay on `ref` and waits for the user: the
 * picture as a file for the tray, or null when they closed the overlay.
 * Rejects when the machine cannot open it.
 */
export async function captureOn(hub: LinkHub, ref: string): Promise<File | null> {
	const link = await ready(hub.link(ref));
	if (link === null) throw new Error("the machine is not reachable");
	const release = hub.hold(ref);
	const requestId = newRequestId();
	try {
		return await new Promise<File | null>((resolve, reject) => {
			const parts: Uint8Array[] = [];
			let meta = { name: "screenshot.png", mime: "image/png", size: 0 };
			let received = 0;
			const stop = link.onFrame((body) => {
				if (body.case !== "captureResult" || body.value.requestId !== requestId) return;
				const r = body.value;
				if (r.outcome === CaptureOutcome.CANCELLED) {
					stop();
					return resolve(null);
				}
				if (r.outcome !== CaptureOutcome.CAPTURED) {
					stop();
					return reject(new Error(r.message || "the screenshot failed"));
				}
				if (r.offset === 0n) meta = { name: r.name || meta.name, mime: r.mimeType || meta.mime, size: Number(r.size) };
				if (Number(r.offset) !== received) {
					stop();
					return reject(new Error("a piece of the picture was lost"));
				}
				parts.push(r.data);
				received += r.data.length;
				if (r.last) {
					stop();
					resolve(new File(parts as BlobPart[], meta.name, { type: meta.mime }));
				}
			});
			link.request({ case: "captureRequest", value: { requestId } }).then(
				(frame) => {
					if (frame.body.case === "error") {
						stop();
						reject(new Error(frame.body.value.message || "the machine refused"));
					}
				},
				(err: unknown) => {
					stop();
					reject(err instanceof Error ? err : new Error(String(err)));
				},
			);
		});
	} finally {
		release();
	}
}
