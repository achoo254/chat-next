// Visual harness for render checks of the messaging UI: the real app and
// client core against the core's in-memory protocol server, in the browser.
// Test-only: never part of the production build. ?theme=dark|light forces a
// theme; the path picks the screen (/c/5001, /settings/privacy, ...);
// ?at=<screen> opens a screen by name (ids come from the seed, see SCREENS);
// ?open=<scenario> clicks through to a dialog or menu state (see SCENARIOS);
// an image on /__hold keeps the page's load event back until it is done (see
// vite.config.ts), so render checks capture the finished state.
import { ChatType, MemberRole } from "@app/proto-ts/chats";
import { EntityType } from "@app/proto-ts/messages";
import { createRouterTransport } from "@connectrpc/connect";
import { openMemoryFactory } from "../../../../packages/platform-web/src/driver.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/app.tsx";
import { MESSAGING_FLAG_KEY } from "../../src/features.ts";
import "../../src/styles/fonts.css";
import "../../src/styles/tokens.css";
import "../../src/styles/app.css";
import { entity, seedDemo } from "../support/demo-data.ts";
import { fixtureConnector } from "../support/fake-chat.ts";

const params = new URLSearchParams(window.location.search);
if (params.has("open")) {
	const hold = new Image();
	hold.alt = "";
	hold.hidden = true;
	hold.src = `/__hold?${Date.now()}`;
	document.body.append(hold);
}
const theme = params.get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
window.localStorage.setItem(MESSAGING_FLAG_KEY, "1");

const demo = seedDemo();
const f = demo.fixture;
// A draft in the 1-1 chat with Quang Huy, as in mockups/chat.html#app.
window.localStorage.setItem(`chat:draft:${f.selfId}:${demo.ids.huy}`, "Chiều nay mình gửi bản sửa");
// A group you own with no other admin (#channel-owner-leave).
const owned = f.createChat(ChatType.GROUP, "Nhóm đọc sách", [f.selfId, demo.ids.users.minh, demo.ids.users.ha], { myRole: MemberRole.OWNER });
f.setRole(owned, f.selfId, MemberRole.OWNER);
f.send(demo.ids.users.minh, owned, "Tuần này đọc chương 3");
f.ownerNeedsAdmin.add(owned);
// A link whose text names another domain (#external-link, right frame).
const lure = "Khuyến mãi ở hoandat.com/khuyen-mai nhé";
f.send(demo.ids.users.minh, demo.ids.ops, lure, {
	entities: [entity(EntityType.TEXT_LINK, lure, "hoandat.com/khuyen-mai", { url: "https://hoandat-qua.example.net/nhan?id=8812" })],
});
// Someone who refuses both being added and messages from you (#add-members).
const nam = f.addUser("Hoàng Nam", { username: "hoangnam" });
f.refusesGroups.add(nam);
f.refusesMessages.add(nam);
// ?at= names a screen whose path holds an id the seed assigns.
const SCREENS: Record<string, string> = {
	ops: `/c/${demo.ids.ops}`,
	owned: `/c/${owned}`,
	forum: `/c/${demo.ids.forum}`,
	lan: `/c/${demo.ids.lanAnh}`,
	admin: `/c/${demo.ids.ops}/admin`,
	banned: `/c/${demo.ids.ops}/admin/banned`,
	contact: `/contacts/${demo.ids.users.lan}`,
};
const at = params.get("at");
const screenPath = at === null ? undefined : SCREENS[at];
if (screenPath !== undefined) window.history.replaceState(null, "", `${screenPath}${window.location.search}`);

const container = document.getElementById("root");
if (container === null) throw new Error("harness is missing #root");
createRoot(container).render(
	<StrictMode>
		<App
			transport={createRouterTransport((router) => f.routes(router))}
			messagingConnector={fixtureConnector(f, openMemoryFactory, demo.data)}
		/>
	</StrictMode>,
);

// ------------------------------------------------------------- scenarios

const TIMEOUT_MS = 15_000;

function find<T extends Element>(test: () => T | null | undefined): Promise<T> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const poll = () => {
			const found = test();
			if (found !== null && found !== undefined) resolve(found);
			else if (Date.now() - started > TIMEOUT_MS) reject(new Error("harness: element not found"));
			else setTimeout(poll, 50);
		};
		poll();
	});
}

function byName(selector: string, name: string | RegExp, root: ParentNode = document): Element | undefined {
	return [...root.querySelectorAll(selector)].find((element) => {
		const label = element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
		return typeof name === "string" ? label === name : name.test(label);
	});
}

async function click(selector: string, name: string | RegExp): Promise<void> {
	const element = await find(() => byName(selector, name));
	if (element instanceof HTMLElement) element.click();
}

async function contextMenu(selector: string, text: string): Promise<void> {
	const target = await find(() => [...document.querySelectorAll(selector)].find((element) => element.textContent?.includes(text)));
	const rect = target.getBoundingClientRect();
	target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + 20 }));
}

