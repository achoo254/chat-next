// "Ghép thiết bị này": pairing this device with a machine it has never
// talked to (being signed in to the same account is not enough). Scan the QR
// that `tunelo pair` shows (where the browser can read QR codes), or type
// its 6 digits. On success the machine key is pinned and the link opens.
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { HandshakeErrorCode } from "@achoo254/chat-proto/remote/remote";
import { HandshakeFailure, PakeFailure, decodeQr } from "@achoo254/chat-remote-protocol";
import { Icon } from "../components/screen-icons.tsx";
import { CopyButton } from "../messaging/ui/parts.tsx";
import { navigate, paths } from "../router.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import { confirmTrust, pairWithCode } from "./link/pairing.ts";
import type { LinkHub } from "./link/link-hub.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { PageHead } from "./page-head.tsx";
import { useEntry, useHub } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

/** The error to show for a failed pairing. */
export function pairError(t: MachinesCopy, err: unknown): string {
	if (err instanceof PakeFailure) return t.pair.wrong;
	if (err instanceof HandshakeFailure) {
		if (err.code === HandshakeErrorCode.PAIRING_EXPIRED) return t.pair.expired;
		if (err.code === HandshakeErrorCode.TOO_MANY_ATTEMPTS) return t.pair.tooMany;
		if (err.code === HandshakeErrorCode.BAD_PROOF) return t.pair.wrong;
		return t.errors.generic;
	}
	return t.pair.unreachable;
}

/** Pairs with the machine at `url` by code, pins its key under `ref`. */
export async function pairByCode(hub: LinkHub, ref: string, url: string, code: string): Promise<void> {
	const device = await hub.deps.keys.device();
	const machineKey = await pairWithCode({ url, device, deviceName: hub.deps.deviceName, socket: hub.deps.socket }, code);
	await hub.pinned(ref, machineKey);
}

export function PairDevice({ machine }: { machine: string }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const entry = useEntry(hub, machine);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [scanning, setScanning] = useState(false);
	const name = entry?.name ?? "";
	const url = entry?.tunnelUrl ?? "";

	const finish = (run: () => Promise<void>) => {
		setBusy(true);
		setError("");
		run().then(
			() => navigate(paths.machine(machine)),
			(err: unknown) => {
				setBusy(false);
				setError(pairError(t, err));
			},
		);
	};
	const onQr = (text: string) => {
		let parsed: ReturnType<typeof decodeQr>;
		try {
			parsed = decodeQr(text);
		} catch {
			setError(t.pair.badQr);
			return;
		}
		setScanning(false);
		finish(async () => {
			const device = await hub.deps.keys.device();
			const machineKey = await confirmTrust({ url, device, deviceName: hub.deps.deviceName, socket: hub.deps.socket }, { kind: "qr", ...parsed });
			await hub.pinned(machine, machineKey);
		});
	};
	const canScan = typeof window !== "undefined" && "BarcodeDetector" in window && typeof navigator.mediaDevices?.getUserMedia === "function";

	return (
		<div className="mx-scroll">
			<PageHead back={paths.machine(machine)} title={t.pair.title} subtitle={name} />
			<div className="mx-body">
				<div className="card pad mx-card narrow">
					<h3>
						<MachineIcon name="qr" />
						{t.pair.heading(name)}
					</h3>
					<ol className="mx-steps">
						<li>
							<p>{t.agent.pairing.step1(name)}</p>
							<div className="mx-cmd">
								<code>tunelo pair</code>
								<CopyButton text="tunelo pair" label={t.addMachine.copy} copiedLabel={t.addMachine.copied} small />
							</div>
						</li>
						<li>
							<p>{t.agent.pairing.step2}</p>
							{canScan &&
								(scanning ? (
									<QrScanner onText={onQr} onFail={() => setError(t.pair.cameraFailed)} onStop={() => setScanning(false)} />
								) : (
									<button type="button" className="btn" disabled={busy || url === ""} onClick={() => setScanning(true)}>
										<MachineIcon name="qr" small />
										{t.pair.scan}
									</button>
								))}
							<CodeInput disabled={busy || url === ""} onCode={(code) => finish(() => pairByCode(hub, machine, url, code))} />
						</li>
					</ol>
					{busy && (
						<div className="mx-wait">
							<span className="spin" aria-hidden="true" />
							{t.pair.pairing}
						</div>
					)}
					{error !== "" && (
						<p className="mx-error" role="alert">
							{error}
						</p>
					)}
					<p className="note">{t.agent.pairing.sameMachine(name)}</p>
					<div className="mx-hint">
						<Icon name="lock" small />
						<span>{t.pair.note}</span>
					</div>
				</div>
			</div>
		</div>
	);
}

