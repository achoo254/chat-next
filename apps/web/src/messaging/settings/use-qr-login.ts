// Drives a QR login (Zalo): starts it, then keeps one long poll open at a time
// while the code is on screen (the server stops a login nobody polls for about
// 45 s, and answers each poll within about 20 s). Cancel, unmount and a new
// start abort the call in flight, which also ends the login on the server.
// The QR image lives only in this hook's state: never stored, logged or put
// in a URL, and cleared when the login ends.
import { useEffect, useRef, useState } from "react";
import type { BridgeApi, BridgeError, LoginStep } from "./bridge-api.ts";
import { LOGIN_RETRY_GAP_MS, statusOfError, viewOfStep, type QrLoginStatus } from "./qr-login-model.ts";

/** The first call answers within about 3 s; give a stuck one up well after. */
const START_TIMEOUT_MS = 20_000;
/** A poll waits at most about 20 s on the server. */
const POLL_TIMEOUT_MS = 35_000;
/** A poll that came back at once with nothing new waits this long before the next (guards against a hot loop). */
const QUIET_POLL_GAP_MS = 1_000;

export interface QrLoginState {
	/** `idle`: nothing started, or the login was cancelled. */
	readonly status: QrLoginStatus | "idle";
	/** The QR image (a checked PNG data: URL), or "". */
	readonly image: string;
	/** With `limited`: seconds until another attempt may be made, counting down to 0. */
	readonly wait: number;
}

export interface QrLogin extends QrLoginState {
	/** Starts a new login; ignored while one runs (a double click starts one). */
	start(): void;
	/** After a network error: polls the same login again. */
	resume(): void;
	/** Stops polling, aborts the call in flight and forgets the image. */
	stop(): void;
}

const IDLE: QrLoginState = { status: "idle", image: "", wait: 0 };

/** Resolves after `ms`, or at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}

export function useQrLogin(
	api: BridgeApi,
	source: string,
	onDone: () => void,
	onError: (err: unknown) => BridgeError,
): QrLogin {
	const [state, setState] = useState<QrLoginState>(IDLE);
	const running = useRef<AbortController | null>(null);
	const loginId = useRef("");
	const shown = useRef(false);
	const countdown = useRef<ReturnType<typeof setInterval> | null>(null);

	const stopCountdown = () => {
		if (countdown.current !== null) clearInterval(countdown.current);
		countdown.current = null;
	};
	/** Counts the wait after a refused start down to 0, once a second. */
	const startCountdown = () => {
		stopCountdown();
		let wait = Math.ceil(LOGIN_RETRY_GAP_MS / 1000);
		setState({ status: "limited", image: "", wait });
		countdown.current = setInterval(() => {
			wait -= 1;
			setState((current) => (current.status === "limited" ? { ...current, wait } : current));
			if (wait <= 0) stopCountdown();
		}, 1000);
	};

	useEffect(
		() => () => {
			running.current?.abort();
			running.current = null;
			stopCountdown();
		},
		[],
	);

	const poll = async (controller: AbortController, first: () => Promise<LoginStep>): Promise<void> => {
		const { signal } = controller;
		let call = first;
		let last = "";
		while (!signal.aborted) {
			const sentAt = Date.now();
			let step: LoginStep;
			try {
				step = await call();
			} catch (err) {
				if (signal.aborted) return;
				running.current = null;
				const status = statusOfError(onError(err));
				if (status === "limited") startCountdown();
				else setState({ status, image: "", wait: 0 });
				return;
			}
			if (signal.aborted) return;
			if (step.kind === "done") {
				running.current = null;
				loginId.current = "";
				setState(IDLE);
				onDone();
				return;
			}
			const view = viewOfStep(step, shown.current);
			if (view.status === "scan") shown.current = true;
			setState({ ...view, wait: 0 });
			if (view.status === "failed") {
				running.current = null;
				return;
			}
			const id = step.loginId;
			loginId.current = id;
			const key = `${view.status}:${view.image}`;
			if (key === last && Date.now() - sentAt < QUIET_POLL_GAP_MS) await pause(QUIET_POLL_GAP_MS, signal);
			last = key;
			call = () => api.continueLogin(id, {}, { signal, timeoutMs: POLL_TIMEOUT_MS });
		}
	};

	const launch = (first: (signal: AbortSignal) => Promise<LoginStep>) => {
		if (running.current !== null) return;
		const controller = new AbortController();
		running.current = controller;
		void poll(controller, () => first(controller.signal));
	};

	return {
		...state,
		start: () => {
			if (running.current !== null) return;
			stopCountdown();
			loginId.current = "";
			shown.current = false;
			setState({ status: "preparing", image: "", wait: 0 });
			launch((signal) => api.startLogin(source, { signal, timeoutMs: START_TIMEOUT_MS }));
		},
		resume: () => {
			const id = loginId.current;
			if (id === "" || running.current !== null) return;
			setState({ status: shown.current ? "refreshing" : "preparing", image: "", wait: 0 });
			launch((signal) => api.continueLogin(id, {}, { signal, timeoutMs: POLL_TIMEOUT_MS }));
		},
		stop: () => {
			running.current?.abort();
			running.current = null;
			stopCountdown();
			loginId.current = "";
			setState(IDLE);
		},
	};
}