/** Types into a React-controlled input (the native setter, then an input event). */
async function type(selector: string, text: string): Promise<void> {
	const input = await find(() => document.querySelector<HTMLInputElement>(selector));
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, text);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openInfo(): Promise<void> {
	await find(() => document.querySelector(".convo-head"));
	if (document.querySelector("aside.info") === null) await click("button", "Thông tin chat");
	await find(() => document.querySelector("aside.info .info-head"));
}

const SCENARIOS: Record<string, () => Promise<void>> = {
	// Opens the info column where it starts closed (below 1100px).
	info: openInfo,
	context: async () => {
		await contextMenu(".messages .msg", "Dashboard ổn định.");
		await find(() => document.querySelector(".ctx-layer .menu"));
	},
	"new-chat": async () => {
		await click("button", "Tạo chat mới");
		await find(() => document.querySelector("dialog .quick"));
	},
	members: async () => {
		await openInfo();
		await click("aside.info button", /^Xem cả \d+ thành viên$/);
		await find(() => document.querySelector("dialog .member-list li"));
	},
	"remove-member": async () => {
		await openInfo();
		await click("aside.info button", /^Xem cả \d+ thành viên$/);
		await click("dialog button", "Thao tác với Minh");
		await click("[role=menuitem]", "Xoá khỏi nhóm");
		await find(() => byName("dialog h2", "Xoá Minh khỏi nhóm?"));
	},
	"owner-leave": async () => {
		await openInfo();
		await click("aside.info button", /Rời nhóm/);
		await click("dialog button", "Chuyển quyền và rời nhóm");
		await find(() => byName("dialog h2", "Chưa thể rời nhóm"));
	},
	"owner-pick": async () => {
		await openInfo();
		await click("aside.info button", /Rời nhóm/);
		await click("dialog button", "Chuyển quyền và rời nhóm");
		await click("dialog button", "Chọn admin");
		await click("[role=radio]", /Minh/);
	},
	"add-contact": async () => {
		await click("button", "Thêm liên hệ");
		await type("dialog input[type=search]", "@thuha");
		await find(() => byName("dialog button", "Thêm vào danh bạ"));
	},
	link: async () => {
		await click(".bubble a", "https://docs.example.com/postgres/upgrade");
		await find(() => document.querySelector("dialog .url-box"));
	},
	"link-mismatch": async () => {
		await click(".bubble a", "hoandat.com/khuyen-mai");
		await find(() => document.querySelector("dialog .url-box"));
	},
	"add-failed": async () => {
		await openInfo();
		await click("aside.info button", /Thêm thành viên/);
		await type("dialog input[type=search]", "hoang");
		await click("dialog [role=checkbox]", /Hoàng Nam/);
		await click("dialog button", "Thêm 1 người");
		await click("dialog button", "Gửi link mời cho 1 người");
		await find(() => document.querySelector("dialog .why"));
	},
	emoji: async () => {
		await click("button", "Emoji");
		await type(".emoji-pop input", "cuoi");
		await find(() => document.querySelector(".emoji-pop .emoji-grid button"));
	},
	"emoji-reaction": async () => {
		await contextMenu(".messages .msg", "Dashboard ổn định.");
		await click(".react-picker button", "Thêm reaction");
		await find(() => document.querySelector(".ctx-layer .emoji-pop"));
	},
	reply: async () => {
		await contextMenu(".messages .msg", "Dashboard ổn định.");
		await click("[role=menuitem]", "Trả lời");
		await find(() => document.querySelector(".compose-bar"));
	},
	edit: async () => {
		await contextMenu(".messages .msg.mine", "Mục 3 ổn");
		await click("[role=menuitem]", "Sửa");
		await find(() => document.querySelector(".compose-bar"));
	},
	"list-menu": async () => {
		await contextMenu(".chat-rows li", "Dự án Hải Đăng");
		await click("[role=menuitem]", "Tắt tiếng");
		await find(() => byName("[role=menu]", "Tắt tiếng trong"));
	},
	profile: async () => {
		await openInfo();
		// The row's text starts with the avatar's initials.
		await find(() => byName("aside.info .member-row", /Lan Anh/));
		await click("aside.info .member-row", /Lan Anh/);
		await find(() => document.querySelector("dialog .contact-state"));
	},
};

const scenario = params.get("open");
const run = scenario === null ? undefined : SCENARIOS[scenario];
if (run !== undefined) {
	// Wait for the first screen, then click through; on failure the screenshot shows where it stopped.
	void find(() => document.querySelector(".app, .shell"))
		.then(run)
		.catch((err: unknown) => console.warn(String(err)))
		.then(() => new Promise((resolve) => setTimeout(resolve, 300)))
		.finally(() => void fetch("/__release"));
} else if (scenario !== null) {
	void fetch("/__release");
}
