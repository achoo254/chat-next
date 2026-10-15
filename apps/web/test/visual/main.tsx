// Visual harness for render checks of the messaging UI: the real app and
// client core against the core's in-memory protocol server, in the browser.
// Test-only: never part of the production build. ?theme=dark|light forces a
// theme; the path picks the screen (/c/5001, /settings/privacy, ...);
// ?at=<screen> opens a screen by name (ids come from the seed, see SCREENS);
// ?open=<scenario> clicks through to a dialog or menu state (see SCENARIOS);
// an image on /__hold keeps the page's load event back until it is done (see
// vite.config.ts), so render checks capture the finished state. Every page
// then audits horizontal overflow (auditOverflow) and logs offenders as errors.
import { ChatType, MemberRole } from "@app/proto-ts/chats";
import { IncomingHookAuditAction, IncomingHookFormat } from "@app/proto-ts/integrations";
import { EntityType, IncomingHookStopReason } from "@app/proto-ts/messages";
import { openMemoryFactory } from "../../../../packages/platform-web/src/driver.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/app.tsx";
import "../../src/styles/fonts.css";
import "../../src/styles/tokens.css";
import "../../src/styles/app.css";
import { entity, seedDemo } from "../support/demo-data.ts";
import { fixtureConnector } from "../support/fake-chat.ts";
import { routerFetch } from "../support/router-fetch.ts";

const params = new URLSearchParams(window.location.search);
// Every page holds its load event until the scenario (if any) and the overflow audit ran.
const hold = new Image();
hold.alt = "";
hold.hidden = true;
hold.src = `/__hold?${Date.now()}`;
document.body.append(hold);
const theme = params.get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;

const demo = seedDemo();
const f = demo.fixture;
// The harness user is an operator, so the moderation queue renders (moderation.html#queue).
f.operator = true;
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
// A channel you own, with a long invite link (#chat-admin, info panel).
const announcements = f.createChat(ChatType.CHANNEL, "Thông báo vận hành hệ thống", [f.selfId, demo.ids.users.minh, demo.ids.users.ha, demo.ids.users.huy, demo.ids.users.lan], {
	myRole: MemberRole.OWNER,
	about: "Lịch bảo trì, sự cố và bản phát hành của các dịch vụ nội bộ: auth, chat, mail, lưu trữ. Chỉ admin đăng bài.",
});
f.setRole(announcements, f.selfId, MemberRole.OWNER);
f.setRole(announcements, demo.ids.users.minh, MemberRole.ADMIN);
f.send(f.selfId, announcements, "", { action: { kind: { case: "chatCreated", value: { title: "Thông báo vận hành hệ thống" } } } });
f.send(f.selfId, announcements, "Tối thứ Bảy 22:00 bảo trì cụm lưu trữ, dự kiến 30 phút.");
f.inviteLinks.set(announcements, [
	{
		$typeName: "app.v1.InviteLink",
		link: "https://chat.hoandat.com/join/V-puXq3hT9mZ2cLk8RbkVUp",
		creatorId: BigInt(f.selfId),
		expiresAt: 0n,
		usageLimit: 0,
		usageCount: 3,
		revoked: false,
	},
]);
// Three pinned messages in Vận hành hệ thống ("Tin ghim 3/3", #pin-message),
// a recalled message (#message-kinds) and a chip with four reactors (#rich-messages).
f.server.pin(demo.ids.ops, demo.ids.codeSeq, true);
f.server.pin(demo.ids.ops, demo.ids.mineSeq, true);
for (const user of [demo.ids.users.huy, demo.ids.users.lan, demo.ids.users.minh, demo.ids.users.ha]) f.react(user, demo.ids.ops, demo.ids.codeSeq, "🔥");
const recalledSeq = f.send(demo.ids.users.minh, demo.ids.ops, "Tin gửi nhầm");
f.server.deleteMessages(demo.ids.users.minh, demo.ids.ops, [recalledSeq]);
// Incoming webhooks (integrations.html): a group you administer with alert
// messages (fields, code blocks, URL buttons, one resolved in place) and its
// hooks in every state, with counters, failed requests and a log.
const alerts = f.createChat(ChatType.GROUP, "Cảnh báo hạ tầng", [f.selfId, demo.ids.users.minh, demo.ids.users.lan, demo.ids.users.huy], { myRole: MemberRole.ADMIN });
f.setRole(alerts, f.selfId, MemberRole.ADMIN);
f.send(demo.ids.users.lan, alerts, "Nhóm nhận cảnh báo tự động của hạ tầng.");
const disk =
	"Firing Ổ đĩa sắp đầy trên db-02.example.invalid\n🖥️ Máy chủ: db-02.example.invalid\n📊 Đã dùng: 94% (ngưỡng 90%)\n🕘 Bắt đầu: 09:42, 14/10\n🏷️ Nhãn: env=prod team=ops\ndf -h /var/lib/postgresql\npg_archivecleanup /var/lib/postgresql/wal \\\n  000000010000002A000000F3";
