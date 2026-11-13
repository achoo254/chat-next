import { create } from "@bufbuild/protobuf";
import { UserSchema } from "@achoo254/chat-proto/users";
import { describe, expect, it } from "vitest";
import { toSelfUser } from "../src/api/adapters.ts";

describe("protocol adapters", () => {
	it("maps a user's bigint id to a number", () => {
		const user = create(UserSchema, { id: 2n ** 53n - 1n, name: "An", username: "an_1", email: "an@example.com" });
		expect(toSelfUser(user)).toEqual({
			id: Number.MAX_SAFE_INTEGER,
			name: "An",
			username: "an_1",
			bio: "",
			email: "an@example.com",
			isOperator: false,
		});
	});

	it("rejects a user id at or above 2^53", () => {
		expect(() => toSelfUser(create(UserSchema, { id: 2n ** 53n }))).toThrow(RangeError);
		expect(() => toSelfUser(create(UserSchema, { id: 2n ** 60n }))).toThrow(RangeError);
	});
});
