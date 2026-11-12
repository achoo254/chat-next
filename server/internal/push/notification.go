package push

import (
	"encoding/json"
	"fmt"
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
	// machineTTL is how long a push service keeps a machine's "needs you"
	// push: a request older than that has likely been answered or expired.
	machineTTL = time.Hour
	// devicePairedTTL is how long a push service keeps a "new device
	// paired" push: the owner should learn of it even a day later.
	devicePairedTTL = 24 * time.Hour
	// usageHintTTL is how long a push service keeps a usage hint push: the
	// hint is for a session still running, which the agent counts as one
	// with a call in the last 30 minutes.
	usageHintTTL = 30 * time.Minute
)

// copyText is the server-written text of notifications, per locale.
type copyText struct {
	hidden, photo, video, audio, voice, file string
	// Machine pushes (fmt formats): the machine's name, and for
	// machinePending also the number of waiting requests.
	machineApproval, machineQuestion, machinePending, devicePaired string
	// usageHint names the machine only (fmt format).
	usageHint string
}

var copies = map[string]copyText{
	LocaleVI: {hidden: "Bạn có tin nhắn mới", photo: "Ảnh", video: "Video", audio: "Âm thanh", voice: "Tin nhắn thoại", file: "Tệp",
		machineApproval: "Claude trên %s cần bạn duyệt", machineQuestion: "Claude trên %s cần bạn trả lời",
		machinePending: "Claude trên %s có %d việc cần bạn", devicePaired: "Một thiết bị mới vừa ghép với %s",
		usageHint: "Có gợi ý dùng AI tiết kiệm hơn cho một phiên trên %s"},
	LocaleEN: {hidden: "You have a new message", photo: "Photo", video: "Video", audio: "Audio", voice: "Voice message", file: "File",
		machineApproval: "Claude on %s needs your approval", machineQuestion: "Claude on %s needs your answer",
		machinePending: "Claude on %s has %d requests waiting for you", devicePaired: "A new device was just paired with %s",
		usageHint: "A tip to use the AI more efficiently in a session on %s"},
	LocaleZhCN: {hidden: "你有一条新消息", photo: "照片", video: "视频", audio: "音频", voice: "语音消息", file: "文件",
		machineApproval: "%s 上的 Claude 需要你批准", machineQuestion: "%s 上的 Claude 需要你回答",
		machinePending: "%s 上的 Claude 有 %d 个请求等你处理", devicePaired: "有新设备刚刚与 %s 配对",
		usageHint: "%s 上的一个会话有更省用量的建议"},
}

// Payload is the JSON the service worker receives (apps/web/src/sw). A
// message push has ChatID and no Kind; a machine push (ADR 0013) has Kind
// KindMachine, MachineID and SessionID instead of ChatID.
type Payload struct {
	// Kind is "" for a message and KindMachine for a machine that needs the
	// user.
	Kind string `json:"kind,omitempty"`
	// ChatID is below 2^53 (ADR 0001).
	ChatID int64 `json:"chat_id,omitempty"`
	// MachineID and SessionID: the machine and its waiting thread ("" when
	// the agent did not say).
	MachineID int64  `json:"machine_id,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	// Tag groups notifications: one per chat, as the in-app ones
	// ("chat:<id>"), one per machine ("machine:<id>"), and apart from it
	// one per machine for a newly paired device ("machine-paired:<id>") and
	// for a usage hint ("machine-usage:<id>"), so none replaces another.
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

// KindMachine is Payload.Kind of a machine's "needs you" push.
const KindMachine = "machine"

// Kinds of MachineNotice.
const (
	MachineApproval = "approval"
	MachineQuestion = "question"
	// MachineDevicePaired: a new device was just paired with the machine.
	// The notice names the machine only, never the device.
	MachineDevicePaired = "device_paired"
	// MachineUsageHint: a running session went past a usage rule. The notice
	// names the machine only, never the session, rule or numbers.
	MachineUsageHint = "usage_hint"
)

// MachineNotice is what a machine's push says (ADR 0013): the machine's name
// and the kind of request or event, never content.
type MachineNotice struct {
	MachineID   int64
	MachineName string
	// Kind is MachineApproval, MachineQuestion, MachineDevicePaired or
	// MachineUsageHint.
	Kind string
	// Pending is how many requests wait on the machine; above 1 the push
	// gives the count instead of the kind.
	Pending   int
	SessionID string
	At        time.Time
}

// machineNotification is the push message of n in locale.
func (s *Service) machineNotification(n MachineNotice, locale string) webpush.Message {
	text, ok := copies[locale]
	if !ok {
		text = copies[LocaleVI]
	}
	id := strconv.FormatInt(n.MachineID, 10)
	if n.Kind == MachineDevicePaired {
		p := Payload{Kind: KindMachine, MachineID: n.MachineID, Title: s.cfg.AppName,
			Body: fmt.Sprintf(text.devicePaired, n.MachineName), Tag: "machine-paired:" + id, URL: "/machines/" + id,
			Timestamp: n.At.UnixMilli()}
		payload, _ := json.Marshal(p)
		return webpush.Message{Payload: payload, TTL: devicePairedTTL, Urgency: webpush.UrgencyHigh, Topic: "machinepaired" + id}
	}
	if n.Kind == MachineUsageHint {
		p := Payload{Kind: KindMachine, MachineID: n.MachineID, Title: s.cfg.AppName,
			Body: fmt.Sprintf(text.usageHint, n.MachineName), Tag: "machine-usage:" + id, URL: "/machines/" + id + "/usage",
			Timestamp: n.At.UnixMilli()}
		payload, _ := json.Marshal(p)
		return webpush.Message{Payload: payload, TTL: usageHintTTL, Urgency: webpush.UrgencyNormal, Topic: "machineusage" + id}
	}
	var body string
	switch {
	case n.Pending > 1:
		body = fmt.Sprintf(text.machinePending, n.MachineName, n.Pending)
	case n.Kind == MachineQuestion:
		body = fmt.Sprintf(text.machineQuestion, n.MachineName)
	default:
		body = fmt.Sprintf(text.machineApproval, n.MachineName)
	}
	url := "/machines/" + id
	if n.SessionID != "" {
		url += "?session=" + n.SessionID
	}
	p := Payload{Kind: KindMachine, MachineID: n.MachineID, SessionID: n.SessionID, Title: s.cfg.AppName, Body: body,
		Tag: "machine:" + id, URL: url, Timestamp: n.At.UnixMilli()}
	// Short strings: Marshal cannot fail, and the machine name is at most 64
	// characters, well below webpush.PayloadMax.
	payload, _ := json.Marshal(p)
	return webpush.Message{Payload: payload, TTL: machineTTL, Urgency: webpush.UrgencyHigh, Topic: "machine" + id}
}
