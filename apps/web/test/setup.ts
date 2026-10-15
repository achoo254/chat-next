import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { resetMediaState } from "../src/messaging/media/media-state.ts";

// jsdom has no object URLs; media screens make them for downloaded files.
if (typeof URL.createObjectURL !== "function") {
	let next = 0;
	URL.createObjectURL = () => `blob:test/${++next}`;
	URL.revokeObjectURL = () => undefined;
}

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
	resetMediaState();
});
