package zalo

import (
	"encoding/json"
	"testing"
	"time"
)

func TestMapMessageOfASharedLinkIsItsPictureWithSiteTitleAndLine(t *testing.T) {
	content := `{"title":"Thịt chó Ba Béo - CS2 · 38 P. Đặng Xuân Bảng","description":"★★★☆☆ · Nhà hàng","href":"https://www.google.com/maps/place/x","thumb":"https://photo-link-talk.zadn.vn/photolinkv2/720/abc.jpg","action":"recommened.link","params":"{}"}`
	ev := wireEvent{Ev: evMessage, Thread: threadUser, MsgType: msgTypeRecommended, Content: json.RawMessage(content),
		MsgID: "1001", UIDFrom: "500", IDTo: "0", DName: "Lan", TS: "1763700000000"}
	m, _, err := mapMessage(ev, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	want := "www.google.com\nThịt chó Ba Béo - CS2 · 38 P. Đặng Xuân Bảng\n★★★☆☆ · Nhà hàng"
	if m.Text != want {
		t.Errorf("text = %q, want %q", m.Text, want)
	}
	if len(m.Media) != 1 || m.Media[0].Kind != "photo" || m.Media[0].Ref != mediaRef+"https://photo-link-talk.zadn.vn/photolinkv2/720/abc.jpg" {
		t.Errorf("media = %+v, want the card's picture", m.Media)
	}
	if len(m.Entities) != 3 {
		t.Fatalf("entities = %+v, want url, link and bold", m.Entities)
	}
	if e := m.Entities[0]; e.Kind != "url" || e.Offset != 0 || e.Length != 14 {
		t.Errorf("site entity = %+v", e)
	}
	// "Thịt chó Ba Béo - CS2 · 38 P. Đặng Xuân Bảng" is 44 UTF-16 units, after 15
	if e := m.Entities[1]; e.Kind != "link" || e.URL != "https://www.google.com/maps/place/x" || e.Offset != 15 || e.Length != 44 {
		t.Errorf("title entity = %+v", e)
	}
	if e := m.Entities[2]; e.Kind != "bold" || e.Offset != 15 || e.Length != 44 {
		t.Errorf("bold entity = %+v", e)
	}
}

func TestLinkContentKeepsTheCardWithoutAPictureOffZaloAndRefusesOthers(t *testing.T) {
	text, media, ents, ok := linkContent(msgTypeLink, json.RawMessage(`{"href":"https://example.com/a","thumb":"https://evil.example/x.jpg"}`))
	if !ok || text != "example.com\nhttps://example.com/a" || media != nil || len(ents) != 3 {
		t.Errorf("link = %q %+v %+v %v, want site and URL as the title, no picture", text, media, ents, ok)
	}
	for name, c := range map[string]struct{ typ, content string }{
		"contact card":   {msgTypeRecommended, `{"title":"Lan","href":"https://zalo.me/x","action":"recommened.user"}`},
		"not http":       {msgTypeLink, `{"href":"javascript:alert(1)"}`},
		"no host":        {msgTypeLink, `{"href":"https://"}`},
		"text":           {msgTypeText, `"https://example.com"`},
		"malformed card": {msgTypeLink, `[]`},
	} {
		if _, _, _, ok := linkContent(c.typ, json.RawMessage(c.content)); ok {
			t.Errorf("%s: taken as a link", name)
		}
	}
}

func TestMapUndoTreatsZeroIdsAsAbsent(t *testing.T) {
	r, err := mapUndo(json.RawMessage(`{"data":{"content":{"globalMsgId":0,"cliMsgId":"77"}},"threadId":"500"}`))
	if err != nil || r != (recall{conv: "500", cli: "77"}) {
		t.Errorf("recall = %+v, %v, want client id 77 only", r, err)
	}
	if _, err := mapUndo(json.RawMessage(`{"data":{"content":{"globalMsgId":0,"cliMsgId":0}},"threadId":"500"}`)); err == nil {
		t.Error("a recall of message 0 was accepted")
	}
}
