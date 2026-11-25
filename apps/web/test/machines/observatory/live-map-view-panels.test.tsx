// The Live Map view around its stage: the session's core state and the pick
// marked on the map (for tests and links), a link's event handed to the stage,
// no drawer, no replay bar and no station numbers asked of the machine, and
// another session starts clean. The stage is a stand-in with one button per
// pick.
import { create } from "@bufbuild/protobuf";
import { MachineInfoSchema, ObservatoryCoreState, ObservatoryEventSchema, ObservatorySessionSource, ObservatorySnapshotSchema, type Frame } from "@achoo254/chat-proto/remote/remote";
import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n/i18n.tsx";
import LiveMapView from "../../../src/machines/observatory/live-map-view.tsx";
import type { LiveMapStageProps } from "../../../src/machines/observatory/render/live-map-stage.tsx";
import { FakeLink } from "./fake-observatory-link.ts";

vi.mock("../../../src/machines/observatory/render/live-map-stage.tsx", () => ({
	LiveMapStage: ({ state, onPick, initialEvent }: LiveMapStageProps) => (
		<div data-id="stage" data-events={state.log.length} data-initial={initialEvent}>
			<button type="button" data-id="stub-station" onClick={() => onPick?.({ kind: "place", place: "files" })} />
			<button type="button" data-id="stub-piece" onClick={() => onPick?.({ kind: "event", eventId: "prompt:p1" })} />
		</div>
	),
}));

const machine = create(MachineInfoSchema, { agentVersion: "3.26.0" });
/** A session that began a minute ago (a session older than 90 days has no events left to replay). */
const START = Date.now() - 60_000;
const snapshot = (seq: bigint, epoch = 1n, sessionId = "s1"): Frame["body"] => ({
	case: "observatorySnapshot",
	value: create(ObservatorySnapshotSchema, {
		sessionId,
		epoch,
		seq,
		session: {
			info: { sessionId, projectKey: "github.com/acme/app", source: ObservatorySessionSource.CLI, startedAt: BigInt(START) },
			live: { core: ObservatoryCoreState.WAITING_PERMISSION, contextPercent: 40, contextTokens: 80_000n, contextWindow: 200_000n, contextWindowAssumed: true },
		},
		events: [
			create(ObservatoryEventSchema, { at: BigInt(START + 1_000), id: "prompt:p1", kind: { case: "prompt", value: { promptId: "p1" } } }),
			create(ObservatoryEventSchema, { at: BigInt(START + 5_000), id: "tool:t1", kind: { case: "toolCall", value: { toolUseId: "t1", station: "FILES" } } }),
		],
	}),
});

const flush = async (): Promise<void> => {
	await act(async () => {
		for (let i = 0; i < 3; i++) await Promise.resolve();
	});
};

async function open(focus?: { at?: number; event?: string }) {
	const fake = new FakeLink();
	const view = render(
		<I18nProvider>
			<LiveMapView link={fake.link} machine="1" info={machine} online target={{ kind: "session", sessionId: "s1" }} {...(focus === undefined ? {} : { focus })} />
		</I18nProvider>,
	);
	act(() => fake.deliver(snapshot(3n), true));
	await flush();
	return { fake, view };
}

const id = (view: { container: HTMLElement }, name: string): Element | null => view.container.querySelector(`[data-id=${name}]`);

describe("the Live Map view around its stage", () => {
	it("marks the core's state and the pick on the map, and asks the machine no station numbers", async () => {
		const { fake, view } = await open();
		expect(id(view, "observe-map")?.getAttribute("data-core")).toBe("waiting_permission");
		await userEvent.click(id(view, "stub-station") as Element);
		expect(id(view, "observe-map")?.getAttribute("data-selected-place")).toBe("files");
		await userEvent.click(id(view, "stub-piece") as Element);
		expect(id(view, "observe-map")?.getAttribute("data-selected-event")).toBe("prompt:p1");
		expect(id(view, "observe-map")?.hasAttribute("data-selected-place")).toBe(false);
		expect(fake.sent.some((b) => b.case === "observatoryStation")).toBe(false);
		expect(id(view, "lmd-replay")).toBeNull();
		expect(id(view, "lmd-drawer")).toBeNull();
	});

	it("hands the event a link names to the stage", async () => {
		const { view } = await open({ event: "prompt:p1" });
		expect(id(view, "stage")?.getAttribute("data-initial")).toBe("prompt:p1");
		expect(id(view, "observe-map")?.getAttribute("data-selected-event")).toBe("prompt:p1");
	});

	it("starts another session clean", async () => {
		const { fake, view } = await open();
		await userEvent.click(id(view, "stub-station") as Element);
		view.rerender(
			<I18nProvider>
				<LiveMapView link={fake.link} machine="1" info={machine} online target={{ kind: "session", sessionId: "s2" }} />
			</I18nProvider>,
		);
		act(() => fake.deliver(snapshot(3n, 1n, "s2"), false));
		await flush();
		expect(id(view, "observe-map")?.hasAttribute("data-selected-place")).toBe(false);
	});
});
