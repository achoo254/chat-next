// The notice that the Office tab became Observe: shown over the first map
// opened on a device, remembered as soon as it shows, closable, and harmless
// when storage is refused.
import { create } from "@bufbuild/protobuf";
import { MachineInfoSchema, ObservatorySnapshotSchema } from "@achoo254/chat-proto/remote/remote";
import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n/i18n.tsx";
import LiveMapView from "../../../src/machines/observatory/live-map-view.tsx";
import { OFFICE_REPLACED_SEEN_KEY, OfficeReplacedNotice } from "../../../src/machines/observatory/office-replaced-notice.tsx";
import { FakeLink } from "./fake-observatory-link.ts";

vi.mock("../../../src/machines/observatory/render/live-map-stage.tsx", () => ({
	readHideDetails: () => false,
	LiveMapStage: () => <div data-id="stage" />,
}));

const notice = (view: { container: HTMLElement }): Element | null => view.container.querySelector("[data-id=observe-office-replaced]");

function show() {
	return render(
		<I18nProvider>
			<OfficeReplacedNotice />
		</I18nProvider>,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the notice that Observe replaced the Office tab", () => {
	it("shows the first time, in Vietnamese with its diacritics, and is remembered at once", () => {
		const view = show();
		expect(notice(view)?.textContent).toBe("Tab Văn phòng đã được thay bằng Quan sát");
		expect(localStorage.getItem(OFFICE_REPLACED_SEEN_KEY)).toBe("1");
	});

	it("does not show again once seen on this device", () => {
		show().unmount();
		expect(notice(show())).toBeNull();
	});

	it("closes on its button", async () => {
		const view = show();
		await userEvent.click(view.getByRole("button", { name: "Đóng thông báo" }));
		expect(notice(view)).toBeNull();
	});

	it("still shows, and does not throw, when storage is refused", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("refused");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("refused");
		});
		expect(notice(show())).not.toBeNull();
	});

	it("sits above the map of the Live Map view", async () => {
		const fake = new FakeLink();
		const view = render(
			<I18nProvider>
				<LiveMapView link={fake.link} machine="1" info={create(MachineInfoSchema, { agentVersion: "3.26.0" })} online target={{ kind: "session", sessionId: "s1" }} />
			</I18nProvider>,
		);
		act(() =>
			fake.deliver(
				{
					case: "observatorySnapshot",
					value: create(ObservatorySnapshotSchema, { sessionId: "s1", epoch: 1n, seq: 1n, session: { info: { sessionId: "s1", startedAt: BigInt(Date.now()) } } }),
				},
				true,
			),
		);
		await act(async () => {
			for (let i = 0; i < 3; i++) await Promise.resolve();
		});
		const map = view.container.querySelector("[data-id=observe-map]");
		expect(map?.firstElementChild?.getAttribute("data-id")).toBe("observe-office-replaced");
	});
});
