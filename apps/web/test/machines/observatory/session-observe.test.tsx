// "Quan sát" among a session's views: offered from tunelo 3.26.0 for a Claude
// Code thread only, the header's switch, the view a session opens in from a
// list (a kept "office" reads as Observe), and the routes: /observe, the old
// /office opening it (and its address moving to /observe with its query), and
// a machine's session by its own id.
import { create } from "@bufbuild/protobuf";
import { MachineInfoSchema } from "@achoo254/chat-proto/remote/remote";
import { render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n/i18n.tsx";
import { aiPaths, canonicalAiPath, observeFocus } from "../../../src/machines/ai-paths.ts";
import {
	ModeSwitch,
	modePath,
	observeOffered,
	openSessionIn,
	pickedMode,
	rememberSessionMode,
	rowMode,
	sessionModeOf,
	sessionModes,
	sessionPath,
} from "../../../src/machines/session-mode.tsx";
import { matchRoute } from "../../../src/router.tsx";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);
const info = (agentVersion: string) => create(MachineInfoSchema, { agentVersion });

/** Storage changed outside this page's own writes (another tab, a clear): the page hears it as a storage event. */
const storageChanged = (key: string | null): void => {
	window.dispatchEvent(new StorageEvent("storage", { key }));
};

const cleanStorage = (): void => {
	window.localStorage.clear();
	storageChanged(null);
};

describe("the session's views", () => {
	it("offers Observe from tunelo 3.26.0 for a Claude Code thread only, and lists the views in order", () => {
		expect(observeOffered(info("3.25.9"), "claude")).toBe(false);
		expect(observeOffered(info("3.26.0"), "claude")).toBe(true);
		expect(observeOffered(info("3.26.0"), "antigravity")).toBe(false);
		expect(observeOffered(null, "claude")).toBe(false);
		expect(sessionModes(true, true)).toEqual(["chat", "terminal", "observe"]);
		expect(sessionModes(false, true)).toEqual(["chat", "observe"]);
		expect(sessionModes(false, false)).toEqual(["chat"]);
		// Observe open on a machine offline or back on an older tunelo: still a way back to chat.
		expect(sessionModes(false, false, "observe")).toEqual(["chat", "observe"]);
		expect(sessionModes(false, false, "terminal")).toEqual(["chat"]);
	});

	it("shows the switch only with two views: chat, terminal and Observe; nothing for chat alone", () => {
		const { container, rerender } = wrap(<ModeSwitch machine="1" threadId="s1" mode="observe" modes={["chat", "terminal", "observe"]} />);
		const group = within(container).getByRole("group");
		expect(within(group).getAllByRole("button").map((b) => [b.getAttribute("data-id"), b.getAttribute("aria-pressed")])).toEqual([
			["session-mode-chat", "false"],
			["session-mode-terminal", "false"],
			["session-mode-observe", "true"],
		]);
		rerender(
			<I18nProvider>
				<ModeSwitch machine="1" threadId="s1" mode="chat" modes={["chat", "observe"]} />
			</I18nProvider>,
		);
		expect(within(container).getAllByRole("button").map((b) => b.textContent)).toEqual(["Trò chuyện", "Quan sát"]);
		rerender(
			<I18nProvider>
				<ModeSwitch machine="1" threadId="s1" mode="chat" modes={["chat"]} />
			</I18nProvider>,
		);
		expect(container.innerHTML).toBe("");
	});

	it("opens the next session in the view last picked on a switch, where that session offers it", () => {
		cleanStorage();
		const other = { id: "s9", terminalSession: 0, open: false };
		expect(pickedMode()).toBeNull();
		expect(sessionPath("1", other, true)).toBe("/ai/1/s/s9");
		openSessionIn("1", "abc", "observe");
		expect(pickedMode()).toBe("observe");
		expect(sessionPath("1", other, true, true)).toBe("/ai/1/s/s9/observe");
		// Not offered there (an older tunelo, another AI): as before.
		expect(sessionPath("2", other, false, false)).toBe("/ai/2/s/s9");
		rememberSessionMode("2", "s9", "terminal");
		expect(sessionPath("2", other, true, false)).toBe("/ai/2/s/s9/terminal");
		cleanStorage();
	});

	it("reads a kept or picked office as Observe, and an unknown value as nothing", () => {
		cleanStorage();
		window.localStorage.setItem("ai:mode:1:abc", "office");
		expect(sessionModeOf("1", "abc")).toBe("observe");
		expect(rowMode("1", { id: "abc", terminalSession: 0, open: false })).toBe("observe");
		window.localStorage.setItem("ai:mode:picked", "office");
		storageChanged("ai:mode:picked");
		expect(pickedMode()).toBe("observe");
		window.localStorage.setItem("ai:mode:1:abc", "garden");
		expect(sessionModeOf("1", "abc")).toBe("chat");
		window.localStorage.setItem("ai:mode:picked", "garden");
		storageChanged("ai:mode:picked");
		expect(pickedMode()).toBeNull();
		cleanStorage();
	});

	it("a session left in chat opens in chat again, whatever view was picked on another session", () => {
		cleanStorage();
		const left = { id: "old", terminalSession: 0, open: false };
		const fresh = { id: "never", terminalSession: 0, open: false };
		rememberSessionMode("1", "old", "chat");
		openSessionIn("1", "other", "observe");
		expect(sessionPath("1", left, true, true)).toBe("/ai/1/s/old");
		expect(sessionPath("1", fresh, true, true)).toBe("/ai/1/s/never/observe");
		rememberSessionMode("1", "old", "observe");
		openSessionIn("1", "other", "chat");
		expect(sessionPath("1", left, true, true)).toBe("/ai/1/s/old/observe");
		cleanStorage();
	});

	it("reads the pick from storage once, and again only when another tab changes it", () => {
		cleanStorage();
		const read = vi.spyOn(Storage.prototype, "getItem");
		try {
			for (let i = 0; i < 20; i++) pickedMode();
			expect(read.mock.calls.filter(([key]) => key === "ai:mode:picked")).toHaveLength(1);
			window.localStorage.setItem("ai:mode:picked", "terminal");
			expect(pickedMode()).toBeNull();
			storageChanged("ai:mode:picked");
			expect(pickedMode()).toBe("terminal");
		} finally {
			read.mockRestore();
			cleanStorage();
		}
	});
});

