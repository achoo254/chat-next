// What deleting the account does to the chat data, written once for the
// public deletion page (/delete-account). An account is deleted only at the
// IdP's account page, which tells the chat to erase it at once (ADR 0016);
// the server's rules: server/internal/privacy (DeleteIdPAccount, Erase).
import { brand } from "../brand.ts";

export const deletionTicks: Readonly<Record<"vi" | "en" | "zh-CN", readonly string[]>> = {
	vi: [
		`Tài khoản ${brand.domain} bị xoá ngay cùng dữ liệu của bạn trong mọi app của ${brand.domain}, gồm cả app chat. Không huỷ được.`,
		"Trong app chat: hồ sơ, username, danh bạ, người đã chặn, Cloud của tôi, cài đặt, các phiên đăng nhập và bot của bạn bị xoá; bạn rời mọi nhóm và kênh.",
		"Nhóm và kênh bạn làm chủ được chuyển cho người còn lại có vai trò cao nhất, cùng vai trò thì người vào sớm nhất; không còn ai thì nhóm hoặc kênh bị xoá.",
		'Tin bạn đã gửi trong chat của người khác vẫn còn, người gửi hiện là "Tài khoản đã xoá".',
	],
	en: [
		`Your ${brand.domain} account is deleted at once, with your data in every ${brand.domain} app, the chat app included. It cannot be undone.`,
		"In the chat app: your profile, username, contacts, blocked people, Cloud, settings, sessions and bots are deleted; you leave every group and channel.",
		"Groups and channels you own pass to the remaining person with the highest role, the earliest to join among equals; with nobody left, the group or channel is deleted.",
		'Messages you sent in other people\'s chats stay, from "Deleted account".',
	],
	"zh-CN": [
		`你的 ${brand.domain} 账号会立即被删除，连同你在 ${brand.domain} 所有应用中的数据，包括聊天应用。此操作无法撤销。`,
		"在聊天应用中：你的个人资料、用户名、联系人、已屏蔽的用户、我的云端、设置、所有会话和机器人都会被删除；你将退出所有群组和频道。",
		"你作为所有者的群组和频道会转给剩余成员中角色最高的人，角色相同则转给最早加入的人；若已无其他成员，该群组或频道会被删除。",
		"你在他人聊天中发送的消息会保留，发送者显示为“已删除的账号”。",
	],
};
