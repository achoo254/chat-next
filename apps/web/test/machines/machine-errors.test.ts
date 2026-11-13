// Machine errors in the account's language: by reason (tunelo 2.0.1 and
// later), else by error class, else the machine's own words.
import { ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";
import { OfflineError, RemoteError } from "../../src/machines/link/machine-link.ts";
import { machineErrorText, needsProjectTrust } from "../../src/machines/machine-errors.ts";

const refused = (reason: ErrorReason, subject = "", code = ErrorCode.INVALID) => new RemoteError(code, "english from the machine", reason, subject);

describe("machine errors", () => {
	it("words every known reason in each language, never the machine's English", () => {
		const reasons = Object.values(ErrorReason).filter((r): r is ErrorReason => typeof r === "number" && r !== ErrorReason.UNSPECIFIED);
		expect(reasons.length).toBeGreaterThan(20);
		for (const copy of [viMachines, enMachines, zhCNMachines]) {
			for (const reason of reasons) {
				const text = machineErrorText(copy, refused(reason, "/w/x"), "Claude");
				expect(text, `reason ${reason}`).not.toContain("english from the machine");
				expect(text.length).toBeGreaterThan(3);
			}
		}
	});

	it("puts the subject where the reason names it", () => {
		expect(machineErrorText(viMachines, refused(ErrorReason.TRUST_ON_MACHINE, "/Users/me"), "Claude")).toContain('tunelo trust "/Users/me"');
		// No account command exists on the machine: none is named.
		expect(machineErrorText(enMachines, refused(ErrorReason.ACCOUNT_SIGN_OUT_FAILED, "p1"), "Claude")).toBe("Claude could not sign this account out, so nothing was deleted. Try again later.");
		expect(machineErrorText(zhCNMachines, refused(ErrorReason.AI_NOT_INSTALLED, "Codex"), "Claude")).toContain("Codex");
		expect(machineErrorText(viMachines, refused(ErrorReason.AI_START_FAILED, "boom"), "Claude")).toBe("Claude không khởi động được trên máy: boom");
	});

	it("falls back to the error class, then to the machine's words, for older machines and unknown reasons", () => {
		expect(machineErrorText(viMachines, refused(ErrorReason.UNSPECIFIED, "", ErrorCode.STALE), "Claude")).toBe(viMachines.errors.stale);
		expect(machineErrorText(viMachines, refused(ErrorReason.UNSPECIFIED), "Claude")).toBe("Không làm được: english from the machine");
		expect(machineErrorText(enMachines, refused(999 as ErrorReason), "Claude")).toBe("Could not do that: english from the machine");
		expect(machineErrorText(enMachines, refused(999 as ErrorReason, "", ErrorCode.INTERNAL), "Claude")).toBe(enMachines.errors.generic);
		expect(machineErrorText(enMachines, new OfflineError(), "Claude")).toBe(enMachines.errors.offline);
		expect(machineErrorText(enMachines, new Error("x"), "Claude")).toBe(enMachines.errors.generic);
	});

	it("tells when trusting the folder from this device may help", () => {
		expect(needsProjectTrust(refused(ErrorReason.PROJECT_SETTINGS_UNTRUSTED, "/w"))).toBe(true);
		expect(needsProjectTrust(refused(ErrorReason.TRUST_ON_MACHINE, "/w"))).toBe(false);
		expect(needsProjectTrust(new Error("x"))).toBe(false);
	});
});
