// The sign-in card of the public pages in the iPhone and Android apps: the
// call to action hands sign-in to the native layer (system browser) and
// stays busy until that comes back.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/i18n.tsx";
import { ChatSignInCard } from "../src/screens/chat-sign-in-card.tsx";

const native = vi.hoisted(() => ({ signInFromLink: vi.fn<(href: string) => Promise<void>>() }));
vi.mock("../src/native/native-app.ts", () => native);

function renderCard() {
	return render(
		<Suspense fallback={null}>
			<I18nProvider>
				<ChatSignInCard />
			</I18nProvider>
		</Suspense>,
	);
}

afterEach(() => {
	vi.unstubAllEnvs();
	native.signInFromLink.mockReset();
});

describe("sign-in card", () => {
	it("follows the server's sign-in link on the web", () => {
		renderCard();
		const cta = screen.getByRole("link", { name: "Đăng nhập bằng hoandat.com" });
		expect(cta.getAttribute("href")).toBe("/auth/login?locale=vi");
		expect(cta.getAttribute("aria-busy")).toBeNull();
	});

	it("runs the native sign-in in the app and stays busy until the browser closes", async () => {
		vi.stubEnv("VITE_NATIVE", "true");
		let finish = () => {};
		native.signInFromLink.mockReturnValue(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		renderCard();
		const cta = screen.getByRole("link", { name: "Đăng nhập bằng hoandat.com" });

		await userEvent.click(cta);
		expect(cta.getAttribute("aria-busy")).toBe("true");
		await vi.waitFor(() => expect(native.signInFromLink).toHaveBeenCalledWith("/auth/login?locale=vi"));

		// A second tap while the browser is open starts nothing.
		await userEvent.click(cta);
		expect(native.signInFromLink).toHaveBeenCalledTimes(1);

		await act(async () => finish());
		expect(cta.getAttribute("aria-busy")).toBeNull();
	});
});
