// The page the Advisor's lines and buttons lead to for a session: the view the
// session has now, as its row in the session list names it (the terminal while
// one holds it), not always its chat.
import { TerminalAvailability, type MachineInfo, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { beforeEach, describe, expect, it } from "vitest";
import { pageOfSession } from "../../src/advisor/use-advisor-presence.ts";

const INFO = { terminal: TerminalAvailability.AVAILABLE, agentVersion: "3.0.0", providers: [{ id: "claude", capabilities: { terminal: true, chatTakesTerminal: false } }] } as unknown as MachineInfo;
const thread = (extra: Partial<ThreadSummary> = {}) => ({ id: "abc", provider: "claude", terminalSession: 0, open: false, ...extra }) as unknown as ThreadSummary;
const state = (t: ThreadSummary) => ({ threads: [t], info: INFO });

beforeEach(() => window.localStorage.clear());

describe("pageOfSession", () => {
	it("opens a session a terminal holds in the terminal", () => {
		expect(pageOfSession("7", "abc", state(thread({ terminalSession: 2 })))).toBe("/ai/7/s/abc/terminal");
	});

	it("opens a session last left in the terminal there, and one never opened in its chat", () => {
		window.localStorage.setItem("ai:mode:7:abc", "terminal");
		expect(pageOfSession("7", "abc", state(thread()))).toBe("/ai/7/s/abc/terminal");
		window.localStorage.clear();
		expect(pageOfSession("7", "abc", state(thread()))).toBe("/ai/7/s/abc");
	});

	it("opens the chat when the machine's state or the session is not known", () => {
		expect(pageOfSession("7", "abc", null)).toBe("/ai/7/s/abc");
		expect(pageOfSession("7", "abc", { threads: [], info: INFO })).toBe("/ai/7/s/abc");
	});
});
