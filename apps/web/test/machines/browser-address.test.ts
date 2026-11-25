// What the browser tab's address bar does with what is typed.
import { describe, expect, it } from "vitest";
import { addressToUrl, SEARCH_URL } from "../../src/machines/browser/address.ts";

describe("addressToUrl", () => {
	it("keeps an address that has its scheme", () => {
		expect(addressToUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
		expect(addressToUrl("  http://example.com  ")).toBe("http://example.com");
	});

	it("puts https before a bare site name, with a path or a port", () => {
		expect(addressToUrl("example.com")).toBe("https://example.com");
		expect(addressToUrl("docs.example.com/guide#top")).toBe("https://docs.example.com/guide#top");
		expect(addressToUrl("example.com:8443/x")).toBe("https://example.com:8443/x");
	});

	it("uses http for the machine itself", () => {
		expect(addressToUrl("localhost:3000")).toBe("http://localhost:3000");
		expect(addressToUrl("192.168.1.10/admin")).toBe("http://192.168.1.10/admin");
	});

	it("searches for words, and for one word that is no address", () => {
		expect(addressToUrl("giá vàng hôm nay")).toBe(`${SEARCH_URL}${encodeURIComponent("giá vàng hôm nay")}`);
		expect(addressToUrl("vitest")).toBe(`${SEARCH_URL}vitest`);
	});

	it("does not take a scheme without slashes for an address", () => {
		expect(addressToUrl("javascript:alert(1)")).toBe(`${SEARCH_URL}${encodeURIComponent("javascript:alert(1)")}`);
	});

	it("does nothing for an empty bar", () => {
		expect(addressToUrl("   ")).toBeNull();
	});
});
