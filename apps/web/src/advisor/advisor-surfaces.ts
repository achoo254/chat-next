// The places in the app a copy can be made and Advisor can be asked from. A
// service that wants Advisor on its screens registers one surface (once, at
// module level) and declares its scope with useAdvisorScope: nothing in
// Advisor's bubble, store or the machine changes for it.
//
// A surface says: its id (the `screen` or `panel` its scope declares), how the
// place is called in the user's words (per language, Vietnamese required), and
// the keys of the extra context it may send (`fields`). A scope's fields that
// the surface did not list are dropped before anything leaves the page, and a
// field's value never leaves when it looks like a secret. Never put an id, a
// name or a secret of the screen in a field: it goes to an AI.
import type { Locale } from "../i18n/locales.ts";

export interface AdvisorSurface {
	/** The `screen` (or `panel`) the surface's scopes declare. */
	readonly id: string;
	/** The place in the user's words ("Quản lý mã nguồn"); a language that is missing shows the Vietnamese one. */
	readonly label: Readonly<{ vi: string } & Partial<Record<Exclude<Locale, "vi">, string>>>;
	/** The keys of the context fields it may send; none when it sends none. */
	readonly fields?: readonly string[];
}

/** Most fields one copy sends, and the longest key: the machine refuses more (AdvisorContext.fields). */
export const MAX_FIELDS = 8;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const SURFACE_ID = /^[a-z][a-z0-9_-]{0,31}$/;

const surfaces = new Map<string, AdvisorSurface>();

/** Registers a surface; registering the same id again replaces it (a screen module loaded twice). */
export function registerAdvisorSurface(surface: AdvisorSurface): void {
	if (!SURFACE_ID.test(surface.id)) throw new Error(`advisor surface id "${surface.id}" is not a name`);
	for (const key of surface.fields ?? []) {
		if (!FIELD_KEY.test(key)) throw new Error(`advisor surface "${surface.id}": field "${key}" is not a name`);
	}
	if ((surface.fields?.length ?? 0) > MAX_FIELDS) throw new Error(`advisor surface "${surface.id}": more than ${MAX_FIELDS} fields`);
	surfaces.set(surface.id, surface);
}

/** The surface a copy was made on: the panel's when it has one, else the screen's. */
export function surfaceOf(panel: string, screen: string): AdvisorSurface | undefined {
	return surfaces.get(panel) ?? surfaces.get(screen);
}

/** How the place is called in `locale`; "" for a place nobody registered. */
export function surfaceLabel(panel: string, screen: string, locale: Locale): string {
	const surface = surfaceOf(panel, screen);
	if (surface === undefined) return "";
	return (locale === "vi" ? undefined : surface.label[locale]) ?? surface.label.vi;
}

/** The fields of a copy that its surface lists and that are well formed; the rest never leave the page. */
export function allowedFields(panel: string, screen: string, fields: Readonly<Record<string, string>>): Record<string, string> {
	const allowed = new Set(surfaceOf(panel, screen)?.fields ?? []);
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (allowed.has(key) && Object.keys(out).length < MAX_FIELDS) out[key] = value;
	}
	return out;
}

// The places Advisor has always known.
registerAdvisorSurface({ id: "chat", label: { vi: "một tin nhắn chat", en: "a chat message", "zh-CN": "一条聊天消息" } });
registerAdvisorSurface({ id: "contacts", label: { vi: "danh bạ", en: "contacts", "zh-CN": "通讯录" } });
registerAdvisorSurface({ id: "bot", label: { vi: "một bot", en: "a bot", "zh-CN": "一个机器人" } });
registerAdvisorSurface({ id: "session", label: { vi: "phiên", en: "session", "zh-CN": "会话" }, fields: ["ai"] });
registerAdvisorSurface({ id: "scm", label: { vi: "Quản lý mã nguồn", en: "Source Control", "zh-CN": "源代码管理" } });
registerAdvisorSurface({ id: "terminal", label: { vi: "terminal", en: "terminal", "zh-CN": "终端" } });
registerAdvisorSurface({ id: "machine", label: { vi: "máy", en: "machine", "zh-CN": "机器" } });
registerAdvisorSurface({ id: "other", label: { vi: "ứng dụng", en: "the app", "zh-CN": "应用" } });
