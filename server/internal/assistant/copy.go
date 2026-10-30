package assistant

import (
	"fmt"
	"strings"

	"app.local/server/internal/botadmin"
	"app.local/server/internal/botapi/wire"
	"app.local/server/internal/brand"
	"app.local/server/internal/locale"
)

// The assistant speaks short and friendly, to each user in the language
// their app shows (chat.UserLocale): Vietnamese, English or Simplified
// Chinese, with the terms of the web app's copy (apps/web/src/messaging/copy).
// Its account (name, description, command menu) is one for everyone and
// stays Vietnamese; the commands keep their Vietnamese names in every
// language. Product names come from the brand (never hard-coded).

// Username is the assistant's fixed username in every tenant; the bot
// holding it keeps anyone else from taking it.
const Username = "tro_ly_bot"

// Commands of the assistant's menu.
const (
	cmdStart    = "start"
	cmdGuide    = "huongdan"
	cmdFeedback = "gopy"
)

// Callback data of the welcome buttons.
const (
	dataGuide = "guide"
	dataIdea  = "idea"
	dataBug   = "bug"
)

// copyText is everything the assistant says to a user in one language.
type copyText struct {
	welcome, guide   string
	askIdea, askBug  string
	thanks, textOnly string
	unknownCommand   string
	replyPrefix      string
	// replySettingsPrefix quotes (%s) feedback sent from Settings.
	replySettingsPrefix string
	// Moderation notices.
	modHead, modWarn, modDeleted, modBanned string
	modLockedUntil, modLocked, modReason    string
	// dateLayout writes the end of a lock (time.Format, Vietnam time).
	dateLayout string
	// Welcome buttons.
	buttonGuide, buttonIdea, buttonBug string
}

