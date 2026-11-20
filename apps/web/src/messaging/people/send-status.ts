// The feedback of the merged screen's sends, one line per chat (ADR 0025):
// a chat that took nothing and why, a send that failed with its retry, a
// message that waits for the account of the other app. A later send that
// went through clears that chat's line. A send that was queued and refused
// later is shown by its own pending bubble in the timeline, with the
// outbox's retry, so it has no line here.
import type { SendReport } from "./fan-out-source.ts";
import type { TargetReason } from "./send-targets.ts";

export type SendLine =
	| { readonly kind: "skipped"; readonly chatId: number; readonly reason: TargetReason }
	| { readonly kind: "failed"; readonly chatId: number; readonly retry: () => Promise<void> }
	| { readonly kind: "waiting"; readonly chatId: number; readonly reason: TargetReason };

export class SendStatus {
	private lines: readonly SendLine[] = [];
	private readonly listeners = new Set<() => void>();

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly current = (): readonly SendLine[] => this.lines;

	/**
	 * Takes the outcome of a send. `pending` is why a chat that took the
	 * message may hold it (its account), told as a waiting line.
	 */
	note(report: SendReport, pending: TargetReason | undefined): void {
		if (report.kind === "sent") {
			this.put(report.chatId, pending === undefined ? null : { kind: "waiting", chatId: report.chatId, reason: pending });
		} else {
			this.put(report.chatId, report);
		}
	}

	dismiss(chatId: number): void {
		this.put(chatId, null);
	}

	private put(chatId: number, line: SendLine | null): void {
		const rest = this.lines.filter((existing) => existing.chatId !== chatId);
		if (line === null && rest.length === this.lines.length) return;
		this.lines = line === null ? rest : [...rest, line];
		for (const listener of [...this.listeners]) listener();
	}
}
