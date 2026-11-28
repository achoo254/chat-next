import { describe, expect, it } from "vitest";
import { downloadName } from "../src/messaging/media/download.ts";

describe("downloadName", () => {
	it("keeps the name the sender gave", () => {
		expect(downloadName({ fileName: "hop-dong.pdf", kind: "document", mimeType: "application/pdf" }, 7, 3)).toBe("hop-dong.pdf");
	});

	it("names an unnamed photo after its chat and message", () => {
		expect(downloadName({ fileName: "", kind: "photo", mimeType: "image/jpeg" }, 7, 3)).toBe("anh-7-3.jpg");
	});

	it("does not give every photo copied from Zalo the same name", () => {
		const a = downloadName({ fileName: "photo.jpg", kind: "photo", mimeType: "image/jpeg" }, 7, 3);
		const b = downloadName({ fileName: "photo.jpg", kind: "photo", mimeType: "image/jpeg" }, 9, 3);
		expect(a).toBe("anh-7-3.jpg");
		expect(b).toBe("anh-9-3.jpg");
	});
});