// newCopies builds the assistant's text in every language from the brand.
func newCopies(b brand.Names) map[string]copyText {
	// The settings prefix is a format itself: a % in the app name stays literal.
	app := strings.ReplaceAll(b.AppName, "%", "%%")
	return map[string]copyText{
		locale.VI: {
			welcome: fmt.Sprintf("Chào mừng bạn đến với %s! Mình là trợ lý, giúp bạn làm quen nhanh:\n\n"+
				"• Cloud của tôi: lưu tin, ảnh, file cho riêng bạn, mở được trên mọi thiết bị.\n"+
				"• Tạo nhóm và mời: bấm + rồi chọn Tạo nhóm, tạo xong gửi link mời cho đồng đội.\n"+
				"• Tìm không dấu: gõ \"chuc mung\" vẫn ra \"chúc mừng\".\n"+
				"• Làm bot: vào Cài đặt > Developer Console để tạo bot của riêng bạn.\n\n"+
				"Có góp ý hay gặp lỗi, cứ nhắn cho mình nhé.", b.AppName),
			guide: "Hướng dẫn nhanh\n\n" +
				"1. Nhắn tin: bấm + rồi Tìm người theo username hoặc email, mở chat và gửi.\n" +
				"2. Nhóm: bấm + rồi Tạo nhóm, thêm người hoặc gửi link mời. Quản trị viên đặt quyền cho thành viên.\n" +
				"3. Cloud của tôi: chuyển tin vào đây để lưu lại, luôn nằm đầu danh sách.\n" +
				"4. Tìm kiếm: ô Tìm kiếm tìm cả chat lẫn tin nhắn, không cần gõ dấu.\n" +
				"5. Bot: Cài đặt > Developer Console để tạo bot và lấy token cho Bot API.\n\n" +
				"Gõ /gopy để gửi góp ý cho đội ngũ.",
			askIdea:             "Bạn muốn góp ý điều gì? Cứ nhắn cho mình, đội ngũ sẽ đọc hết.",
			askBug:              "Bạn gặp lỗi gì? Mô tả giúp mình: bạn đang làm gì và điều gì xảy ra.",
			thanks:              "Cảm ơn bạn! Đội ngũ đã nhận được góp ý.",
			textOnly:            "Mình chỉ nhận góp ý bằng chữ, bạn nhắn lại giúp mình nhé.",
			unknownCommand:      "Mình chưa hiểu lệnh này. Gõ /huongdan để xem hướng dẫn hoặc /gopy để gửi góp ý.",
			replyPrefix:         fmt.Sprintf("Phản hồi từ đội ngũ %s:\n\n", b.AppName),
			replySettingsPrefix: "Phản hồi từ đội ngũ " + app + " cho góp ý của bạn trong Cài đặt:\n«%s»\n\n",
			modHead:             fmt.Sprintf("Thông báo từ đội kiểm duyệt %s.", b.AppName),
			modWarn:             "Bạn bị cảnh cáo vì vi phạm quy định sử dụng.",
			modDeleted:          "Tin nhắn vi phạm của bạn đã bị gỡ.",
			modBanned:           "Bạn đã bị cấm khỏi chat nơi có tin vi phạm.",
			modLockedUntil:      "Tài khoản chat của bạn bị khoá tới %s.",
			modLocked:           "Tài khoản chat của bạn bị khoá cho tới khi đội kiểm duyệt gỡ.",
			modReason:           "Lý do: %s",
			dateLayout:          "15:04 02/01/2006",
			buttonGuide:         "Hướng dẫn nhanh",
			buttonIdea:          "Gửi góp ý",
			buttonBug:           "Báo lỗi",
		},
		locale.EN: {
			welcome: fmt.Sprintf("Welcome to %s! I'm the assistant, here to help you get started:\n\n"+
				"• My Cloud: keep messages, photos and files just for you, open on every device.\n"+
				"• Create a group and invite: tap + and choose New group, then send the invite link to your teammates.\n"+
				"• Search without Vietnamese accents: typing \"chuc mung\" still finds \"chúc mừng\".\n"+
				"• Build a bot: go to Settings > Developer Console to create your own bot.\n\n"+
				"Have an idea or found a bug? Just message me.", b.AppName),
			guide: "Quick guide\n\n" +
				"1. Messages: tap + then Find people by username or email, open the chat and send.\n" +
				"2. Groups: tap + then New group, add people or send an invite link. Admins set what members can do.\n" +
				"3. My Cloud: forward messages here to keep them; it always stays at the top of the list.\n" +
				"4. Search: the Search box finds both chats and messages, no accents needed.\n" +
				"5. Bots: Settings > Developer Console to create a bot and get its Bot API token.\n\n" +
				"Type /gopy to send feedback to the team.",
			askIdea:             "What would you like to suggest? Just message me, the team reads everything.",
			askBug:              "What went wrong? Tell me what you were doing and what happened.",
			thanks:              "Thank you! The team has received your feedback.",
			textOnly:            "I can only take feedback as text, please send it again in words.",
			unknownCommand:      "I don't know this command. Type /huongdan for the guide or /gopy to send feedback.",
			replyPrefix:         fmt.Sprintf("Reply from the %s team:\n\n", b.AppName),
			replySettingsPrefix: "Reply from the " + app + " team to the feedback you sent in Settings:\n“%s”\n\n",
			modHead:             fmt.Sprintf("Notice from the %s moderation team.", b.AppName),
			modWarn:             "You have been warned for breaking the rules of use.",
			modDeleted:          "Your message that broke the rules has been removed.",
			modBanned:           "You have been banned from the chat where the message was posted.",
			modLockedUntil:      "Your chat account is locked until %s (Vietnam time).",
			modLocked:           "Your chat account is locked until the moderation team unlocks it.",
			modReason:           "Reason: %s",
			dateLayout:          "15:04, 2 Jan 2006",
			buttonGuide:         "Quick guide",
			buttonIdea:          "Send feedback",
			buttonBug:           "Report a bug",
		},
		locale.ZhCN: {
			welcome: fmt.Sprintf("欢迎使用 %s！我是助手，帮你快速上手：\n\n"+
				"• 我的云端：只属于你的消息、照片和文件，在任何设备上都能打开。\n"+
				"• 创建群组并邀请：点 + 选择“新建群组”，创建后把邀请链接发给队友。\n"+
				"• 搜索无需越南语声调：输入 \"chuc mung\" 也能找到 \"chúc mừng\"。\n"+
				"• 创建机器人：前往 设置 > 开发者控制台 创建你自己的机器人。\n\n"+
				"有建议或遇到问题，随时给我发消息。", b.AppName),
			guide: "快速指南\n\n" +
				"1. 发消息：点 + 然后“查找用户”，按用户名或邮箱查找，打开聊天即可发送。\n" +
				"2. 群组：点 + 然后“新建群组”，添加成员或发送邀请链接。管理员可以设置成员权限。\n" +
				"3. 我的云端：把消息转发到这里保存，它始终位于列表顶部。\n" +
				"4. 搜索：搜索框可同时搜索聊天和消息，无需输入声调。\n" +
				"5. 机器人：设置 > 开发者控制台，创建机器人并获取 Bot API 的 token。\n\n" +
				"输入 /gopy 向团队发送建议。",
			askIdea:             "你想提什么建议？直接发给我，团队会逐条阅读。",
			askBug:              "遇到了什么问题？请描述你当时在做什么，以及发生了什么。",
			thanks:              "谢谢！团队已收到你的反馈。",
			textOnly:            "我只接收文字反馈，请用文字重新发送。",
			unknownCommand:      "我不认识这个命令。输入 /huongdan 查看指南，或输入 /gopy 发送建议。",
			replyPrefix:         fmt.Sprintf("%s 团队的回复：\n\n", b.AppName),
			replySettingsPrefix: app + " 团队对你在设置中提交的反馈的回复：\n“%s”\n\n",
			modHead:             fmt.Sprintf("来自 %s 审核团队的通知。", b.AppName),
			modWarn:             "你因违反使用规定而受到警告。",
			modDeleted:          "你的违规消息已被删除。",
			modBanned:           "你已被违规消息所在的聊天封禁。",
			modLockedUntil:      "你的聊天账号已被锁定至 %s（越南时间）。",
			modLocked:           "你的聊天账号已被锁定，直至审核团队解除。",
			modReason:           "原因：%s",
			dateLayout:          "2006-01-02 15:04",
			buttonGuide:         "快速指南",
			buttonIdea:          "发送建议",
			buttonBug:           "报告问题",
		},
	}
}

