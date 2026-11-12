// A consent log line names the device the account added or revoked, in
// every language, and keeps the other actions as they were.
import { render } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { AuditEntrySchema } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { AuditEntryText } from "../../src/machines/audit-entry-text.tsx";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";

const line = (action: string, detail: string, copy = viMachines.detail, path = "") =>
	render(<AuditEntryText entry={create(AuditEntrySchema, { at: 1n, device: "Pixel", action, path, detail })} copy={copy} />).container.textContent;

describe("a consent log line", () => {
	it("says which device the account added or revoked", () => {
		expect(line("device_added", "")).toBe("Pixel được thêm vào tài khoản");
		expect(line("revoke", "abcdefabcdef")).toBe("Pixel bị thu hồi khỏi tài khoản");
		expect(line("device_added", "", enMachines.detail)).toBe("Pixel was added to the account");
		expect(line("revoke", "", enMachines.detail)).toBe("Pixel was revoked from the account");
		expect(line("device_added", "", zhCNMachines.detail)).toBe("Pixel 已添加到账号");
		expect(line("revoke", "", zhCNMachines.detail)).toBe("Pixel 已从账号中撤销");
	});

	it("keeps the other actions as they were, and an unknown one by its name", () => {
		expect(line("approve_sensitive", "Bash", viMachines.detail, "/etc")).toBe("Pixel cho phép /etc · Bash");
		expect(line("some_new_action", "detail")).toBe("Pixel some_new_action");
	});
});
