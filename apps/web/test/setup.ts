import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

// Screens and menus load lazily; shared CI runners are about twice as slow
// as a laptop, so async queries wait up to 5 s before failing.
configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
	window.localStorage.clear();
	window.sessionStorage.clear();
	window.history.replaceState(null, "", "/");
	document.documentElement.lang = "vi";
});

afterEach(() => {
	cleanup();
});
