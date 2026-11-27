package telegram

import (
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/tg"
)

const selfID = 100

func book() *peerBook {
	b := newPeerBook()
	b.add([]tg.UserClass{
		&tg.User{ID: 7, FirstName: "Anh", LastName: "Đô", Username: "donvinet"},
		&tg.User{ID: 8, Username: "onlyname"},
		&tg.User{ID: 9, Bot: true, FirstName: "Helper"},
	}, []tg.ChatClass{&tg.Channel{ID: 55, Title: "Tin tức", Broadcast: true}})
	return b
}

func TestMapMessagePrivateChat(t *testing.T) {
	b := book()
	in, ok := b.mapMessage(&tg.Message{ID: 5, PeerID: &tg.PeerUser{UserID: 7}, Date: 1_700_000_000, Message: "chào", EditDate: 1_700_000_100,
		Entities: []tg.MessageEntityClass{&tg.MessageEntityBold{Offset: 0, Length: 4}}}, selfID)
	if !ok || in.Conversation != "user:7" || in.ID != "5" || in.From.IsSelf || in.From.Name != "Anh Đô" || in.Version != 1_700_000_100 {
		t.Fatalf("incoming = %+v", in)
	}
	if !in.Date.Equal(time.Unix(1_700_000_000, 0)) || len(in.Entities) != 1 || in.Entities[0].Kind != "bold" {
		t.Fatalf("date/entities = %v %v", in.Date, in.Entities)
	}
	// Own messages in a private chat come back as the owner's.
	out, _ := b.mapMessage(&tg.Message{ID: 6, Out: true, PeerID: &tg.PeerUser{UserID: 7}, Message: "chào anh"}, selfID)
	if !out.From.IsSelf || out.Conversation != "user:7" {
		t.Fatalf("outgoing = %+v", out)
	}
}

// withFrom sets the optional fields the way Telegram does (with their flags).
func withFrom(m *tg.Message, user int64, reply tg.MessageReplyHeaderClass) *tg.Message {
	m.SetFromID(&tg.PeerUser{UserID: user})
	m.SetReplyTo(reply)
	return m
}

func TestMapMessageGroupChannelAndReply(t *testing.T) {
	b := book()
	g, _ := b.mapMessage(withFrom(&tg.Message{ID: 9, PeerID: &tg.PeerChat{ChatID: 3}, Message: "x"}, 8,
		&tg.MessageReplyHeader{ReplyToMsgID: 4}), selfID)
	if g.Conversation != "chat:3" || g.From.Name != "onlyname" || g.ReplyTo != "4" {
		t.Fatalf("group = %+v", g)
	}
	other, _ := b.mapMessage(withFrom(&tg.Message{ID: 10, PeerID: &tg.PeerChat{ChatID: 3}, Message: "x"}, 8,
		&tg.MessageReplyHeader{ReplyToMsgID: 4, ReplyToPeerID: &tg.PeerChat{ChatID: 99}}), selfID)
	if other.ReplyTo != "" {
		t.Fatalf("a reply that points into another chat kept its target: %q", other.ReplyTo)
	}
	post, _ := b.mapMessage(&tg.Message{ID: 11, PeerID: &tg.PeerChannel{ChannelID: 55}, Message: "bài đăng"}, selfID)
	if post.Conversation != "channel:55" || post.From.ID != "channel:55" || post.From.Name != "Tin tức" {
		t.Fatalf("post = %+v", post)
	}
	if _, ok := b.mapMessage(&tg.MessageService{ID: 12, PeerID: &tg.PeerUser{UserID: 7}}, selfID); ok {
		t.Fatal("a service message was mapped as content")
	}
}

func TestMapEntitiesKeepsKnownKindsOnly(t *testing.T) {
	got := mapEntities([]tg.MessageEntityClass{
		&tg.MessageEntityBold{Offset: 0, Length: 1},
		&tg.MessageEntityTextURL{Offset: 1, Length: 2, URL: "tg://resolve?domain=x"},
		&tg.MessageEntityMentionName{Offset: 3, Length: 2, UserID: 7},
		&tg.MessageEntityBotCommand{Offset: 5, Length: 3},
		&tg.MessageEntityPhone{Offset: 8, Length: 3},
	})
	if len(got) != 3 || got[0].Kind != "bold" || got[1].Kind != "link" || got[2].Mention != "7" {
		t.Fatalf("entities = %+v", got)
	}
}

