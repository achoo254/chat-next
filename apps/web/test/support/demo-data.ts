// Chats and messages modelled on mockups/chat.html (#app, #rich-messages,
// #topics), seeded into the core's in-memory server. Test and harness only.
import { ChatType, HistoryVisibility, MemberRole } from "@app/proto-ts/chats";
import { EntityType } from "@app/proto-ts/messages";
import { FeedbackKind, FeedbackStatus, ModerationAction, ReportStatus, ReportTargetKind } from "@app/proto-ts/moderation";
import { ReportReason } from "@app/proto-ts/users";
import { ChatFixture, type FixtureTopic } from "./fake-chat.ts";

/** Entity for the first occurrence of `needle` in `text` (UTF-16 offsets). */
export function entity(type: EntityType, text: string, needle: string, extra: { url?: string; language?: string; userId?: bigint } = {}) {
	const offset = text.indexOf(needle);
	if (offset < 0) throw new Error(`"${needle}" not in "${text}"`);
	return { type, offset, length: needle.length, ...extra };
}

export interface Demo {
	readonly fixture: ChatFixture;
	readonly ids: {
		readonly ops: number;
		readonly lanAnh: number;
		readonly forum: number;
		readonly bot: number;
		readonly mobile: number;
		readonly huy: number;
		readonly channel: number;
		readonly users: Readonly<Record<"huy" | "lan" | "minh" | "ha" | "ngoc" | "ducAnh" | "deployBot" | "khoa" | "announcer", number>>;
		readonly checklistSeq: number;
		readonly opsFirstSeq: number;
		readonly codeSeq: number;
		readonly mineSeq: number;
	};
}

function topic(partial: Partial<FixtureTopic> & Pick<FixtureTopic, "id" | "title">): FixtureTopic {
	return { iconColor: 0, creatorId: 0, pinned: false, closed: false, hidden: false, unreadCount: 0, ...partial };
}

