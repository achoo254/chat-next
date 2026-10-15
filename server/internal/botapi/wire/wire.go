// Package wire holds the JSON shapes of the Bot API (spec/bot-api/openapi.yaml)
// and their mapping from and to the protobuf model. Updates are serialized
// with it when the bot consumer cuts them from the outbox, and responses
// when a method answers, so both always agree with the spec.
package wire

import (
	"fmt"

	appv1 "app.local/server/gen/app/v1"
)

// User is a user or bot as a bot sees it.
type User struct {
	ID       int64  `json:"id"`
	IsBot    bool   `json:"is_bot"`
	Name     string `json:"name"`
	Username string `json:"username,omitempty"`
}

// Chat is a chat the bot is in.
type Chat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
	// Groups and channels.
	Title       string `json:"title,omitempty"`
	About       string `json:"about,omitempty"`
	MemberCount int32  `json:"member_count,omitempty"`
	Forum       bool   `json:"forum,omitempty"`
	// Private chats: the user the bot talks to.
	User *User `json:"user,omitempty"`
}

// Entity is a formatted span of a text (ADR 0004: UTF-16 offsets).
type Entity struct {
	Type     string `json:"type"`
	Offset   int32  `json:"offset"`
	Length   int32  `json:"length"`
	URL      string `json:"url,omitempty"`
	UserID   int64  `json:"user_id,omitempty"`
	Language string `json:"language,omitempty"`
}

// InlineButton is a button of an inline keyboard: callback_data or url.
type InlineButton struct {
	Text         string  `json:"text"`
	CallbackData *string `json:"callback_data,omitempty"`
	URL          *string `json:"url,omitempty"`
}

// KeyboardButton is a button of a reply keyboard; pressing it sends its
// text.
type KeyboardButton struct {
	Text string `json:"text"`
}

// ReplyMarkup is exactly one of an inline keyboard, a reply keyboard or the
// removal of the reply keyboard.
type ReplyMarkup struct {
	InlineKeyboard [][]InlineButton   `json:"inline_keyboard,omitempty"`
	Keyboard       [][]KeyboardButton `json:"keyboard,omitempty"`
	Resize         bool               `json:"resize,omitempty"`
	OneTime        bool               `json:"one_time,omitempty"`
	Placeholder    string             `json:"placeholder,omitempty"`
	RemoveKeyboard bool               `json:"remove_keyboard,omitempty"`
	// Keyboard or removal only for mentioned users and the author of the
	// replied-to message.
	Selective bool `json:"selective,omitempty"`
}

// Media summarizes the file of a media message (file methods come later).
type Media struct {
	Kind     string `json:"kind"`
	MimeType string `json:"mime_type,omitempty"`
	Size     int64  `json:"size,omitempty"`
	FileName string `json:"file_name,omitempty"`
	Width    int32  `json:"width,omitempty"`
	Height   int32  `json:"height,omitempty"`
	// Milliseconds.
	Duration int32 `json:"duration,omitempty"`
}

// Action is a service message.
type Action struct {
	Type    string  `json:"type"`
	UserIDs []int64 `json:"user_ids,omitempty"`
	Title   string  `json:"title,omitempty"`
	Seq     int64   `json:"seq,omitempty"`
}

// ForwardFrom is the origin of a forwarded message.
type ForwardFrom struct {
	UserID int64  `json:"user_id,omitempty"`
	ChatID int64  `json:"chat_id,omitempty"`
	Name   string `json:"name,omitempty"`
	Date   int64  `json:"date"`
}

