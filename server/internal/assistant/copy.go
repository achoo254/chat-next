package assistant

import (
	"fmt"

	"app.local/server/internal/botadmin"
	"app.local/server/internal/botapi/wire"
	"app.local/server/internal/brand"
)

// The assistant speaks Vietnamese, short and friendly. Product names come
// from the brand (never hard-coded).

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

// copyText is everything the assistant says, built once from the brand.
type copyText struct {
	name, description, about string
	welcome, guide           string
	askIdea, askBug          string
	thanks, textOnly         string
	unknownCommand           string
	replyPrefix              string
	// Moderation notices.
	modHead, modWarn, modDeleted, modBanned string
	modLockedUntil, modLocked, modReason    string
}

func newCopy(b brand.Names) copyText {
	return copyText{
		name:        b.ShortName + " Trợ lý",
		description: fmt.Sprintf("Trợ lý chính thức của %s: hướng dẫn nhanh cách dùng app và nhận góp ý, báo lỗi của bạn.", b.AppName),
		about:       "Hướng dẫn dùng app, nhận góp ý và báo lỗi",
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
		askIdea:        "Bạn muốn góp ý điều gì? Cứ nhắn cho mình, đội ngũ sẽ đọc hết.",
		askBug:         "Bạn gặp lỗi gì? Mô tả giúp mình: bạn đang làm gì và điều gì xảy ra.",
		thanks:         "Cảm ơn bạn! Đội ngũ đã nhận được góp ý.",
		textOnly:       "Mình chỉ nhận góp ý bằng chữ, bạn nhắn lại giúp mình nhé.",
		unknownCommand: "Mình chưa hiểu lệnh này. Gõ /huongdan để xem hướng dẫn hoặc /gopy để gửi góp ý.",
		replyPrefix:    fmt.Sprintf("Phản hồi từ đội ngũ %s:\n\n", b.AppName),
		modHead:        fmt.Sprintf("Thông báo từ đội kiểm duyệt %s.", b.AppName),
		modWarn:        "Bạn bị cảnh cáo vì vi phạm quy định sử dụng.",
		modDeleted:     "Tin nhắn vi phạm của bạn đã bị gỡ.",
		modBanned:      "Bạn đã bị cấm khỏi chat nơi có tin vi phạm.",
		modLockedUntil: "Tài khoản chat của bạn bị khoá tới %s.",
		modLocked:      "Tài khoản chat của bạn bị khoá cho tới khi đội kiểm duyệt gỡ.",
		modReason:      "Lý do: %s",
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

// welcomeKeyboard: "Hướng dẫn nhanh", then "Gửi góp ý" and "Báo lỗi".
func welcomeKeyboard() *wire.ReplyMarkup {
	button := func(text, data string) wire.InlineButton {
		return wire.InlineButton{Text: text, CallbackData: &data}
	}
	return &wire.ReplyMarkup{InlineKeyboard: [][]wire.InlineButton{
		{button("Hướng dẫn nhanh", dataGuide)},
		{button("Gửi góp ý", dataIdea), button("Báo lỗi", dataBug)},
	}}
}
