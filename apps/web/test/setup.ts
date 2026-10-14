import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

beforeEach(() => {
	window.localStorage.clear();
	window.history.replaceState(null, "", "/");
	document.documentElement.lang = "vi";
});

afterEach(() => {
	cleanup();
});
