import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { errorCode } from "../src/api/client.ts";
import { fetchSelf, parseGetSelf, RpcError } from "../src/api/get-self.ts";

const reply = (status: number, body: string, contentType = "application/json"): typeof globalThis.fetch =>
	async () => new Response(body, { status, headers: { "Content-Type": contentType } });

describe("GetSelf over JSON", () => {
	it("reads the proto3 JSON of GetSelfResponse", () => {
		expect(parseGetSelf({ user: { id: "42", name: "Đức Thắng", username: "thang_dt", bio: "", email: "t@example.com" }, isOperator: true })).toEqual({
			id: 42,
			name: "Đức Thắng",
			username: "thang_dt",
			bio: "",
			email: "t@example.com",
			isOperator: true,
		});
		// Default values are omitted on the wire.
		expect(parseGetSelf({ user: { id: "7" } })).toEqual({ id: 7, name: "", username: "", bio: "", email: "", isOperator: false });
	});

	it("refuses a response of the wrong shape", () => {
		for (const body of [null, {}, { user: [] }, { user: { id: "x" } }, { user: { id: "9007199254740993" } }, { user: { id: "1", name: 3 } }, { user: { id: "1" }, isOperator: "yes" }]) {
			expect(() => parseGetSelf(body), JSON.stringify(body)).toThrow();
		}
	});

	it("sends a Connect JSON request and maps errors to their codes", async () => {
		const requests: { url: string; init: RequestInit | undefined }[] = [];
		const ok: typeof globalThis.fetch = async (input, init) => {
			requests.push({ url: String(input), init });
			return new Response(JSON.stringify({ user: { id: "5", name: "Lan Anh" } }), { status: 200 });
		};
		expect(await fetchSelf(ok)).toMatchObject({ id: 5, name: "Lan Anh" });
		expect(requests).toEqual([
			{
				url: "/rpc/app.v1.UsersService/GetSelf",
				init: { method: "POST", headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" }, body: "{}" },
			},
		]);

		const signedOut = await fetchSelf(reply(401, '{"code":"unauthenticated","message":"no session"}')).catch((err: unknown) => err);
		expect(signedOut).toBeInstanceOf(RpcError);
		expect(errorCode(signedOut)).toBe(Code.Unauthenticated);
		expect((signedOut as Error).message).toBe("no session");
		// A proxy error page: the HTTP status decides.
		expect(errorCode(await fetchSelf(reply(502, "<html>Bad gateway</html>", "text/html")).catch((err: unknown) => err))).toBe(Code.Unavailable);
		expect(errorCode(await fetchSelf(reply(401, "")).catch((err: unknown) => err))).toBe(Code.Unauthenticated);
		const offline: typeof globalThis.fetch = async () => {
			throw new TypeError("Failed to fetch");
		};
		expect(errorCode(await fetchSelf(offline).catch((err: unknown) => err))).toBe(Code.Unknown);
	});

	it("reads the code of Connect errors without loading ConnectError at startup", () => {
		expect(errorCode(new ConnectError("gone", Code.NotFound))).toBe(Code.NotFound);
		expect(errorCode(new RpcError(Code.PermissionDenied, "x"))).toBe(Code.PermissionDenied);
		expect(errorCode(Object.assign(new Error("odd"), { code: 99 }))).toBe(Code.Unknown);
		expect(errorCode("text")).toBe(Code.Unknown);
	});
});