// systemBot is the assistant's account, one for every user (Vietnamese).
func systemBot(b brand.Names) botadmin.SystemBot {
	return botadmin.SystemBot{
		Username:    Username,
		Name:        b.ShortName + " Trợ lý",
		Description: fmt.Sprintf("Trợ lý chính thức của %s: hướng dẫn nhanh cách dùng app và nhận góp ý, báo lỗi của bạn.", b.AppName),
		About:       "Hướng dẫn dùng app, nhận góp ý và báo lỗi",
		Commands:    commands(),
	}
}

// commands is the assistant's command menu.
func commands() []botadmin.CommandSet {
	return []botadmin.CommandSet{{Scope: botadmin.ScopeDefault, Commands: []botadmin.Command{
		{Command: cmdStart, Description: "Bắt đầu và xem giới thiệu"},
		{Command: cmdGuide, Description: "Hướng dẫn nhanh"},
		{Command: cmdFeedback, Description: "Gửi góp ý cho đội ngũ"},
	}}}
}

// welcomeKeyboard: the guide, then "send feedback" and "report a bug".
func welcomeKeyboard(c copyText) *wire.ReplyMarkup {
	button := func(text, data string) wire.InlineButton {
		return wire.InlineButton{Text: text, CallbackData: &data}
	}
	return &wire.ReplyMarkup{InlineKeyboard: [][]wire.InlineButton{
		{button(c.buttonGuide, dataGuide)},
		{button(c.buttonIdea, dataIdea), button(c.buttonBug, dataBug)},
	}}
}