f.postIntegration(alerts, "Giám sát máy chủ", disk, {
	entities: [
		entity(EntityType.BOLD, disk, "Firing"),
		entity(EntityType.CODE, disk, "env=prod team=ops"),
		entity(EntityType.PRE, disk, "df -h /var/lib/postgresql", { language: "Kiểm tra nhanh" }),
		entity(EntityType.PRE, disk, "pg_archivecleanup /var/lib/postgresql/wal \\\n  000000010000002A000000F3", { language: "Dọn WAL đã lưu trữ" }),
	],
	buttons: [
		[
			{ text: "Mở runbook", url: "https://runbook.example.com/disk-full-with-a-rather-long-path-segment" },
			{ text: "Dashboard", url: "https://grafana.example.com/d/db" },
		],
		[{ text: "Tắt tiếng 1 giờ trên Alertmanager", url: "https://alertmanager.example.com/#/silences/new" }],
	],
});
const cpu = "Firing CPU cao trên lab-174\n📊 Giá trị: 93% trong 5 phút";
const cpuSeq = f.postIntegration(alerts, "Alertmanager prod", cpu, { entities: [entity(EntityType.BOLD, cpu, "Firing")] });
const cpuResolved = "Resolved CPU cao trên lab-174\n🕘 Thời gian: firing 09:42 → resolved 10:05";
f.editIntegration(alerts, cpuSeq, cpuResolved, true, [entity(EntityType.BOLD, cpuResolved, "Resolved")]);
f.postIntegration(alerts, "Jenkins build", "Build chat-server #318 thành công", { silent: true });

const hooks = f.integrations;
const grafana = hooks.seed(alerts, { name: "Grafana prod", format: IncomingHookFormat.GRAFANA, createdBy: demo.ids.users.huy, lastUsedAt: hooks.now - 300 });
const rotating = hooks.seed(alerts, { name: "Alertmanager prod", format: IncomingHookFormat.ALERTMANAGER, createdBy: demo.ids.users.lan, lastUsedAt: hooks.now - 60, graceLeft: 6 * 86_400 + 23 * 3600 });
const gitlab = hooks.seed(alerts, { name: "GitLab ops/deploy", format: IncomingHookFormat.GITLAB, createdBy: demo.ids.users.minh, lastUsedAt: hooks.now - 26 * 3600 });
hooks.autoDisable(gitlab);
hooks.seed(alerts, { name: "Jenkins build", format: IncomingHookFormat.NATIVE, silent: true, lastUsedAt: hooks.now - 120 });
// An admin turned a webhook off (#hook-disabled, right pane: the system line of a stopped webhook).
f.server.postService(alerts, demo.ids.users.lan, {
	kind: { case: "incomingHookStopped", value: { hookName: "Uptime Kuma", reason: IncomingHookStopReason.DISABLED } },
});
hooks.counters.set(grafana, {
	accepted: 1284,
	delivered: 1201,
	failures: [
		{ reason: "rate_limited", count: 3, lastAt: hooks.now - 900 },
		{ reason: "payload_too_large", count: 2, lastAt: hooks.now - 5400 },
		{ reason: "url_not_allowed", count: 1, lastAt: hooks.now - 30 * 3600 },
		{ reason: "invalid_json", count: 1, lastAt: hooks.now - 34 * 3600 },
	],
});
hooks.addDeadLetter(grafana, "invalid_json", "invalid character '}' looking for beginning of object key string", '{"status": "firing", "alerts": [}');
hooks.addDeadLetter(grafana, "url_not_allowed", "button url uses a scheme that is not allowed: ftp", '{"text": "Xem log", "buttons": [{"text": "Log", "url": "ftp://logs.example.invalid/very/long/path/that/keeps/going/and/going/without/any/break/at/all"}]}');
hooks.seedAudit(grafana, [
	{ actorId: demo.ids.users.huy, action: IncomingHookAuditAction.CREATED, detail: "grafana", ago: 9 * 86_400 },
	{ actorId: demo.ids.users.lan, action: IncomingHookAuditAction.SECRET_ROTATED, ago: 2 * 86_400 },
]);
hooks.seedAudit(rotating, [{ actorId: demo.ids.users.lan, action: IncomingHookAuditAction.SECRET_ROTATED, ago: 3600 }]);

