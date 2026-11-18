// The AI Agent column's first steps: connect a machine, add a project, open a
// first session. The first step still open is the current one; the others
// wait (or show done); once all three are done nothing is left to show.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { FirstSteps, stepsPending } from "../../src/machines/first-steps.tsx";

afterEach(cleanup);

const view = (progress: { machines: number; projects: number; sessions: number }) =>
	render(
		<I18nProvider>
			<FirstSteps progress={progress} addProject={<button type="button">Thêm dự án</button>} />
		</I18nProvider>,
	);

const stateOf = (id: string) => document.querySelector(`[data-step=${id}]`)?.getAttribute("data-state");

describe("first steps", () => {
	it("no machine: connecting one is the current step, with what it needs and its button; the next two wait with their reason", () => {
		view({ machines: 0, projects: 0, sessions: 0 });
		expect([stateOf("machine"), stateOf("project"), stateOf("session")]).toEqual(["current", "todo", "todo"]);
		expect(screen.getByText(/đã cài và đăng nhập một AI lập trình/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "Hướng dẫn cài Claude Code" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Kết nối máy đầu tiên" }).getAttribute("href")).toMatch(/add/);
		expect(screen.getByText("Cần kết nối máy trước")).toBeTruthy();
		expect(screen.getByText("Cần có dự án trước")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Thêm dự án" })).toBeNull();
		expect(document.querySelector("[aria-current=step]")?.getAttribute("data-step")).toBe("machine");
	});

	it("on a phone it says to run the command on the computer to control", () => {
		const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
		view({ machines: 0, projects: 0, sessions: 0 });
		expect(screen.getByText(/mở trang này trên máy tính bạn muốn điều khiển/)).toBeTruthy();
		ua.mockRestore();
	});

	it("a machine and no project: step 1 is done and adding a project is the current step with its button", () => {
		view({ machines: 1, projects: 0, sessions: 0 });
		expect([stateOf("machine"), stateOf("project"), stateOf("session")]).toEqual(["done", "current", "todo"]);
		expect(screen.getByRole("button", { name: "Thêm dự án" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Kết nối máy đầu tiên" })).toBeNull();
		expect(screen.getByText("Cần có dự án trước")).toBeTruthy();
	});

	it("a project and no session: opening a session is the current step", () => {
		view({ machines: 1, projects: 1, sessions: 0 });
		expect([stateOf("machine"), stateOf("project"), stateOf("session")]).toEqual(["done", "done", "current"]);
		expect(screen.getByText(/bấm Phiên mới/)).toBeTruthy();
	});

	it("steps are pending until a machine, a project and a session all exist", () => {
		expect(stepsPending({ machines: 0, projects: 0, sessions: 0 })).toBe(true);
		expect(stepsPending({ machines: 1, projects: 1, sessions: 0 })).toBe(true);
		expect(stepsPending({ machines: 1, projects: 1, sessions: 1 })).toBe(false);
	});
});
