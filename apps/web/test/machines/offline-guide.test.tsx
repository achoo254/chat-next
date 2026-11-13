// The overview of an offline machine says what to do on it, step by step,
// with the commands ready to copy, and that the page reconnects by itself.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { OfflineGuide } from "../../src/machines/offline-guide.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";

const services = { toasts: { show: () => undefined } } as unknown as Services;

describe("the offline machine's guide", () => {
	it("lists the steps in order, each command with a copy button, and the wait last", () => {
		render(
			<I18nProvider>
				<ServicesContext value={services}>
					<OfflineGuide />
				</ServicesContext>
			</I18nProvider>,
		);
		const guide = screen.getByRole("region", { name: "Máy đang ngoại tuyến" });
		const steps = within(guide).getAllByRole("listitem");
		expect(steps.map((s) => within(s).getByRole("heading").textContent)).toEqual(["Bật máy và đăng nhập", "Bật tunelo", "Vẫn chưa nối được? Xem trạng thái", "Chờ máy nối lại"]);
		expect(within(steps[1] as HTMLElement).getByText("tunelo start")).toBeTruthy();
		expect(within(steps[2] as HTMLElement).getByText("tunelo status")).toBeTruthy();
		expect(within(guide).getAllByRole("button", { name: "Sao chép lệnh" })).toHaveLength(2);
		expect(within(steps[3] as HTMLElement).getByRole("status").textContent).toBe("Đang chờ máy lên mạng…");
	});
});
