// The activity card as the person reads it: its status, kind line and the
// call in large type, Runtime and the p95 history with their own labels, the
// indeterminate bar while a call runs (no percentage), the output pending
// while it runs, the description and last output line asked by id once it
// ended (and not asked at all with "Ẩn chi tiết", the reason said instead),
// "content off" for a project that stores none, the journey and "Xem chi tiết".
import { create } from "@bufbuild/protobuf";
import { ObservatoryContentResultSchema, ObservatoryContentState } from "@achoo254/chat-proto/remote/remote";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n/i18n.tsx";
import { viMachines } from "../../../src/machines/copy-vi.ts";
import { activityCardOf } from "../../../src/machines/observatory/activity-card-model.ts";
import { ActivityCard } from "../../../src/machines/observatory/activity-card.tsx";
import type { LiveMapState } from "../../../src/machines/observatory/live-map-state.ts";
import { OBSERVATORY_COPY } from "../../../src/machines/observatory/observatory-copy.ts";
import { placeNames } from "../../../src/machines/observatory/place-names.ts";
import { played } from "../../observatory/render-fixtures.ts";
import { FakeLink } from "./fake-observatory-link.ts";
import { lifecycle, prompt, T0, tool } from "./live-map-fixtures.ts";

const c = OBSERVATORY_COPY.vi;
const names = placeNames(viMachines.observe);

function show(state: LiveMapState, now: number, { hide = false, fake = null as FakeLink | null } = {}) {
	const onDetail = vi.fn();
	const source = fake === null ? null : { link: fake.link, sessionId: "s1", online: true };
	const view = render(
		<I18nProvider>
			<ActivityCard card={activityCardOf(state, now)} names={names} hide={hide} source={source} onDetail={onDetail} />
		</I18nProvider>,
	);
	const text = (id: string): string => view.container.querySelector(`[data-id=${id}]`)?.textContent ?? "";
	return { ...view, onDetail, text };
}

const flush = async (): Promise<void> => {
	await act(async () => {
		for (let i = 0; i < 4; i++) await Promise.resolve();
	});
};

const bash = (ms: number, end?: { ok: boolean; took: number }) =>
	tool("b1", ms, { toolName: "Bash", target: "pnpm", station: "TESTING", ...(end === undefined ? {} : { success: end.ok, durationMs: end.took }) });

describe("the activity card", () => {
	it("while a call runs: running, the call large, its runtime, an indeterminate bar, the output still pending", () => {
		const { text, container } = show(played([prompt(1, 0), bash(10)]).state, T0 + 2_010);
		expect(container.querySelector("[data-id=observe-card]")?.getAttribute("data-status")).toBe("run");
		expect(text("observe-card-status")).toBe(c.card.status.run);
		expect(text("observe-card-kind")).toBe(`${c.card.running} · ${names.testing}`);
		expect(text("observe-card-what")).toBe("Bash pnpm");
		expect(text("observe-card-runtime")).toBe(`${c.card.runtime} 2 s`);
		expect(text("observe-card-history")).toBe(c.card.noHistory);
		const bar = container.querySelector("[data-id=observe-card-bar]");
		expect(bar?.getAttribute("role")).toBe("progressbar");
		expect(bar?.hasAttribute("aria-valuenow")).toBe(false);
		expect(text("observe-card-output")).toBe(`${c.card.output}: ${c.card.outputPending}`);
	});

	it("keeps Runtime and the p95 history apart, and says when the run is longer than that p95", () => {
		const { text } = show(played([prompt(1, 0), tool("a", 10, { station: "TESTING", success: true, durationMs: 1_000 }), bash(2_000)]).state, T0 + 6_000);
		expect(text("observe-card-runtime")).toBe(`${c.card.runtime} 4 s`);
		expect(text("observe-card-history")).toBe(`1 s ${c.card.historyCount(1)} · ${c.card.overP95}`);
		expect(text("observe-card-calls")).toBe("2");
	});

	it("once the call ended asks its content by id and shows the description and the output's last line", async () => {
		const fake = new FakeLink();
		const { text } = show(played([prompt(1, 0), bash(10, { ok: false, took: 4_500 })]).state, T0 + 4_600, { fake });
		expect(fake.sent).toEqual([{ case: "observatoryContent", value: { sessionId: "s1", eventId: "tool:b1" } }]);
		act(() =>
			fake.answer({
				case: "observatoryContentResult",
				value: create(ObservatoryContentResultSchema, { eventId: "tool:b1", state: ObservatoryContentState.STORED, text: JSON.stringify({ input: JSON.stringify({ description: "Chạy test Live Map" }), output: "FAIL a.test.ts\n1 failed, 41 passed" }) }),
			}),
		);
		await flush();
		expect(text("observe-card-status")).toBe(c.card.status.err);
		expect(text("observe-card-desc")).toBe("Chạy test Live Map");
		expect(text("observe-card-output")).toBe(`${c.card.output}: 1 failed, 41 passed`);
	});

	it("says the project stores no content when it is off", async () => {
		const fake = new FakeLink();
		const { text } = show(played([prompt(1, 0), bash(10, { ok: true, took: 100 })]).state, T0 + 200, { fake });
		act(() => fake.answer({ case: "observatoryContentResult", value: create(ObservatoryContentResultSchema, { eventId: "tool:b1", state: ObservatoryContentState.OFF }) }));
		await flush();
		expect(text("observe-card-output")).toBe(`${c.card.output}: ${c.card.outputOff}`);
	});

	it("with 'Ẩn chi tiết' asks no content and hides the target", () => {
		const fake = new FakeLink();
		const { text } = show(played([prompt(1, 0), bash(10, { ok: true, took: 100 })]).state, T0 + 200, { fake, hide: true });
		expect(fake.sent).toEqual([]);
		expect(text("observe-card-what")).toBe("Bash");
		expect(text("observe-card-output")).toBe(`${c.card.output}: ${c.card.outputHidden}`);
	});

	it("waiting for permission, thinking and idle each say so", () => {
		const wait = show(played([prompt(1, 0), lifecycle("permission_request", "q", 10, { label: "Bash" })]).state, T0 + 3_010);
		expect(wait.text("observe-card-status")).toBe(c.card.status.wait);
		expect(wait.text("observe-card-what")).toBe(c.card.waitWhat("Bash"));
		wait.unmount();
		const think = show(played([prompt(1, 0)]).state, T0 + 500);
		expect(think.text("observe-card-status")).toBe(c.card.status.think);
		expect(think.container.querySelector("[data-id=observe-card-bar]")).not.toBeNull();
		think.unmount();
		const idle = show(played([prompt(1, 0), bash(10, { ok: true, took: 100 }), lifecycle("stop", "s", 200)]).state, T0 + 60_000);
		expect(idle.text("observe-card-status")).toBe(c.card.status.idle);
		expect(idle.text("observe-card-desc")).toBe(c.card.lastJob("Bash pnpm", true, "100 ms"));
	});

	it("shows the journey and opens the event's detail", async () => {
		const { text, onDetail } = show(played([prompt(1, 0), tool("r", 5, { success: true, durationMs: 1 }), bash(10)]).state, T0 + 100);
		expect(text("observe-card-journey")).toContain(names.core);
		expect(text("observe-card-journey")).toContain(names.files);
		expect(text("observe-card-journey")).toContain(names.testing);
		await userEvent.click(screen.getByRole("button", { name: c.card.more }));
		expect(onDetail).toHaveBeenCalledWith("tool:b1");
	});
});