describe("the Observe routes", () => {
	it("routes a session's /observe and its old /office to Observe", () => {
		const view = { page: "session-observe", machine: "1", threadId: "abc" };
		expect(matchRoute("/ai/1/s/abc/observe")).toEqual({ name: "machines", view });
		expect(matchRoute("/ai/1/s/abc/office")).toEqual({ name: "machines", view });
		expect(aiPaths.sessionObserve("1", "abc")).toBe("/ai/1/s/abc/observe");
		expect(modePath("1", "abc", "observe")).toBe("/ai/1/s/abc/observe");
	});

	it("moves an old /office address to /observe, keeping ?at= and &event=", () => {
		expect(canonicalAiPath("/ai/1/s/abc/office", "?at=1795402800000&event=tool%3At1")).toBe("/ai/1/s/abc/observe?at=1795402800000&event=tool%3At1");
		expect(canonicalAiPath("/machines/1/s/abc/office")).toBe("/ai/1/s/abc/observe");
		expect(canonicalAiPath("/machines/1/s/abc")).toBe("/ai/1/s/abc");
		expect(canonicalAiPath("/ai/1/s/abc/observe")).toBeNull();
		expect(canonicalAiPath("/ai/1/s/abc")).toBeNull();
	});

	it("routes a machine's session by its own id", () => {
		const id = "3f2a9c1e-7b4d-4e1a-9c2b-8d7e6f5a4b3c";
		expect(matchRoute(`/ai/1/observe/${id}`)).toEqual({ name: "machines", view: { page: "observe-session", machine: "1", sessionId: id } });
		expect(aiPaths.observeSession("1", id)).toBe(`/ai/1/observe/${id}`);
		expect(matchRoute(aiPaths.observeSession("1", "a b/c"))).toEqual({ name: "machines", view: { page: "observe-session", machine: "1", sessionId: "a b/c" } });
		// Control characters or too long: not a session id.
		expect(matchRoute(`/ai/1/observe/${encodeURIComponent("a\u0001b")}`)).toBeNull();
		expect(matchRoute(`/ai/1/observe/${"x".repeat(201)}`)).toBeNull();
	});

	it("carries a moment and an event in the query, and reads them back", () => {
		expect(aiPaths.sessionObserve("1", "abc", { at: 1_000, event: "tool:t1" })).toBe("/ai/1/s/abc/observe?at=1000&event=tool%3At1");
		expect(aiPaths.observeSession("1", "s1", { at: 5 })).toBe("/ai/1/observe/s1?at=5");
		expect(observeFocus("?at=1000&event=tool%3At1")).toEqual({ at: 1_000, event: "tool:t1" });
		expect(observeFocus("?at=soon")).toEqual({});
		expect(observeFocus("")).toEqual({});
	});
});
