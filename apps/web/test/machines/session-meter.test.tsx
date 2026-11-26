// The chat's usage line: the context of the latest turn against the "Context
// lớn" threshold, the loaded turns' cost, and the suggestion to compact near
// the threshold (sent as /compact, dismissed per thread until the context
// falls again).
import { create } from "@bufbuild/protobuf";
import { ItemSchema, TurnState, type Item } from "@achoo254/chat-proto/remote/remote";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { ContextHint } from "../../src/machines/usage/context-hint.tsx";
import { sessionMeter } from "../../src/machines/usage/session-meter.ts";

const m = viMachines.usage.meter;

const turn = (contextTokens: number, costUsdEstimate = 0): Item =>
	create(ItemSchema, { id: `t${contextTokens}-${costUsdEstimate}`, body: { case: "turn", value: { state: TurnState.COMPLETED, contextTokens: BigInt(contextTokens), contextWindow: 1_000_000n, costUsdEstimate } } });

describe("the session meter", () => {
	it("takes the latest turn's context and adds up the loaded turns' cost", () => {
		const meter = sessionMeter([turn(100_000, 0.5), turn(0, 0), turn(210_000, 1.25)]);
		expect(meter).toMatchObject({ context: 210_000, pricedTurns: 2, costUsd: 1.75, show: true, near: false });
		expect(sessionMeter([turn(271_000)])).toMatchObject({ show: true, near: true });
		expect(sessionMeter([turn(150_000)])).toMatchObject({ show: false, near: false });
		expect(sessionMeter([])).toMatchObject({ context: null, show: false, near: false, pricedTurns: 0 });
	});
});

describe("the suggestion to compact", () => {
	beforeEach(() => window.localStorage.clear());

	const hint = (items: Item[], onCompact = vi.fn(), canCompact = true) =>
		render(
			<I18nProvider>
				<ContextHint meter={sessionMeter(items)} scope="1/t-1" canCompact={canCompact} onCompact={onCompact} />
			</I18nProvider>,
		);

	it("shows near the threshold and compacts on request", async () => {
		const onCompact = vi.fn();
		hint([turn(280_000)], onCompact);
		await userEvent.click(screen.getByRole("button", { name: m.compact }));
		expect(onCompact).toHaveBeenCalledOnce();
	});

	it("offers no compacting to an AI that cannot, and stays away below the threshold", () => {
		const { unmount } = hint([turn(280_000)], vi.fn(), false);
		expect(screen.queryByRole("button", { name: m.compact })).toBeNull();
		expect(screen.getByRole("button", { name: m.dismiss })).toBeTruthy();
		unmount();
		hint([turn(200_000)]);
		expect(screen.queryByRole("note")).toBeNull();
	});

	it("once dismissed stays away for the thread until the context falls below the threshold", async () => {
		const first = hint([turn(280_000)]);
		await userEvent.click(screen.getByRole("button", { name: m.dismiss }));
		expect(screen.queryByRole("note")).toBeNull();
		first.unmount();
		const again = hint([turn(290_000)]);
		expect(screen.queryByRole("note")).toBeNull();
		again.unmount();
		// Compacted: below the threshold, the dismissal is forgotten.
		hint([turn(40_000)]).unmount();
		hint([turn(285_000)]);
		expect(screen.getByRole("note")).toBeTruthy();
	});
});