/** Six one-digit boxes; typing moves on, pasting fills them all; the sixth digit submits. */
export function CodeInput({ disabled, onCode }: { disabled: boolean; onCode: (code: string) => void }) {
	const t = useMachinesCopy();
	const [digits, setDigits] = useState<string[]>(() => Array.from({ length: 6 }, () => ""));
	const boxes = useRef<(HTMLInputElement | null)[]>([]);
	const put = (from: number, text: string) => {
		const clean = text.replace(/\D/g, "");
		if (clean === "") return;
		const next = [...digits];
		for (let i = 0; i < clean.length && from + i < 6; i++) next[from + i] = clean[i] ?? "";
		setDigits(next);
		const after = Math.min(from + clean.length, 5);
		boxes.current[after]?.focus();
		if (next.every((d) => d !== "")) onCode(next.join(""));
	};
	return (
		<div className="mx-otp" role="group" aria-label={t.local.code}>
			{digits.map((digit, i) => (
				<input
					key={i}
					ref={(el) => {
						boxes.current[i] = el;
					}}
					className="input"
					inputMode="numeric"
					autoComplete={i === 0 ? "one-time-code" : "off"}
					aria-label={t.pair.digit(i + 1)}
					value={digit}
					disabled={disabled}
					onChange={(event) => {
						const value = event.target.value;
						if (value === "") {
							setDigits((all) => all.map((d, j) => (j === i ? "" : d)));
							return;
						}
						put(i, value.slice(digit === "" ? 0 : 1) || value);
					}}
					onKeyDown={(event) => {
						if (event.key === "Backspace" && digit === "" && i > 0) boxes.current[i - 1]?.focus();
					}}
					onPaste={(event) => {
						event.preventDefault();
						put(i, event.clipboardData.getData("text"));
					}}
				/>
			))}
		</div>
	);
}

interface BarcodeDetectorLike {
	detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

/** The camera with the browser's QR reader (BarcodeDetector). */
function QrScanner({ onText, onFail, onStop }: { onText: (text: string) => void; onFail: () => void; onStop: () => void }) {
	const t = useMachinesCopy();
	const video = useRef<HTMLVideoElement>(null);
	const found = useEffectEvent((text: string) => onText(text));
	const failed = useEffectEvent(() => onFail());
	useEffect(() => {
		let stream: MediaStream | null = null;
		let timer = 0;
		let active = true;
		const Detector = (window as unknown as { BarcodeDetector: new (options: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector;
		const detector = new Detector({ formats: ["qr_code"] });
		navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then(
			async (media) => {
				if (!active) {
					for (const track of media.getTracks()) track.stop();
					return;
				}
				stream = media;
				const el = video.current;
				if (el === null) return;
				el.srcObject = media;
				await el.play().catch(() => undefined);
				timer = window.setInterval(() => {
					detector.detect(el).then(
						(codes) => {
							const text = codes[0]?.rawValue;
							if (text !== undefined && active) found(text);
						},
						() => undefined,
					);
				}, 300);
			},
			() => {
				if (active) failed();
			},
		);
		return () => {
			active = false;
			window.clearInterval(timer);
			if (stream !== null) for (const track of stream.getTracks()) track.stop();
		};
	}, []);
	return (
		<div className="mx-scan">
			<video ref={video} muted playsInline aria-label={t.pair.scanning} />
			<button type="button" className="btn btn-sm" onClick={onStop}>
				{t.pair.stopScan}
			</button>
		</div>
	);
}