// ?at= names a screen whose path holds an id the seed assigns.
const SCREENS: Record<string, string> = {
	ops: `/c/${demo.ids.ops}`,
	owned: `/c/${owned}`,
	forum: `/c/${demo.ids.forum}`,
	lan: `/c/${demo.ids.lanAnh}`,
	admin: `/c/${demo.ids.ops}/admin`,
	banned: `/c/${demo.ids.ops}/admin/banned`,
	contact: `/contacts/${demo.ids.users.lan}`,
	channel: `/c/${announcements}`,
	"channel-admin": `/c/${announcements}/admin`,
	bot: `/c/${demo.ids.bot}`,
	alerts: `/c/${alerts}`,
	hooks: `/c/${alerts}/admin/hooks`,
	"hook-new": `/c/${alerts}/admin/hooks/new`,
	hook: `/c/${alerts}/admin/hooks/${grafana}`,
	"hook-rotating": `/c/${alerts}/admin/hooks/${rotating}`,
	"hook-disabled": `/c/${alerts}/admin/hooks/${gitlab}`,
	report: "/moderation/20481",
	"report-actions": "/moderation/20481/actions",
};
const at = params.get("at");
const screenPath = at === null ? undefined : SCREENS[at];
if (screenPath !== undefined) window.history.replaceState(null, "", `${screenPath}${window.location.search}`);

const container = document.getElementById("root");
if (container === null) throw new Error("harness is missing #root");
createRoot(container).render(
	<StrictMode>
		<App
			rpcFetch={routerFetch((router) => f.routes(router))}
			messagingConnector={fixtureConnector(f, openMemoryFactory)}
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
	// The one-time URL after creating a webhook (#hook-created).
	"hook-created": async () => {
		await type("#root form input.input", "Uptime Kuma");
		await click("form button", "Tạo webhook");
		await find(() => document.querySelector("dialog .snippet"));
	},
	// Rotating the secret, then its one-time URL (#rotate).
	"hook-rotate": async () => {
		await click("button", "Xoay secret");
		await click("dialog button", "Xoay secret");
		await find(() => byName("dialog h2", /^URL mới của /));
	},
	// Editing a webhook's name, alert priority and silent sending (fields of #create-hook).
	"hook-edit": async () => {
		await click("button", "Sửa cài đặt");
		await find(() => byName("dialog h2", /^Sửa webhook /));
	},
	// The alert with fields, code blocks and buttons (#alert-message), scrolled to its top.
	"alert-message": async () => {
		const label = await find(() => byName(".messages .int-label", "Tích hợp: Giám sát máy chủ"));
		label.scrollIntoView({ block: "start" });
	},
	// A failed request opened with its body (#hook-stats).
	"dead-letter": async () => {
		const summary = await find(() => document.querySelector<HTMLElement>(".dead-list summary"));
		summary.click();
		summary.scrollIntoView({ block: "center" });
	},
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
		await click("aside.info button", /^Xem tất cả \d+ thành viên$/);
		await find(() => document.querySelector("dialog .member-list li"));
	},
	"remove-member": async () => {
		await openInfo();
		await click("aside.info button", /^Xem tất cả \d+ thành viên$/);
		await click("dialog button", "Thao tác với Minh");
		await click("[role=menuitem]", "Xoá khỏi nhóm");
		await find(() => byName("dialog h2", "Xoá Minh khỏi nhóm?"));
	},
	"owner-leave": async () => {
		await openInfo();
		await click("aside.info button", /Rời nhóm/);
		await find(() => byName("dialog h2", "Chưa thể rời nhóm"));
	},
	"owner-pick": async () => {
		await openInfo();
		await click("aside.info button", /Rời nhóm/);
		await click("dialog button", "Chọn phó nhóm");
		await click("[role=radio]", /Minh/);
	},
	"delete-group": async () => {
		await openInfo();
		await click("aside.info button", /Rời nhóm/);
		await click("dialog button", "Xoá nhóm");
		await find(() => document.querySelector("dialog .effects"));
	},
	"add-contact": async () => {
		await click("button", "Thêm vào danh bạ");
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
		await click("aside.info .quick-acts button", /Thêm thành viên/);
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
		await click(".react-picker button", "Chọn biểu cảm");
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
		await click("[role=menuitem]", "Tắt thông báo");
		await find(() => byName("[role=menu]", "Tắt thông báo trong"));
	},
	"list-menu-private": async () => {
		await contextMenu(".chat-rows li", "Quang Huy");
		await find(() => byName("[role=menuitem]", "Xoá chat"));
	},
	"delete-chat": async () => {
		await contextMenu(".chat-rows li", "Quang Huy");
		await click("[role=menuitem]", "Xoá chat");
		await find(() => byName("dialog h2", "Xoá chat với Quang Huy?"));
	},
	pin: async () => {
		await contextMenu(".messages .msg", "Dashboard ổn định.");
		await click("[role=menuitem]", "Ghim");
		await find(() => byName("dialog h2", "Ghim tin này?"));
	},
	recall: async () => {
		await contextMenu(".messages .msg.mine", "Mục 3 ổn");
		await click("[role=menuitem]", "Thu hồi");
		await find(() => byName("dialog h2", "Thu hồi tin nhắn?"));
	},
	"pinned-list": async () => {
		await click(".pinned button", "Tất cả tin ghim, 3 tin");
		await find(() => document.querySelector("dialog .pin-list li"));
	},
	"unpin-all": async () => {
		await click(".pinned button", "Tất cả tin ghim, 3 tin");
		await click("dialog button", "Bỏ ghim tất cả");
		await find(() => byName("dialog h2", "Bỏ ghim tất cả tin?"));
	},
	recalled: async () => {
		const placeholder = await find(() => document.querySelector<HTMLElement>(".messages .bubble.recalled"));
		// The list settles on the unread divider first; scroll once it has.
		await new Promise((resolve) => setTimeout(resolve, 600));
		placeholder.scrollIntoView({ block: "center" });
	},
	"reaction-chips": async () => {
		const chip = await find(() => byName(".messages .reaction", /^🔥 /));
		chip.scrollIntoView({ block: "center" });
	},
	reactors: async () => {
		const chip = await find(() => byName(".messages .reaction", "👍 Bạn, Minh, Lan Anh"));
		const rect = chip.getBoundingClientRect();
		chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 4, clientY: rect.top + 4 }));
		await find(() => document.querySelector("dialog .react-tabs"));
	},
	"quick-actions": async () => {
		const message = await find(() => [...document.querySelectorAll<HTMLElement>(".messages .msg")].find((m) => m.textContent?.includes("Dashboard ổn định.")));
		message.classList.add("show-actions");
		message.querySelector<HTMLElement>(".msg-actions")?.style.setProperty("opacity", "1");
	},
	search: async () => {
		await type(".list-head input[type=search]", "van hanh");
		await find(() => document.querySelector(".sx-results .hit mark"));
	},
	"new-group": async () => {
		await click("button", "Tạo chat mới");
		await click("dialog .quick button", "Tạo nhóm");
		await click("dialog [role=checkbox]", /Lan Anh/);
		await click("dialog [role=checkbox]", /Quang Huy/);
	},
	"group-with": async () => {
		await openInfo();
		await click("aside.info .quick-acts button", "Tạo nhóm");
		await find(() => document.querySelector("dialog .chip"));
	},
	"info-mute": async () => {
		await openInfo();
		await click("aside.info .quick-acts button", "Tắt thông báo");
		await find(() => byName("[role=menu]", "Tắt thông báo trong"));
	},
	"new-channel": async () => {
		await click("button", "Tạo chat mới");
		await click("dialog .quick button", "Tạo kênh");
		await find(() => byName("dialog h2", "Tạo kênh"));
	},
	"group-empty": async () => {
		await click("button", "Tạo chat mới");
		await click("dialog .quick button", "Tạo nhóm");
		await find(() => byName("dialog h2", "Tạo nhóm"));
		await type("dialog input[type=search]", "khongcoai");
		await find(() => document.querySelector("dialog .empty"));
	},
	profile: async () => {
		await openInfo();
		// The row's text starts with the avatar's initials.
		await find(() => byName("aside.info .member-row", /Lan Anh/));
		await click("aside.info .member-row", /Lan Anh/);
		await find(() => document.querySelector("dialog .contact-state"));
	},
};

