package botapi

import (
	"slices"
	"testing"
	"unicode/utf16"
)

// sentEntityTexts returns "type:text" for each entity of a sent message.
func sentEntityTexts(m sentMessage) []string {
	units := utf16.Encode([]rune(m.Text))
	out := make([]string, 0, len(m.Entities))
	for _, e := range m.Entities {
		if e.Offset < 0 || e.Length <= 0 || e.Offset+e.Length > len(units) {
			out = append(out, e.Type+":<out of range>")
			continue
		}
		out = append(out, e.Type+":"+string(utf16.Decode(units[e.Offset:e.Offset+e.Length])))
	}
	return out
}

// A bot's plain text gets url, mention and hashtag entities, with or
// without parse_mode; text the bot formatted as code stays plain.
func TestSendMessageDetectsEntities(t *testing.T) {
	h := newHarness(t)
	owner := h.User("owner")
	botID, token := h.Bot(owner, "detectbot")
	private := h.privateWith(owner, botID)
	h.userSends(owner, private, "/start")

	var sent sentMessage
	h.send(token, private, `"text": "🎬 Đệ vừa đăng YouTube Short: Ba dòng biến mô tả sản phẩm thành caption hút mắt #Shorts https://youtube.com/shorts/IKLVx2thnjl", "disable_link_preview": true`).
		into(t, &sent)
	want := []string{"hashtag:#Shorts", "url:https://youtube.com/shorts/IKLVx2thnjl"}
	if got := sentEntityTexts(sent); !slices.Equal(got, want) {
		t.Fatalf("plain text entities = %v, want %v", got, want)
	}

	h.send(token, private, `"text": "`+"`@detectbot`"+` hỏi @detectbot #tinmới hoặc an@hoandat.vn", "parse_mode": "markdown"`).into(t, &sent)
	want = []string{"code:@detectbot", "mention:@detectbot", "hashtag:#tinmới", "email:an@hoandat.vn"}
	if got := sentEntityTexts(sent); !slices.Equal(got, want) {
		t.Fatalf("markdown entities = %v, want %v", got, want)
	}
}
