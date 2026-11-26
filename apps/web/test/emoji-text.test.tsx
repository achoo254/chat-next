// Emoji at Telegram's sizes: which messages are shown big, and which characters are
// drawn as emoji inside a message (emoji-text.tsx).
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { jumboCount, withEmoji } from "../src/messaging/ui/emoji-text.tsx";

describe("emoji text", () => {
	it("shows one to three emoji alone big, nothing else", () => {
		expect(jumboCount("😂")).toBe(1);
		expect(jumboCount(" 😂 👍 ")).toBe(2);
		expect(jumboCount("👨‍👩‍👧❤️🇻🇳")).toBe(3);
		expect(jumboCount("👍🏽")).toBe(1);
		expect(jumboCount("😂😂😂😂")).toBe(0);
		expect(jumboCount("ok 😂")).toBe(0);
		expect(jumboCount("©")).toBe(0);
		expect(jumboCount("")).toBe(0);
	});

	it("wraps each emoji of a text, and leaves © and plain text alone", () => {
		const { container } = render(<p>{withEmoji("ssadsad 😂 và ❤️‍🔥 ©")}</p>);
		expect([...container.querySelectorAll(".emoji")].map((span) => span.textContent)).toEqual(["😂", "❤️‍🔥"]);
		expect(container.textContent).toBe("ssadsad 😂 và ❤️‍🔥 ©");
		expect(withEmoji("chào")).toBe("chào");
	});
});
