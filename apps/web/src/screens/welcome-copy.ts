// Copy of the signed-out pages (welcome, /login): one heading and one value
// line beside the sign-in card, then the features. Loads with those pages,
// not at a signed-in start.
import { brand } from "../brand.ts";
import type { Locale } from "../i18n/i18n.tsx";

export interface WelcomeCopy {
	readonly eyebrow: string;
	readonly title: string;
	readonly lede: string;
	readonly signInTitle: string;
	readonly signInBody: string;
	readonly featuresTitle: string;
	readonly features: Readonly<Record<"sync" | "search" | "bots", { readonly title: string; readonly body: string }>>;
}

export const WELCOME_COPY: Readonly<Record<Locale, WelcomeCopy>> = {
	vi: {
		eyebrow: `${brand.appName} · ${brand.domain}`,
		title: "Nhắn tin nhanh trên mọi thiết bị",
		lede: "Chat riêng và nhóm, gửi ảnh, file và tin thoại, đồng bộ giữa web, điện thoại và máy tính.",
		signInTitle: `Đăng nhập vào ${brand.appName}`,
		signInBody: `Một tài khoản cho ${brand.appName} và mọi app của ${brand.domain}.`,
		featuresTitle: "Tính năng",
		features: {
			sync: {
				title: "Đồng bộ trên mọi thiết bị",
				body: "Tin nhắn hiện ngay trên web, điện thoại và máy tính. Tin gửi lúc mất mạng tự đi khi có mạng lại.",
			},
			search: {
				title: "Tìm lại tin cũ",
				body: "Gõ vài chữ, có dấu hay không dấu, là thấy tin cũ trong mọi cuộc trò chuyện.",
			},
			bots: {
				title: "Bot và Mini App",
				body: "Dùng bot và Mini App ngay trong cuộc trò chuyện, hoặc tự viết bot bằng Bot API.",
			},
		},
	},
	en: {
		eyebrow: `${brand.appName} · ${brand.domain}`,
		title: "Fast messaging on every device",
		lede: "One-to-one and group chats with photos, files and voice messages, synced across web, phone and computer.",
		signInTitle: `Sign in to ${brand.appName}`,
		signInBody: `One account for ${brand.appName} and every ${brand.domain} app.`,
		featuresTitle: "Features",
		features: {
			sync: {
				title: "In sync on every device",
				body: "Messages show up at once on the web, your phone and your computer. Messages sent offline go out when you are back online.",
			},
			search: {
				title: "Find old messages",
				body: "Type a few words, with or without Vietnamese accents, to find old messages in every chat.",
			},
			bots: {
				title: "Bots and Mini Apps",
				body: "Use bots and Mini Apps right in the chat, or write your own bot with the Bot API.",
			},
		},
	},
};
