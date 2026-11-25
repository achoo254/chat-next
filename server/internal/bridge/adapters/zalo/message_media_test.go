package zalo

import (
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

// Attachment contents shaped like zca-js's TAttachmentContent. The URLs carry a
// stand-in token: a real signed link must never reach a log.
const (
	testPhotoURL = "https://f21-zpc.zdn.vn/jpg/123/photo.jpg?token=tok-secret"
	testFileURL  = "https://dl-zfile.dlfl.vn/abc/report.pdf?sig=tok-secret"
)

func mediaEvent(msgType, content string) string {
	return `{"ev":"message","thread":"user","self":false,"msgType":"` + msgType + `","content":` + content +
		`,"msgId":"9","uidFrom":"500","idTo":"999","dName":"Lan","ts":"1763700000000"}`
}

func TestMapMessagePhotoBecomesAFileToCopy(t *testing.T) {
	ev := mustEvent(t, mediaEvent("chat.photo", `{"title":"","description":"","href":"`+testPhotoURL+`","thumb":"https://f21-zpc.zdn.vn/t.jpg","childnumber":0,"action":"","params":"{\"width\":800}","type":""}`))
	m, _, err := mapMessage(ev, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if m.Text != "" || len(m.Media) != 1 {
		t.Fatalf("message = %+v", m)
	}
	if got := m.Media[0]; got.Kind != "photo" || got.Ref != mediaRef+testPhotoURL || got.Name != "" || got.Size != 0 {
		t.Errorf("media = %+v", got)
	}
}

func TestMapMessageFileCarriesItsNameAndSize(t *testing.T) {
	cases := map[string]int64{
		`"{\"fileSize\":\"123456\",\"fileExt\":\"pdf\"}"`: 123456, // params as JSON text, as zca-js types it
		`"{\"fileSize\":2048}"`:                           2048,
		`{"fileSize":"77"}`:                               77, // an object is taken too
		`"{\"fileSize\":\"-1\"}"`:                         0,
		`"not json"`:                                      0,
		`null`:                                            0,
	}
	for params, want := range cases {
		ev := mustEvent(t, mediaEvent("share.file", `{"title":"  Hợp đồng.pdf ","href":"`+testFileURL+`","params":`+params+`}`))
		m, _, err := mapMessage(ev, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		want := bridge.Media{Ref: mediaRef + testFileURL, Kind: "document", Name: "Hợp đồng.pdf", Size: want}
		if m.Text != "" || len(m.Media) != 1 || m.Media[0] != want {
			t.Errorf("params %s: message = %+v", params, m)
		}
	}
}

func TestMapMessageVideoBecomesAFileToCopy(t *testing.T) {
	ev := mustEvent(t, mediaEvent("chat.video.msg", `{"href":"https://v1.dlmd.me/v.mp4","params":"{}"}`))
	m, _, err := mapMessage(ev, time.Now())
	if err != nil || len(m.Media) != 1 || m.Media[0].Kind != "video" {
		t.Fatalf("message = %+v, err = %v", m, err)
	}
}

func TestMapMessageFileNameIsBounded(t *testing.T) {
	long := strings.Repeat("ả", 200) // 3 bytes each
	ev := mustEvent(t, mediaEvent("share.file", `{"title":"`+long+`","href":"`+testFileURL+`"}`))
	m, _, _ := mapMessage(ev, time.Now())
	if len(m.Media) != 1 || len(m.Media[0].Name) > mediaFileNameMax || !strings.HasPrefix(long, m.Media[0].Name) {
		t.Fatalf("name = %q", m.Media[0].Name)
	}
}

// A file whose URL is not on Zalo's CDN is never fetched: the message is the label.
func TestMapMessageFileOffTheCDNIsALabel(t *testing.T) {
	cases := map[string]string{
		mediaEvent("chat.photo", `{"href":"https://evil.example/p.jpg"}`):                           labelPhoto,
		mediaEvent("chat.photo", `{"href":"http://f21-zpc.zdn.vn/p.jpg"}`):                          labelPhoto,
		mediaEvent("chat.photo", `{"href":"https://zdn.vn/p.jpg"}`):                                 labelPhoto,
		mediaEvent("chat.photo", `{"href":"https://f21-zpc.zdn.vn.evil.example/p.jpg"}`):            labelPhoto,
		mediaEvent("chat.photo", `{"href":"https://f21-zpc.zdn.vn:8443/p.jpg"}`):                    labelPhoto,
		mediaEvent("chat.photo", `{"href":"https://10.0.0.1/p.jpg"}`):                               labelPhoto,
		mediaEvent("chat.photo", `"just text"`):                                                     labelPhoto,
		mediaEvent("share.file", `{"title":"a.pdf","href":"https://evil.example/a.pdf"}`):           "[Tệp: a.pdf]",
		mediaEvent("share.file", `{"title":"","href":""}`):                                          labelFile,
		mediaEvent("chat.video.msg", `{"href":"https://evil.example/v.mp4"}`):                       labelVideo,
		mediaEvent("chat.photo", `{"href":"https://f21-zpc.zdn.vn/`+strings.Repeat("a", 2100)+`"}`): labelPhoto,
	}
	for line, want := range cases {
		m, _, err := mapMessage(mustEvent(t, line), time.Now())
		if err != nil || m.Text != want || len(m.Media) != 0 {
			t.Errorf("%.120s: text = %q, media = %+v, err = %v; want %q", line, m.Text, m.Media, err, want)
		}
	}
}

// Kinds no real payload shows a downloadable file for stay a label.
func TestMapMessageUnsupportedKindsStayLabels(t *testing.T) {
	cases := map[string]string{
		mediaEvent("chat.voice", `{"href":"`+testFileURL+`"}`):   labelVoice,
		mediaEvent("chat.gif", `{"href":"`+testPhotoURL+`"}`):    labelGIF,
		mediaEvent("chat.doodle", `{"href":"`+testPhotoURL+`"}`): labelUnsupported,
		mediaEvent("chat.location.new", `{"lat":1}`):             labelUnsupported,
		mediaEvent("chat.recommended", `{"href":"https://a.b"}`): labelUnsupported,
	}
	for line, want := range cases {
		m, _, err := mapMessage(mustEvent(t, line), time.Now())
		if err != nil || m.Text != want || len(m.Media) != 0 {
			t.Errorf("%.80s: text = %q, media = %+v, err = %v; want %q", line, m.Text, m.Media, err, want)
		}
	}
}

func TestMapMessageStickerBecomesAPictureToCopy(t *testing.T) {
	ev := mustEvent(t, mediaEvent("chat.sticker", `{"id":21001,"catId":2,"type":7}`))
	m, _, err := mapMessage(ev, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if m.Text != "" || len(m.Media) != 1 {
		t.Fatalf("message = %+v", m)
	}
	got := m.Media[0]
	if got.Kind != "sticker" || got.MimeType != "image/png" || got.Ref != mediaRef+stickerURL+"21001" {
		t.Errorf("media = %+v", got)
	}
	if !mediaAllowed(strings.TrimPrefix(got.Ref, mediaRef)) {
		t.Errorf("the sticker URL %q is not on an allowed host", got.Ref)
	}
}

func TestMapMessageStickerWithoutAUsableIDIsALabel(t *testing.T) {
	for _, content := range []string{`{"catId":2}`, `{"id":"../x?a=b"}`, `{"id":""}`, `"x"`} {
		m, _, err := mapMessage(mustEvent(t, mediaEvent("chat.sticker", content)), time.Now())
		if err != nil || m.Text != labelSticker || len(m.Media) != 0 {
			t.Errorf("%s: message = %+v, err = %v", content, m, err)
		}
	}
}
