import { LAST_USER_KEY } from "@achoo254/chat-platform-web";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_LAST_USER_KEY, forgetSelf, lastSelf, rememberSelf } from "../src/api/offline-self.ts";

const SELF = { id: 42, name: "Đức Thắng", username: "thang_dt", bio: "", email: "thang@example.com", isOperator: false };

describe("the user remembered for offline starts", () => {
	afterEach(() => window.localStorage.clear());

	it("reads the client core's own key", () => {
		expect(CORE_LAST_USER_KEY).toBe(LAST_USER_KEY);
	});

	it("is returned only while the local data belongs to the same user", () => {
		rememberSelf(SELF);
		expect(lastSelf()).toBeNull();
		rememberSelf(SELF);
		window.localStorage.setItem(CORE_LAST_USER_KEY, "42");
		expect(lastSelf()).toEqual(SELF);
		window.localStorage.setItem(CORE_LAST_USER_KEY, "7");
		expect(lastSelf()).toBeNull();
		// A mismatch drops the stale entry.
		window.localStorage.setItem(CORE_LAST_USER_KEY, "42");
		expect(lastSelf()).toBeNull();
	});

	it("drops entries of the wrong shape and is gone after forgetSelf", () => {
		window.localStorage.setItem(CORE_LAST_USER_KEY, "42");
		window.localStorage.setItem("app:last-self", "{not json");
		expect(lastSelf()).toBeNull();
		window.localStorage.setItem("app:last-self", JSON.stringify({ ...SELF, id: "42" }));
		expect(lastSelf()).toBeNull();
		rememberSelf(SELF);
		forgetSelf();
		expect(lastSelf()).toBeNull();
	});
});