// Message is a message as the bot sees it; text is the caption of media.
type Message struct {
	Chat        Chat         `json:"chat"`
	Seq         int64        `json:"seq"`
	From        *User        `json:"from,omitempty"`
	Date        int64        `json:"date"`
	TopicID     int64        `json:"topic_id,omitempty"`
	Text        string       `json:"text,omitempty"`
	Entities    []Entity     `json:"entities,omitempty"`
	ReplyToSeq  int64        `json:"reply_to_seq,omitempty"`
	EditDate    int64        `json:"edit_date,omitempty"`
	ReplyMarkup *ReplyMarkup `json:"reply_markup,omitempty"`
	Media       *Media       `json:"media,omitempty"`
	Action      *Action      `json:"action,omitempty"`
	ForwardFrom *ForwardFrom `json:"forward_from,omitempty"`
	// Label of the incoming webhook that posted it (from is then absent).
	IntegrationLabel string `json:"integration_label,omitempty"`
	// Echoed to the sender only.
	RandomID int64 `json:"random_id,omitempty"`
}

// Callback is a press of one of the bot's callback buttons.
type Callback struct {
	ID      string  `json:"id"`
	From    User    `json:"from"`
	Message Message `json:"message"`
	Data    string  `json:"data"`
}

var entityNames = map[appv1.EntityType]string{
	appv1.EntityType_ENTITY_TYPE_BOLD:         "bold",
	appv1.EntityType_ENTITY_TYPE_ITALIC:       "italic",
	appv1.EntityType_ENTITY_TYPE_UNDERLINE:    "underline",
	appv1.EntityType_ENTITY_TYPE_STRIKE:       "strike",
	appv1.EntityType_ENTITY_TYPE_SPOILER:      "spoiler",
	appv1.EntityType_ENTITY_TYPE_CODE:         "code",
	appv1.EntityType_ENTITY_TYPE_PRE:          "pre",
	appv1.EntityType_ENTITY_TYPE_TEXT_LINK:    "text_link",
	appv1.EntityType_ENTITY_TYPE_MENTION:      "mention",
	appv1.EntityType_ENTITY_TYPE_MENTION_NAME: "mention_name",
	appv1.EntityType_ENTITY_TYPE_HASHTAG:      "hashtag",
	appv1.EntityType_ENTITY_TYPE_URL:          "url",
	appv1.EntityType_ENTITY_TYPE_EMAIL:        "email",
	appv1.EntityType_ENTITY_TYPE_BOT_COMMAND:  "bot_command",
}

var entityTypes = func() map[string]appv1.EntityType {
	out := make(map[string]appv1.EntityType, len(entityNames))
	for t, name := range entityNames {
		out[name] = t
	}
	return out
}()

var chatTypeNames = map[appv1.ChatType]string{
	appv1.ChatType_CHAT_TYPE_PRIVATE: "private",
	appv1.ChatType_CHAT_TYPE_GROUP:   "group",
	appv1.ChatType_CHAT_TYPE_CHANNEL: "channel",
}

var mediaKindNames = map[appv1.MediaKind]string{
	appv1.MediaKind_MEDIA_KIND_PHOTO:    "photo",
	appv1.MediaKind_MEDIA_KIND_VIDEO:    "video",
	appv1.MediaKind_MEDIA_KIND_AUDIO:    "audio",
	appv1.MediaKind_MEDIA_KIND_VOICE:    "voice",
	appv1.MediaKind_MEDIA_KIND_DOCUMENT: "document",
}

// Users indexes rendered users by id.
type Users map[int64]*appv1.User

// IndexUsers builds the index.
func IndexUsers(list []*appv1.User) Users {
	out := make(Users, len(list))
	for _, u := range list {
		out[u.GetId()] = u
	}
	return out
}

// FromUser maps a user.
func FromUser(u *appv1.User) User {
	return User{ID: u.GetId(), IsBot: u.GetIsBot(), Name: u.GetName(), Username: u.GetUsername()}
}

func (us Users) user(id int64) *User {
	if id == 0 {
		return nil
	}
	if u, ok := us[id]; ok {
		w := FromUser(u)
		return &w
	}
	return &User{ID: id}
}

