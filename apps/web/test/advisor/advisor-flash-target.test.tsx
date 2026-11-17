// The line beside the mascot (a verdict that came while a session shows):
// a tap brings the user back to the page the line was about, the session in
// the tab (chat, terminal, office) it showed in; without a page it opens the bubble.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import AdvisorMascot from "../../src/advisor/advisor-mascot.tsx";
import { AdvisorStore } from "../../src/advisor/advisor-store.ts";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import type { Route } from "../../src/router.tsx";

const route: Route = { name: "home" };
const PROFILE = { name: "Bác Cú", lookId: "owl", tone: "short" };
const services = {
	toasts: { show: () => undefined },
	store: { subscribe: () => () => undefined, advisorProfile: () => PROFILE },
} as unknown as Services;

function show(store: AdvisorStore) {
	return render(
		<I18nProvider>
			<ServicesContext value={services}>
				<AdvisorMascot route={route} store={store} />
			</ServicesContext>
		</I18nProvider>,
	);
}

beforeEach(() => {
	window.history.replaceState(null, "", "/ai/7/s/abc/office");
});
afterEach(cleanup);

describe("the mascot's flash line", () => {
	it("goes back to the session and tab it came from, and goes away", async () => {
		const store = new AdvisorStore();
		show(store);
		act(() => store.setFlash("Phương án A (82%)", "/ai/7/s/abc/terminal?tab=2"));
		await userEvent.click(await screen.findByText("Phương án A (82%)"));
		expect(window.location.pathname + window.location.search).toBe("/ai/7/s/abc/terminal?tab=2");
		expect(store.snapshot().flash).toBe("");
		expect(store.snapshot().flashTarget).toBe("");
		expect(store.snapshot().open).toBe(false);
	});

	it("opens the bubble when the line names no page", async () => {
		const store = new AdvisorStore();
		show(store);
		act(() => store.setFlash("Xong"));
		await userEvent.click(await screen.findByText("Xong"));
		expect(store.snapshot().open).toBe(true);
		expect(window.location.pathname).toBe("/ai/7/s/abc/office");
	});
});
