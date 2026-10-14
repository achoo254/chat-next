import { create } from "@bufbuild/protobuf";
import { ClientPlatform, SessionSchema } from "@app/proto-ts/auth";
import { UserSchema } from "@app/proto-ts/users";
import { describe, expect, it } from "vitest";
import { toSelfUser, toSessionView } from "../src/api/adapters.ts";

describe("protocol adapters", () => {
	it("maps a user's bigint id to a number", () => {
		const user = create(UserSchema, { id: 2n ** 53n - 1n, name: "An", username: "an_1", email: "an@example.com" });
		expect(toSelfUser(user)).toEqual({
			id: Number.MAX_SAFE_INTEGER,
			name: "An",
			username: "an_1",
			bio: "",
			email: "an@example.com",
		});
	});

	it("rejects a user id at or above 2^53", () => {
		expect(() => toSelfUser(create(UserSchema, { id: 2n ** 53n }))).toThrow(RangeError);
		expect(() => toSelfUser(create(UserSchema, { id: 2n ** 60n }))).toThrow(RangeError);
	});

	it("maps a session and rejects unsafe session ids and timestamps", () => {
		const session = create(SessionSchema, {
			id: 7n,
			platform: ClientPlatform.IOS,
			deviceName: "iPhone 15",
			createdAt: 1_760_000_000n,
			lastActiveAt: 1_760_000_500n,
			current: true,
		});
		expect(toSessionView(session)).toMatchObject({
			id: 7,
			platform: "ios",
			createdAt: 1_760_000_000,
			lastActiveAt: 1_760_000_500,
			current: true,
		});
		expect(() => toSessionView(create(SessionSchema, { id: 2n ** 53n }))).toThrow(RangeError);
		expect(() => toSessionView(create(SessionSchema, { id: 1n, lastActiveAt: 2n ** 63n - 1n }))).toThrow(RangeError);
	});
});
