// The Live Map view with its panels mounted: a click on a station opens its
// drawer (numbers asked up to the replayed moment), a click on a piece or on
// an event opens its detail (content asked by id), the replay bar sits under
// the map and rebuilds the scene at the replayed moment, "Live" goes back, a
// link's event opens at its moment, and another session starts clean. The
// stage (PixiJS, plate, DOM tags) is a stand-in with one button per click.
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
	readHideDetails: () => false,
	LiveMapStage: ({ state, onStation, onEvent }: LiveMapStageProps) => (
		<div data-id="stage" data-events={state.log.length}>
			<button type="button" data-id="stub-station" onClick={() => onStation("files")} />
			<button type="button" data-id="stub-desk" onClick={() => onStation("user-desk")} />
			<button type="button" data-id="stub-piece" onClick={() => onEvent("prompt:p1")} />
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

describe("the Live Map view with its panels", () => {
	it("puts the replay bar under the map, live at the end", async () => {
		const { view } = await open();
		expect(id(view, "lmd-replay")?.getAttribute("data-state")).toBe("live");
		expect(id(view, "lmd-drawer")).toBeNull();
		expect(id(view, "lmd-detail")).toBeNull();
	});

	it("opens a station's drawer on a click, asks its numbers for the whole session, and closes it", async () => {
		const { fake, view } = await open();
		await userEvent.click(id(view, "stub-station") as Element);
		expect(id(view, "lmd-drawer")?.getAttribute("data-station")).toBe("FILES");
		expect(fake.sent.at(-1)).toEqual({ case: "observatoryStation", value: { sessionId: "s1", station: "FILES", at: 0n } });
		await userEvent.click(id(view, "lmd-close") as Element);
		expect(id(view, "lmd-drawer")).toBeNull();
	});

	it("opens nothing for a place that is not a station", async () => {
		const { view } = await open();
		await userEvent.click(id(view, "stub-desk") as Element);
		expect(id(view, "lmd-drawer")).toBeNull();
		expect(id(view, "observe-map")?.getAttribute("data-selected-place")).toBe("user-desk");
	});

	it("opens a piece's event with its content asked by id", async () => {
		const { fake, view } = await open();
		await userEvent.click(id(view, "stub-piece") as Element);
		expect(id(view, "lmd-detail")?.getAttribute("data-kind")).toBe("prompt");
		expect(fake.sent.at(-1)).toEqual({ case: "observatoryContent", value: { sessionId: "s1", eventId: "prompt:p1" } });
	});

	it("replays on play, asks the drawer's numbers up to the replayed moment, and goes back live", async () => {
		const { fake, view } = await open();
		await userEvent.click(id(view, "stub-station") as Element);
		await userEvent.click(id(view, "lmd-play") as Element);
		expect(id(view, "lmd-replay")?.getAttribute("data-state")).toBe("replay");
		const asked = fake.sent.filter((b) => b.case === "observatoryStation");
		const last = asked.at(-1);
		expect(last?.case === "observatoryStation" && (last.value.at ?? 0n) > 0n).toBe(true);
		await userEvent.click(id(view, "lmd-live") as Element);
		expect(id(view, "lmd-replay")?.getAttribute("data-state")).toBe("live");
		const again = fake.sent.filter((b) => b.case === "observatoryStation").at(-1);
		expect(again?.case === "observatoryStation" && again.value.at).toBe(0n);
	});

	it("replays to the event's moment from its detail, the core as it was then", async () => {
		const { view } = await open();
		expect(id(view, "observe-map")?.getAttribute("data-core")).toBe("waiting_permission");
		await userEvent.click(id(view, "stub-piece") as Element);
		await userEvent.click(id(view, "lmd-replay-here") as Element);
		expect(id(view, "lmd-replay")?.getAttribute("data-state")).toBe("replay");
		// At the prompt the core thought; the machine's state now (waiting for permission) is not that moment's.
		expect(id(view, "observe-map")?.getAttribute("data-core")).toBe("thinking");
		await userEvent.click(id(view, "lmd-live") as Element);
		expect(id(view, "observe-map")?.getAttribute("data-core")).toBe("waiting_permission");
	});

	it("opens at the event a link names, at its moment", async () => {
		const { view } = await open({ event: "prompt:p1" });
		expect(id(view, "lmd-detail")?.getAttribute("data-kind")).toBe("prompt");
		expect(id(view, "lmd-replay")?.getAttribute("data-state")).toBe("replay");
	});

	it("starts another session clean", async () => {
		const { fake, view } = await open();
		await userEvent.click(id(view, "stub-station") as Element);
		expect(id(view, "lmd-drawer")).not.toBeNull();
		view.rerender(
			<I18nProvider>
				<LiveMapView link={fake.link} machine="1" info={machine} online target={{ kind: "session", sessionId: "s2" }} />
			</I18nProvider>,
		);
		act(() => fake.deliver(snapshot(3n, 1n, "s2"), false));
		await flush();
		expect(id(view, "lmd-replay")?.getAttribute("data-state")).toBe("live");
		expect(id(view, "lmd-drawer")).toBeNull();
	});
});
