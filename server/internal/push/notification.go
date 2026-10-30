package push

import (
	"encoding/json"
	"strconv"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/chat"
	"app.local/server/internal/webpush"
)

// Push message settings.
const (
	// messageTTL is how long a push service keeps a message for a device
	// that is offline.
	messageTTL = 24 * time.Hour
	// PadTo pads payloads (webpush.SenderOptions.PadTo), so their size
	// reveals less about the message.
	PadTo = 128
)

// copyText is the server-written text of notifications, per locale.
type copyText struct {
	hidden, photo, video, audio, voice, file string
}

var copies = map[string]copyText{
	LocaleVI:   {hidden: "Bạn có tin nhắn mới", photo: "Ảnh", video: "Video", audio: "Âm thanh", voice: "Tin nhắn thoại", file: "Tệp"},
	LocaleEN:   {hidden: "You have a new message", photo: "Photo", video: "Video", audio: "Audio", voice: "Voice message", file: "File"},
	LocaleZhCN: {hidden: "你有一条新消息", photo: "照片", video: "视频", audio: "音频", voice: "语音消息", file: "文件"},
}

// Payload is the JSON the service worker receives (apps/web/src/sw).
type Payload struct {
	// ChatID is below 2^53 (ADR 0001).
	ChatID int64  `json:"chat_id"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	// Tag groups notifications: one per chat, as the in-app ones
	// ("chat:<id>").
	Tag string `json:"tag"`
	// URL is the app path the notification opens.
	URL    string `json:"url"`
	Silent bool   `json:"silent"`
	// Timestamp is when the message was sent, in Unix milliseconds.
	Timestamp int64 `json:"ts"`
}

// notification is the push message of m for t.
func (s *Service) notification(m chat.PushMessage, t chat.PushTarget) webpush.Message {
	text, ok := copies[t.Locale]
	if !ok {
		text = copies[LocaleVI]
	}
	id := strconv.FormatInt(m.ChatID, 10)
	p := Payload{ChatID: m.ChatID, Tag: "chat:" + id, URL: "/c/" + id, Silent: t.Silent, Timestamp: m.At.UnixMilli()}
	if t.Preview {
		p.Title, p.Body = shownText(m, text)
	} else {
		p.Title, p.Body = s.cfg.AppName, text.hidden
	}
	// Plain JSON of short strings: Marshal cannot fail, and the texts are
	// cut (chat.PushMessage.Text) well below webpush.PayloadMax.
	body, _ := json.Marshal(p)
	urgency := webpush.UrgencyNormal
	if m.ChatType == "private" {
		urgency = webpush.UrgencyHigh
	}
	return webpush.Message{Payload: body, TTL: messageTTL, Urgency: urgency, Topic: "chat" + id}
}

// shownText is the title and body of a notification that shows the
// message, as the in-app notification writes them: the chat title (the
// sender in a private chat), and in groups and channels the sender before
// the text.
func shownText(m chat.PushMessage, text copyText) (string, string) {
	title := m.ChatTitle
	if title == "" {
		title = m.SenderName
	}
	body := m.Text
	if body == "" {
		body = mediaLabel(m, text)
	}
	if m.ChatType != "private" && m.SenderName != "" {
		body = m.SenderName + ": " + body
	}
	return title, body
}

func mediaLabel(m chat.PushMessage, text copyText) string {
	switch m.MediaKind {
	case appv1.MediaKind_MEDIA_KIND_PHOTO:
		return text.photo
	case appv1.MediaKind_MEDIA_KIND_VIDEO:
		return text.video
	case appv1.MediaKind_MEDIA_KIND_AUDIO:
		if m.FileName != "" {
			return m.FileName
		}
		return text.audio
	case appv1.MediaKind_MEDIA_KIND_VOICE:
		return text.voice
	case appv1.MediaKind_MEDIA_KIND_DOCUMENT:
		if m.FileName != "" {
			return m.FileName
		}
		return text.file
	default:
		return text.hidden
	}
}