// ------------------------------------------------------------- overflow audit

function describe(element: Element): string {
	const classes = [...element.classList].slice(0, 2).join(".");
	return `${element.tagName.toLowerCase()}${classes === "" ? "" : `.${classes}`}`;
}

/**
 * No horizontal scrolling anywhere: the document and every scroll container
 * must fit their content across. Each offender is a console error, which the
 * render check counts as an error.
 */
function auditOverflow(): void {
	const containers = [document.documentElement, ...document.body.querySelectorAll("*")].filter((element) => {
		if (element === document.documentElement) return true;
		const overflowX = getComputedStyle(element).overflowX;
		return overflowX === "auto" || overflowX === "scroll";
	});
	for (const element of containers) {
		if (element.scrollWidth > element.clientWidth + 1) {
			console.error(`harness: horizontal overflow in ${describe(element)}: ${element.scrollWidth}px content in ${element.clientWidth}px`);
		}
	}
}

const scenario = params.get("open");
const run = scenario === null ? undefined : SCENARIOS[scenario];
if (scenario !== null && run === undefined) console.warn(`harness: unknown scenario ${scenario}`);
// Wait for the first screen, then click through; on failure the screenshot shows where it stopped.
void find(() => document.querySelector(".app, .shell, .welcome"))
	.then(run ?? (() => Promise.resolve()))
	.catch((err: unknown) => console.warn(String(err)))
	// Let late content (messages, member lists) render before the audit and the capture.
	.then(() => new Promise((resolve) => setTimeout(resolve, 800)))
	.then(auditOverflow)
	.finally(() => void fetch("/__release"));