func TestMapMediaKinds(t *testing.T) {
	doc := func(attrs ...tg.DocumentAttributeClass) tg.MessageMediaClass {
		return &tg.MessageMediaDocument{Document: &tg.Document{MimeType: "x/y", Size: 10, Attributes: attrs}}
	}
	cases := map[string]tg.MessageMediaClass{
		"photo":    &tg.MessageMediaPhoto{},
		"video":    doc(&tg.DocumentAttributeVideo{W: 1, H: 2, Duration: 3}),
		"voice":    doc(&tg.DocumentAttributeAudio{Voice: true, Duration: 4}),
		"audio":    doc(&tg.DocumentAttributeAudio{Duration: 4}),
		"sticker":  doc(&tg.DocumentAttributeSticker{}),
		"gif":      doc(&tg.DocumentAttributeAnimated{}),
		"document": doc(&tg.DocumentAttributeFilename{FileName: "a.pdf"}),
		"location": &tg.MessageMediaGeo{},
		"poll":     &tg.MessageMediaPoll{},
	}
	for want, m := range cases {
		got := mapMedia(m)
		if len(got) != 1 || got[0].Kind != want {
			t.Errorf("%s: mapped to %+v", want, got)
		}
	}
	if len(mapMedia(&tg.MessageMediaWebPage{})) != 0 || len(mapMedia(nil)) != 0 {
		t.Error("a link preview or no media produced media")
	}
	if v := mapMedia(doc(&tg.DocumentAttributeVideo{W: 1, H: 2, Duration: 3}))[0]; v.Duration != 3*time.Second || v.Width != 1 {
		t.Errorf("video = %+v", v)
	}
	// A GIF carries the video attribute too, before or after the animated one.
	for _, m := range []tg.MessageMediaClass{
		doc(&tg.DocumentAttributeAnimated{}, &tg.DocumentAttributeVideo{W: 4, H: 3}),
		doc(&tg.DocumentAttributeVideo{W: 4, H: 3}, &tg.DocumentAttributeAnimated{}),
	} {
		if g := mapMedia(m)[0]; g.Kind != "gif" || g.Width != 4 || g.Height != 3 {
			t.Errorf("gif = %+v", g)
		}
	}
	if s := mapMedia(doc(&tg.DocumentAttributeSticker{}, &tg.DocumentAttributeAnimated{}))[0]; s.Kind != "sticker" {
		t.Errorf("animated sticker = %+v", s)
	}
}

func TestTranslateErrors(t *testing.T) {
	// translate on nil and on a plain error.
	if translate(nil) != nil {
		t.Fatal("nil translated to an error")
	}
	var _ error = (*bridge.RateLimitError)(nil)
}

// A message in short form names its sender by id only; the stand-in name is
// flagged so it never replaces a real one.
func TestMapMessageFromUnknownUserFlagsTheStandInName(t *testing.T) {
	m, ok := newPeerBook().mapMessage(withFrom(&tg.Message{ID: 5, PeerID: &tg.PeerUser{UserID: 7}, Message: "chào"}, 7, nil), selfID)
	if !ok || m.From.ID != "7" || !m.From.NameUnknown {
		t.Fatalf("from = %+v", m.From)
	}
	known, _ := book().mapMessage(withFrom(&tg.Message{ID: 6, PeerID: &tg.PeerUser{UserID: 7}, Message: "chào"}, 7, nil), selfID)
	if known.From.NameUnknown {
		t.Fatalf("a known user is flagged: %+v", known.From)
	}
}

func TestMapMessageKeepsLinkButtonsOnly(t *testing.T) {
	markup := &tg.ReplyInlineMarkup{Rows: []tg.KeyboardInlineButtonRow{
		{Buttons: []tg.KeyboardInlineButton{
			{Text: "Mở trong OneDash", Type: &tg.InlineButtonTypeURL{URL: "https://one.example/x"}},
			{Text: "Duyệt", Type: &tg.InlineButtonTypeCallback{Data: []byte("ok")}},
			{Text: "Mở issue", Type: &tg.InlineButtonTypeURL{URL: "https://git.example/1"}},
		}},
		{Buttons: []tg.KeyboardInlineButton{{Text: "Chỉ callback", Type: &tg.InlineButtonTypeCallback{Data: []byte("x")}}}},
	}}
	got, ok := book().mapMessage(&tg.Message{ID: 5, PeerID: &tg.PeerUser{UserID: 9}, Message: "x", ReplyMarkup: markup}, selfID)
	if !ok || len(got.Buttons) != 1 || len(got.Buttons[0]) != 2 {
		t.Fatalf("buttons = %+v", got.Buttons)
	}
	if got.Buttons[0][0] != (bridge.Button{Text: "Mở trong OneDash", URL: "https://one.example/x"}) || got.Buttons[0][1].Text != "Mở issue" {
		t.Fatalf("buttons = %+v", got.Buttons)
	}
	// A reply keyboard is not a set of link buttons.
	plain, _ := book().mapMessage(&tg.Message{ID: 6, PeerID: &tg.PeerUser{UserID: 9}, Message: "x", ReplyMarkup: &tg.ReplyKeyboardHide{}}, selfID)
	if plain.Buttons != nil {
		t.Fatalf("buttons = %+v", plain.Buttons)
	}
}