// FromChat maps a chat; users must hold the peer of a private chat.
func FromChat(c *appv1.Chat, users Users) Chat {
	out := Chat{ID: c.GetId(), Type: chatTypeNames[c.GetType()]}
	if out.Type == "" {
		out.Type = "unknown"
	}
	if c.GetType() == appv1.ChatType_CHAT_TYPE_PRIVATE {
		out.User = users.user(c.GetPeerUserId())
		return out
	}
	out.Title, out.About, out.MemberCount, out.Forum = c.GetTitle(), c.GetAbout(), c.GetMemberCount(), c.GetForum()
	return out
}

// FromMessage maps a message of chat; users must hold its author and the
// users it references.
func FromMessage(m *appv1.Message, chat Chat, users Users) Message {
	out := Message{
		Chat: chat, Seq: m.GetSeq(), From: users.user(m.GetFromId()), Date: m.GetDate(), TopicID: m.GetTopicId(),
		Text: m.GetText(), ReplyToSeq: m.GetReplyToSeq(), EditDate: m.GetEditDate(),
		IntegrationLabel: m.GetIntegrationLabel(), RandomID: m.GetRandomId(),
	}
	for _, e := range m.GetEntities() {
		out.Entities = append(out.Entities, Entity{
			Type: entityNames[e.GetType()], Offset: e.GetOffset(), Length: e.GetLength(),
			URL: e.GetUrl(), UserID: e.GetUserId(), Language: e.GetLanguage(),
		})
	}
	out.ReplyMarkup = fromMarkup(m.GetReplyMarkup())
	if md := m.GetMedia(); md != nil {
		out.Media = &Media{
			Kind: mediaKindNames[md.GetKind()], MimeType: md.GetMimeType(), Size: md.GetSize(), FileName: md.GetFileName(),
			Width: md.GetWidth(), Height: md.GetHeight(), Duration: md.GetDuration(),
		}
	}
	if a := m.GetAction(); a != nil {
		out.Action = fromAction(a)
	}
	if f := m.GetForwardFrom(); f != nil {
		out.ForwardFrom = &ForwardFrom{UserID: f.GetFromUserId(), ChatID: f.GetFromChatId(), Name: f.GetFromName(), Date: f.GetDate()}
	}
	return out
}

func fromAction(a *appv1.MessageAction) *Action {
	switch k := a.GetKind().(type) {
	case *appv1.MessageAction_ChatCreated:
		return &Action{Type: "chat_created", Title: k.ChatCreated.GetTitle()}
	case *appv1.MessageAction_MembersAdded:
		return &Action{Type: "members_added", UserIDs: k.MembersAdded.GetUserIds()}
	case *appv1.MessageAction_MemberLeft:
		return &Action{Type: "member_left"}
	case *appv1.MessageAction_MemberRemoved:
		return &Action{Type: "member_removed", UserIDs: []int64{k.MemberRemoved.GetUserId()}}
	case *appv1.MessageAction_TitleChanged:
		return &Action{Type: "title_changed", Title: k.TitleChanged.GetTitle()}
	case *appv1.MessageAction_PhotoChanged:
		return &Action{Type: "photo_changed"}
	case *appv1.MessageAction_PhotoRemoved:
		return &Action{Type: "photo_removed"}
	case *appv1.MessageAction_MessagePinned:
		return &Action{Type: "message_pinned", Seq: k.MessagePinned.GetSeq()}
	case *appv1.MessageAction_JoinedByInvite:
		return &Action{Type: "joined_by_invite"}
	default:
		return &Action{Type: "other"}
	}
}

