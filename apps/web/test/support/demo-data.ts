// Chats and messages modelled on mockups/chat.html (#app, #rich-messages,
// #topics), seeded into the core's in-memory server. Test and harness only.
import { ChatType, MemberRole } from "@app/proto-ts/chats";
import { EntityType } from "@app/proto-ts/messages";
import { ChatFixture, type FixtureBackendData, type FixtureTopic } from "./fake-chat.ts";

/** Entity for the first occurrence of `needle` in `text` (UTF-16 offsets). */
export function entity(type: EntityType, text: string, needle: string, extra: { url?: string; language?: string; userId?: bigint } = {}) {
	const offset = text.indexOf(needle);
	if (offset < 0) throw new Error(`"${needle}" not in "${text}"`);
	return { type, offset, length: needle.length, ...extra };
}

export interface Demo {
	readonly fixture: ChatFixture;
	/** Fixture data for the features that have no RPC yet. */
	readonly data: FixtureBackendData;
	readonly ids: {
		readonly ops: number;
		readonly lanAnh: number;
		readonly forum: number;
		readonly bot: number;
		readonly mobile: number;
		readonly huy: number;
		readonly channel: number;
		readonly users: Readonly<Record<"huy" | "lan" | "minh" | "ha" | "ngoc" | "ducAnh" | "deployBot", number>>;
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
	f.server.react(lan, ops, upgradeSeq, "👍");
	f.server.react(minh, ops, upgradeSeq, "👍");
	f.server.react(me, ops, upgradeSeq, "👍");
	f.server.react(huy, ops, upgradeSeq, "👀");
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
	f.server.react(huy, ops, docsSeq, "🎉");
	f.send(lan, ops, "Replica đã bắt kịp, độ trễ dưới 1 giây.", { replyToSeq: BigInt(codeSeq), editDate: BigInt(Math.floor(Date.now() / 1000)), editVersion: 1 });
	const mentionText = "@ductrung xem giúp mục 3 trong checklist nhé, mình cần chốt trước 10:00.";
	const mention = f.send(huy, ops, mentionText, { entities: [entity(EntityType.MENTION, mentionText, "@ductrung")] });
	const mineSeq = f.send(me, ops, "Mục 3 ổn, extension đã lên bản mới.", { replyToSeq: BigInt(mention) });
	f.server.readHistory(me, ops, mineSeq);
	f.readers.set(`${ops}:${mineSeq}`, [huy, lan]);
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
	f.server.react(ha, forum, f4, "👍");
	f.send(ducAnh, forum, "PR phân trang lịch sử đã merge", { topicId: 4n });
	f.send(ngoc, forum, "Thứ Sáu họp tổng kết lúc 16:00", { topicId: 1n });
	f.mentions(forum, 1);
	f.topics.set(forum, [
		topic({ id: 1, title: "Chung", iconColor: 0x8e8e93, pinned: true, unreadCount: 1, creatorId: ngoc }),
		topic({ id: 2, title: "Thông báo", iconColor: 0xffd67e, pinned: true, closed: true, creatorId: huy }),
		topic({ id: 12, title: "Thiết kế", iconColor: 0xcb86db, unreadCount: 3, creatorId: ngoc }),
		topic({ id: 4, title: "Backend API", iconColor: 0x6fb9f0, unreadCount: 2, creatorId: ducAnh }),
		topic({ id: 5, title: "Phát hành 1.3", iconColor: 0x8eee98, unreadCount: 4, creatorId: minh }),
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
	f.inviteChecks.set("teammobile", { title: "Team Mobile", type: ChatType.GROUP, memberCount: 24, memberOf: 0 });
	const data: FixtureBackendData = {
		reactors: new Map([[`${ops}:${upgradeSeq}:👍`, [huy, lan, minh]]]),
		muted: new Set([mobile]),
		pinnedDialogs: new Set([ops]),
		blocked: [
			{ id: 9001, name: "Nhận quà 24h", username: "nhanqua24h", isBot: false, blockedAt: now - 86_400 },
			{ id: 9002, name: "Crypto Signal", username: "cryptosignal_bot", isBot: true, blockedAt: now - 1_000_000 },
		],
		moderation: {
			scope: "hoandat.com",
			rows: [
				{ id: "R-20481", object: "message", title: "Tin của @nhanqua24h", subtitle: "Chúc mừng 50 bạn may mắn nhận iPhone 16…", reason: "scam", reports: 13, status: "open", reviewer: "", latestAt: now - 1800 },
				{ id: "R-20477", object: "user", title: "Nhận quà 24h", subtitle: "@nhanqua24h", reason: "spam", reports: 9, status: "open", reviewer: "Minh", latestAt: now - 2400 },
				{ id: "R-20410", object: "message", title: "Tin của @binhtv", subtitle: "Đe doạ trong nhóm Bóng đá chiều T5", reason: "violence", reports: 2, status: "handled", reviewer: "", latestAt: now - 90_000 },
			],
			details: new Map([
				[
					"R-20481",
					{
						row: { id: "R-20481", object: "message", title: "Tin của @nhanqua24h", subtitle: "Chúc mừng 50 bạn may mắn nhận iPhone 16…", reason: "scam", reports: 13, status: "open", reviewer: "", latestAt: now - 1800 },
						context: [
							{ seq: 41, fromName: "Trần Hải", text: "Có ai biết chỗ bán tai nghe chính hãng không?", date: now - 2400, reported: false },
							{ seq: 42, fromName: "Nhận quà 24h", text: "Chúc mừng 50 bạn may mắn nhận iPhone 16. Bấm nhan-qua24h.top/nhan và nhập mã đăng nhập để nhận.", date: now - 2000, reported: true },
							{ seq: 43, fromName: "Mai Phương", text: "Link này lừa đảo đấy mọi người ơi.", date: now - 1900, reported: false },
						],
						reasons: [
							{ reason: "scam", count: 9 },
							{ reason: "spam", count: 4 },
						],
						notes: ["Link giả trang đăng nhập Google, đừng bấm."],
						history: [{ action: "Cảnh cáo", by: "Quang Huy", at: now - 50_000, note: "Spam vào nhóm" }],
					},
				],
			]),
		},
	};
	return {
		fixture: f,
		data,
		ids: {
			ops,
			lanAnh,
			forum,
			bot,
			mobile,
			huy: huyChat,
			channel,
			users: { huy, lan, minh, ha, ngoc, ducAnh, deployBot },
			checklistSeq,
			opsFirstSeq,
			codeSeq,
			mineSeq,
		},
	};
}
