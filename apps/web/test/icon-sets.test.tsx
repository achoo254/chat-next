import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PATHS } from "../src/components/icon.tsx";
import { Icon, SCREEN_PATHS } from "../src/components/screen-icons.tsx";

describe("icon sets", () => {
	it("keeps each icon in one set, so neither replaces the other's paths", () => {
		expect(Object.keys(SCREEN_PATHS).filter((name) => name in PATHS)).toEqual([]);
	});

	it("draws first-screen and screen-only icons alike from the screens' Icon", () => {
		const { container } = render(
			<>
				<Icon name="message" />
				<Icon name="trash" small />
			</>,
		);
		const icons = container.querySelectorAll("svg.icon");
		expect(icons).toHaveLength(2);
		expect(icons[0]?.querySelector("path")).not.toBeNull();
		expect(icons[1]?.classList.contains("icon-sm")).toBe(true);
		expect(icons[1]?.querySelector("path")).not.toBeNull();
	});
});