func fromMarkup(m *appv1.ReplyMarkup) *ReplyMarkup {
	switch k := m.GetKind().(type) {
	case *appv1.ReplyMarkup_InlineKeyboard:
		out := &ReplyMarkup{}
		for _, row := range k.InlineKeyboard.GetRows() {
			var r []InlineButton
			for _, b := range row.GetButtons() {
				btn := InlineButton{Text: b.GetText()}
				switch a := b.GetAction().(type) {
				case *appv1.InlineButton_CallbackData:
					data := string(a.CallbackData)
					btn.CallbackData = &data
				case *appv1.InlineButton_Url:
					url := a.Url
					btn.URL = &url
				default:
				}
				r = append(r, btn)
			}
			out.InlineKeyboard = append(out.InlineKeyboard, r)
		}
		return out
	case *appv1.ReplyMarkup_Keyboard:
		kb := k.Keyboard
		out := &ReplyMarkup{Resize: kb.GetResize(), OneTime: kb.GetOneTime(), Selective: kb.GetSelective(), Placeholder: kb.GetPlaceholder()}
		for _, row := range kb.GetRows() {
			var r []KeyboardButton
			for _, b := range row.GetButtons() {
				r = append(r, KeyboardButton{Text: b.GetText()})
			}
			out.Keyboard = append(out.Keyboard, r)
		}
		return out
	case *appv1.ReplyMarkup_Remove:
		return &ReplyMarkup{RemoveKeyboard: true, Selective: k.Remove.GetSelective()}
	default:
		return nil
	}
}

// ToEntities maps request entities; an unknown type is an error.
func ToEntities(list []Entity) ([]*appv1.MessageEntity, error) {
	out := make([]*appv1.MessageEntity, 0, len(list))
	for i, e := range list {
		t, ok := entityTypes[e.Type]
		if !ok {
			return nil, fmt.Errorf("entities[%d]: unknown type %q", i, e.Type)
		}
		out = append(out, &appv1.MessageEntity{
			Type: t, Offset: e.Offset, Length: e.Length, Url: e.URL, UserId: e.UserID, Language: e.Language,
		})
	}
	return out, nil
}

// ToMarkup maps a request keyboard; the message core validates limits and
// URLs.
func ToMarkup(m *ReplyMarkup) (*appv1.ReplyMarkup, error) {
	if m == nil {
		return nil, nil
	}
	kinds := 0
	for _, set := range []bool{len(m.InlineKeyboard) > 0, len(m.Keyboard) > 0, m.RemoveKeyboard} {
		if set {
			kinds++
		}
	}
	if kinds != 1 {
		return nil, fmt.Errorf("reply_markup needs exactly one of inline_keyboard, keyboard and remove_keyboard")
	}
	switch {
	case len(m.InlineKeyboard) > 0:
		kb := &appv1.InlineKeyboard{}
		for i, row := range m.InlineKeyboard {
			r := &appv1.InlineKeyboardRow{}
			for j, b := range row {
				btn := &appv1.InlineButton{Text: b.Text}
				switch {
				case b.CallbackData != nil && b.URL == nil:
					btn.Action = &appv1.InlineButton_CallbackData{CallbackData: []byte(*b.CallbackData)}
				case b.URL != nil && b.CallbackData == nil:
					btn.Action = &appv1.InlineButton_Url{Url: *b.URL}
				default:
					return nil, fmt.Errorf("inline_keyboard[%d][%d] needs exactly one of callback_data and url", i, j)
				}
				r.Buttons = append(r.Buttons, btn)
			}
			kb.Rows = append(kb.Rows, r)
		}
		return &appv1.ReplyMarkup{Kind: &appv1.ReplyMarkup_InlineKeyboard{InlineKeyboard: kb}}, nil
	case len(m.Keyboard) > 0:
		kb := &appv1.ReplyKeyboard{Resize: m.Resize, OneTime: m.OneTime, Selective: m.Selective, Placeholder: m.Placeholder}
		for _, row := range m.Keyboard {
			r := &appv1.KeyboardRow{}
			for _, b := range row {
				r.Buttons = append(r.Buttons, &appv1.KeyboardButton{Text: b.Text})
			}
			kb.Rows = append(kb.Rows, r)
		}
		return &appv1.ReplyMarkup{Kind: &appv1.ReplyMarkup_Keyboard{Keyboard: kb}}, nil
	default:
		return &appv1.ReplyMarkup{Kind: &appv1.ReplyMarkup_Remove{Remove: &appv1.ReplyKeyboardRemove{Selective: m.Selective}}}, nil
	}
}
