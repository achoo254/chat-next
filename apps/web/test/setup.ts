import { PREFERENCE_KEYS } from "@achoo254/app-shell/preferences";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { resetMediaState } from "../src/messaging/media/media-state.ts";
import { inviteLinks } from "../src/messaging/ui/members.ts";
import { preloadPlainTextEditor } from "../src/components/plain-text-box.tsx";

// jsdom has no object URLs; media screens make them for downloaded files.
if (typeof URL.createObjectURL !== "function") {
	let next = 0;
	URL.createObjectURL = () => `blob:test/${++next}`;
	URL.revokeObjectURL = () => undefined;
}

// jsdom has no layout. The message boxes run ProseMirror, which measures the
// caret to keep it in view: every box is empty and at the origin here.
const noRects = (): DOMRectList => Object.assign([], { item: () => null }) as unknown as DOMRectList;
const zeroRect = (): DOMRect => new DOMRect(0, 0, 0, 0);
for (const proto of [Range.prototype, Text.prototype] as { getClientRects?: () => DOMRectList; getBoundingClientRect?: () => DOMRect }[]) {
	proto.getClientRects ??= noRects;
	proto.getBoundingClientRect ??= zeroRect;
}
document.elementFromPoint ??= () => null;

// The message boxes' editor loads apart from the screens; here it is in
// before any test, so a box is ready to type in as soon as it renders.
await preloadPlainTextEditor();

// The idle prefetch of secondary screens' code (components/preload.ts) only
// warms a cache; in tests it would load modules at a random point of a test
// and shift its timing, so the browser is never idle here.
window.requestIdleCallback = () => 0;
window.cancelIdleCallback = () => undefined;

// A browser's own stylesheet hides what a closed <details> holds besides its
// <summary> (the account menu's items), which takes it out of the
// accessibility tree; jsdom has no such rule, so role queries would find it.
const userAgentRules = document.createElement("style");
userAgentRules.textContent = "details:not([open]) > :not(summary) { display: none; }";
document.head.append(userAgentRules);

// Screens and menus load lazily; shared CI runners are about twice as slow
// as a laptop, so async queries wait up to 5 s before failing.
configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
	// The shared language and theme of every hoandat.com app (@achoo254/app-shell).
	for (const key of Object.values(PREFERENCE_KEYS)) document.cookie = `${key}=; Path=/; Max-Age=0`;
	document.documentElement.removeAttribute("data-theme");
	window.localStorage.clear();
	window.sessionStorage.clear();
	window.history.replaceState(null, "", "/");
	document.documentElement.lang = "vi";
});

afterEach(() => {
	cleanup();
	resetMediaState();
	inviteLinks.clear();
});
