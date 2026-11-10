// A consent log line says how a device was paired, in every language, and
// never shows a "pair" entry's detail as raw text.
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
	it("says whether the device paired with the Authenticator code or the install command", () => {
		expect(line("pair", "totp")).toBe("Pixel ghép thiết bị bằng mã Authenticator");
		expect(line("pair", "install")).toBe("Pixel ghép thiết bị bằng lệnh cài trên máy");
		expect(line("pair", "totp", enMachines.detail)).toBe("Pixel paired a device with the Authenticator code");
		expect(line("pair", "install", enMachines.detail)).toBe("Pixel paired a device with the install command on the machine");
		expect(line("pair", "totp", zhCNMachines.detail)).toBe("Pixel 配对了设备（通过身份验证器验证码）");
		expect(line("pair", "install", zhCNMachines.detail)).toBe("Pixel 配对了设备（通过电脑上的安装命令）");
	});

	it("shows no unknown pairing detail, and keeps the other actions as they were", () => {
		expect(line("pair", "something-else")).toBe("Pixel ghép thiết bị");
		expect(line("revoke", "abcdefabcdef")).toBe("Pixel thu hồi thiết bị");
		expect(line("approve_sensitive", "Bash", viMachines.detail, "/etc")).toBe("Pixel cho phép /etc · Bash");
		expect(line("totp_set", "replaced")).toBe("Pixel thiết lập ghép bằng Authenticator");
	});
});