export function seedDemo(): Demo {
	const f = new ChatFixture();
	const me = f.selfId;
	const huy = f.addUser("Quang Huy", { username: "quanghuy", bio: "Trực vận hành hệ thống." });
	const lan = f.addUser("Lan Anh", { username: "lananh", bio: "Thiết kế sản phẩm. Hỏi về giao diện cứ nhắn." });
	const minh = f.addUser("Minh", { username: "minh" });
	const ha = f.addUser("Thu Hà", { username: "thuha" });
	const ngoc = f.addUser("Bảo Ngọc", { username: "baongoc" });
	const ducAnh = f.addUser("Đức Anh", { username: "ducanh" });
	const deployBot = f.addUser("Deploy Bot", { username: "deploy_bot", isBot: true });
	const announcer = f.addUser("Ban truyền thông", { username: "truyenthong" });
	const khoa = f.addUser("Phạm Khoa", { username: "khoapham" });

	// Group with rich messages (#app, #message-kinds, #rich-messages).
	const ops = f.createChat(ChatType.GROUP, "Vận hành hệ thống", [me, huy, lan, minh, deployBot], {
		myRole: MemberRole.ADMIN,
		about: "Kênh trực sự cố của đội vận hành. Cảnh báo tự động vào đây.",
	});
	f.setRole(ops, huy, MemberRole.OWNER);
	f.setRole(ops, lan, MemberRole.ADMIN);
	f.setRole(ops, me, MemberRole.ADMIN);
	const opsFirstSeq = f.send(lan, ops, "", { action: { kind: { case: "membersAdded", value: { userIds: [BigInt(deployBot)] } } } });
	const upgrade = "Sáng nay mình sẽ nâng cấp postgres-17 trên box lab. Ai đang test thì báo @lananh nhé. Hướng dẫn ở wiki vận hành.";
	const upgradeSeq = f.send(huy, ops, upgrade, {
		entities: [
			entity(EntityType.CODE, upgrade, "postgres-17"),
			entity(EntityType.MENTION, upgrade, "@lananh"),
			entity(EntityType.TEXT_LINK, upgrade, "wiki vận hành", { url: "https://wiki.hoandat.com/van-hanh" }),
		],
	});
	f.react(lan, ops, upgradeSeq, "👍");
	f.react(minh, ops, upgradeSeq, "👍");
	f.react(me, ops, upgradeSeq, "👍");
	f.react(huy, ops, upgradeSeq, "👀");
	const code = "Lịch nâng cấp postgres-17 trên box lab: bắt đầu 09:30, không phải 09:00. Mã phòng họp: 482 913. Sau khi xong chạy make migrate.\npg_upgrade -b /usr/lib/postgresql/16/bin \\\n  -B /usr/lib/postgresql/17/bin --check";
	const codeSeq = f.send(huy, ops, code, {
		entities: [
			entity(EntityType.BOLD, code, "Lịch nâng cấp"),
			entity(EntityType.ITALIC, code, "postgres-17"),
			entity(EntityType.UNDERLINE, code, "09:30"),
			entity(EntityType.STRIKE, code, "09:00"),
			entity(EntityType.SPOILER, code, "482 913"),
			entity(EntityType.CODE, code, "make migrate"),
			entity(EntityType.PRE, code, "pg_upgrade -b /usr/lib/postgresql/16/bin \\\n  -B /usr/lib/postgresql/17/bin --check", { language: "bash" }),
		],
	});
	const checklistSeq = f.send(minh, ops, "Checklist sau nâng cấp: vacuum analyze, kiểm tra extension, so số dòng các bảng chính.", {
		forwardFrom: { fromUserId: BigInt(lan), fromName: "Lan Anh", date: 1_760_400_000n },
	});
	const docs = "Tài liệu nâng cấp ở đây: https://docs.example.com/postgres/upgrade";
	const preview = {
		url: "https://docs.example.com/postgres/upgrade",
		siteName: "docs.example.com",
		title: "Nâng cấp Postgres gần như không gián đoạn",
		description: "Từng bước: kiểm tra tương thích, chạy pg_upgrade với --link, xác minh replica trước khi chuyển lưu lượng.",
	};
	f.previews.push(preview);
	const docsSeq = f.send(huy, ops, docs, { entities: [entity(EntityType.URL, docs, "https://docs.example.com/postgres/upgrade")], linkPreview: preview });
	f.react(huy, ops, docsSeq, "🎉");
	f.send(lan, ops, "Replica đã bắt kịp, độ trễ dưới 1 giây.", { replyToSeq: BigInt(codeSeq), editDate: BigInt(Math.floor(Date.now() / 1000)), editVersion: 1 });
	const mentionText = "@ductrung xem giúp mục 3 trong checklist nhé, mình cần chốt trước 10:00.";
	const mention = f.send(huy, ops, mentionText, { entities: [entity(EntityType.MENTION, mentionText, "@ductrung")] });
	const mineSeq = f.send(me, ops, "Mục 3 ổn, extension đã lên bản mới.", { replyToSeq: BigInt(mention) });
	f.server.readHistory(me, ops, mineSeq);
	f.readers.set(`${ops}:${mineSeq}`, [huy, lan]);
	f.readDates.set(`${ops}:${mineSeq}`, new Map([[huy, Math.floor(Date.now() / 1000) - 600], [lan, Math.floor(Date.now() / 1000) - 300]]));
	// Removed with a ban earlier (#banned).
	f.bans.set(ops, [{ userId: khoa, by: me, at: 1_759_017_600 }]);
	f.server.readHistory(huy, ops, mineSeq);
	f.server.pin(ops, checklistSeq, true);
	f.send(huy, ops, "Xong rồi, mọi người kiểm tra giúp mình.");
	f.send(lan, ops, "Dashboard ổn định.");

	// Private chat with an unread message.
	const lanAnh = f.createChat(ChatType.PRIVATE, "", [me, lan]);
	f.send(lan, lanAnh, "Mình gửi file thiết kế rồi nhé");

	// Group with topics (#topics, #topic-states).
	const forum = f.createChat(ChatType.GROUP, "Dự án Hải Đăng", [me, ha, ngoc, ducAnh, minh, huy], { myRole: MemberRole.ADMIN, forum: true });
	f.setRole(forum, ngoc, MemberRole.OWNER);
	const DESIGN = 12n;
	f.send(huy, forum, "Lịch phát hành 1.3 đã chốt", { topicId: 2n });
	f.send(minh, forum, "Checklist QA còn 2 mục", { topicId: 5n });
	const f1 = f.send(ngoc, forum, "Tuần này chốt màn đăng nhập và danh sách chủ đề nhé.", { topicId: DESIGN });
	f.server.readHistory(me, forum, f1);
	const sketch = "Mình đẩy bản phác màn đăng nhập lên rồi: files.example.com/haidang/login-v3";
	f.send(ha, forum, sketch, { topicId: DESIGN, entities: [entity(EntityType.URL, sketch, "files.example.com/haidang/login-v3")] });
	const askText = "@ductrung bạn xem giúp phần chữ của nút đăng nhập bằng domain khác.";
	f.send(ha, forum, askText, { topicId: DESIGN, replyToSeq: BigInt(f1), entities: [entity(EntityType.MENTION, askText, "@ductrung")] });
	const f4 = f.send(ducAnh, forum, "Ổn, API trả đủ trường cho màn này rồi.", { topicId: DESIGN });
	f.react(ha, forum, f4, "👍");
	f.send(ducAnh, forum, "PR phân trang lịch sử đã merge", { topicId: 4n });
	f.send(ngoc, forum, "Thứ Sáu họp tổng kết lúc 16:00", { topicId: 1n });
	f.mentions(forum, 1);
	f.topics.set(forum, [
		topic({ id: 1, title: "Chung", iconColor: 0x8e8e93, pinned: true, unreadCount: 1, creatorId: ngoc }),
		topic({ id: 2, title: "Thông báo", iconColor: 0xffd67e, pinned: true, closed: true, creatorId: huy, icon: "megaphone", messageCount: 14 }),
		topic({ id: 12, title: "Thiết kế", iconColor: 0xcb86db, unreadCount: 3, unreadMentions: 1, creatorId: ngoc, icon: "edit", messageCount: 4 }),
		topic({ id: 4, title: "Backend API", iconColor: 0x6fb9f0, unreadCount: 2, creatorId: ducAnh, icon: "code", messageCount: 1 }),
		topic({ id: 5, title: "Phát hành 1.3", iconColor: 0x8eee98, unreadCount: 4, creatorId: minh, icon: "flag", messageCount: 1 }),
		topic({ id: 9, title: "Tuyển dụng", hidden: true, creatorId: ngoc }),
	]);

	// Bot, muted group, private chat with a draft, channel.
	const bot = f.createChat(ChatType.PRIVATE, "", [me, deployBot]);
	f.send(deployBot, bot, "Bản 2.4.1 đã lên staging. Đẩy lên production không?");
	f.server.readHistory(me, bot, 1);
	const mobile = f.createChat(ChatType.GROUP, "Team Mobile", [me, minh, huy]);
	f.send(minh, mobile, "Build iOS lỗi ký số, đang xem");
	const huyChat = f.createChat(ChatType.PRIVATE, "", [me, huy]);
	f.send(huy, huyChat, "Chiều nay review PR màn đăng nhập nhé?");
	const ok = f.send(me, huyChat, "Ok, mình xem lúc 15:00.");
	f.server.readHistory(huy, huyChat, ok);
	const channel = f.createChat(ChatType.CHANNEL, "Thông báo hoandat", [me, announcer], { about: "Lịch bảo trì và bản phát hành." });
	const post = "Bảo trì auth.hoandat.com tối thứ Bảy 22:00–23:00. Phiên đang đăng nhập không bị ảnh hưởng.";
	f.send(announcer, channel, post, { entities: [entity(EntityType.BOLD, post, "Bảo trì auth.hoandat.com")] });
	f.server.readHistory(me, channel, 1);

	const now = Math.floor(Date.now() / 1000);
	f.inviteChecks.set("teammobile", {
		title: "Team Mobile",
		type: ChatType.GROUP,
		memberCount: 24,
		memberOf: 0,
		members: [minh, huy, ha],
		history: HistoryVisibility.SHARED,
	});
	f.inviteChecks.set("bannedlink", { title: "Team Mobile", type: ChatType.GROUP, memberCount: 24, memberOf: 0, banned: true });
	// Contacts the user added (#contacts); Thu Hà shares a group but is not one.
	for (const id of [ngoc, lan, huy]) f.contacts.add(id);
	// Pinned on top and muted, as set on another session (#list-states).
	f.pinChats([ops]);
	f.mute(mobile, 2_147_483_647);
	// People blocked earlier (settings.html#blocked).
	const spammer = f.addUser("Nhận quà 24h", { username: "nhanqua24h" });
	const signals = f.addUser("Crypto Signal", { username: "cryptosignal_bot", isBot: true });
	f.blocked.add(spammer);
	f.blockedAt.set(spammer, now - 86_400);
	f.blocked.add(signals);
	f.blockedAt.set(signals, now - 1_000_000);
	// The moderation queue an operator sees (moderation.html#queue).
	const deals = f.createChat(ChatType.GROUP, "Hội săn deal công nghệ", [me, minh, spammer]);
	f.send(minh, deals, "Có ai biết chỗ bán tai nghe chính hãng không?");
	const scam = f.send(spammer, deals, "Chúc mừng 50 bạn may mắn nhận iPhone 16. Bấm nhan-qua24h.top/nhan và nhập mã đăng nhập để nhận.");
	f.send(minh, deals, "Link này lừa đảo đấy mọi người ơi.");
	f.server.readHistory(me, deals, scam + 1);
	f.reportQueue.push(
		{ id: 20481, kind: ReportTargetKind.MESSAGES, reporterId: minh, targetUserId: 0, targetChatId: deals, seqs: [scam], reason: ReportReason.SCAM, comment: "Link giả trang đăng nhập, đừng bấm.", status: ReportStatus.OPEN, createdAt: now - 1800, actions: [], note: "" },
		{ id: 20477, kind: ReportTargetKind.USER, reporterId: lan, targetUserId: spammer, targetChatId: 0, seqs: [], reason: ReportReason.SPAM, comment: "", status: ReportStatus.OPEN, createdAt: now - 2400, actions: [], note: "" },
		{ id: 20410, kind: ReportTargetKind.CHAT, reporterId: huy, targetUserId: 0, targetChatId: channel, seqs: [], reason: ReportReason.VIOLENCE, comment: "", status: ReportStatus.RESOLVED, createdAt: now - 90_000, actions: [ModerationAction.DELETE_MESSAGES], note: "Đã gỡ bài đe doạ" },
	);
	f.feedbackQueue.push(
		{ id: 3, userId: lan, kind: FeedbackKind.BUG, text: "Gửi ảnh trong nhóm bị treo ở 99%.", status: FeedbackStatus.OPEN, createdAt: now - 600, handledBy: 0, replyText: "" },
		{ id: 2, userId: minh, kind: FeedbackKind.IDEA, text: "Cho mình chọn chế độ tối theo giờ nhé.", status: FeedbackStatus.OPEN, createdAt: now - 1200, handledBy: 0, replyText: "" },
		{ id: 1, userId: huy, kind: FeedbackKind.IDEA, text: "Nút gửi hơi nhỏ trên điện thoại.", status: FeedbackStatus.HANDLED, createdAt: now - 90_000, handledBy: f.selfId, replyText: "Đã sửa, bạn tải lại trang nhé." },
	);
	return {
		fixture: f,
		ids: {
			ops,
			lanAnh,
			forum,
			bot,
			mobile,
			huy: huyChat,
			channel,
			users: { huy, lan, minh, ha, ngoc, ducAnh, deployBot, khoa, announcer },
			checklistSeq,
			opsFirstSeq,
			codeSeq,
			mineSeq,
		},
	};
}
