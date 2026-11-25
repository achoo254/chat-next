package zalo

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

// fileOf is a file of Chat with content data.
func fileOf(kind, mime, name string, data []byte, width, height int) bridge.OutMedia {
	return bridge.OutMedia{Kind: kind, MimeType: mime, Name: name, Size: int64(len(data)), Width: width, Height: height,
		Open: func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(data)), nil }}
}

func withFiles(rid int64, caption string, files ...bridge.OutMedia) bridge.OutMessage {
	m := out(rid, caption)
	m.Media = files
	return m
}

// A photo reaches the sidecar byte for byte, with its caption, and a repeated
// RandomID creates no second message.
func TestSendPhotoOnceWithItsCaption(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	data := bytes.Repeat([]byte{0xff, 0xd8, 0x01}, fileChunkBytes) // three chunks
	m := withFiles(70, "ảnh đây", fileOf("photo", "image/jpeg", "IMG_1.HEIC", data, 800, 600))
	first, err := send(t, a, m)
	if err != nil {
		t.Fatal(err)
	}
	again, err := send(t, a, m)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.IDs) != 1 || again.IDs[0] != first.IDs[0] || z.sends() != 1 || z.files("IMG_1.jpg") != 1 {
		t.Fatalf("refs %v then %v, sends %d, files %d; want one photo", first.IDs, again.IDs, z.sends(), z.files("IMG_1.jpg"))
	}
	z.mu.Lock()
	c, held := z.mediaSends[0], z.messages[len(z.messages)-1].file
	z.mu.Unlock()
	if c.Kind != "photo" || c.Text != "ảnh đây" || c.Width != 800 || c.Height != 600 || c.Size != int64(len(data)) || !bytes.Equal(held, data) {
		t.Fatalf("send_media = %+v (bytes equal %v), want the photo as Chat holds it", c, bytes.Equal(held, data))
	}
}

// An album goes item by item, in order, a gap apart, each under its own RandomID.
func TestSendAlbumItemByItem(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	a.timing.sendGap = 200 * time.Millisecond
	m := withFiles(80, "", fileOf("document", "application/pdf", "a.pdf", []byte("pdf-a"), 0, 0),
		fileOf("audio", "audio/mpeg", "b.mp3", []byte("mp3-b"), 0, 0))
	ref, err := send(t, a, m)
	if err != nil {
		t.Fatal(err)
	}
	if len(ref.IDs) != 2 || ref.IDs[0] == ref.IDs[1] || z.files("a.pdf") != 1 || z.files("b.mp3") != 1 {
		t.Fatalf("ref %v, files %d %d; want two messages", ref.IDs, z.files("a.pdf"), z.files("b.mp3"))
	}
	z.mu.Lock()
	gap := z.sendTimes[1].Sub(z.sendTimes[0])
	kinds := z.mediaSends[0].Kind + "," + z.mediaSends[1].Kind
	z.mu.Unlock()
	// The sim takes each command line 10 ms late, so the first item may be seen later than it went.
	if gap < 170*time.Millisecond || kinds != "file,file" {
		t.Fatalf("items %v apart as %s, want at least the gap, as files", gap, kinds)
	}
	st := a.sendStateFor(testAccount.ID)
	for i, rid := range []int64{80, 81} {
		if att, ok := st.log.lookup(rid); !ok || att.ref == nil || att.ref.IDs[0] != ref.IDs[i] {
			t.Fatalf("RandomID %d is not the answer of item %d", rid, i)
		}
	}
}

// A file that fails stops the album; the retry does not send the items that went.
func TestSendAlbumRetrySkipsTheItemsThatWent(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	m := withFiles(90, "", fileOf("document", "text/plain", "1.txt", []byte("1"), 0, 0), fileOf("document", "text/plain", "2.txt", []byte("2"), 0, 0))
	// The first item goes; the second is throttled.
	z.set(func(z *zaloSim) { z.failOn = map[int]string{2: "rate_limited"} })
	var limit *bridge.RateLimitError
	if _, err := send(t, a, m); !errors.As(err, &limit) {
		t.Fatalf("err = %v, want the throttle of the second item", err)
	}
	ref, err := send(t, a, m)
	if err != nil {
		t.Fatal(err)
	}
	if len(ref.IDs) != 2 || z.files("1.txt") != 1 || z.files("2.txt") != 1 {
		t.Fatalf("ref %v, files %d %d; want each item once", ref.IDs, z.files("1.txt"), z.files("2.txt"))
	}
}

func TestSendRefusesFilesZaloSendingDoesNotTake(t *testing.T) {
	a, _ := newTestAdapter(t, &fakeRunner{})
	pdf := fileOf("document", "application/pdf", "a.pdf", []byte("x"), 0, 0)
	tooMany := make([]bridge.OutMedia, maxFilesPerMessage+1)
	for i := range tooMany {
		tooMany[i] = pdf
	}
	big := pdf
	big.Size = maxFileBytes + 1
	empty := pdf
	empty.Size = 0
	for name, c := range map[string]struct {
		m    bridge.OutMessage
		want error
		says string
	}{
		"video":            {withFiles(1, "", fileOf("video", "video/mp4", "v.mp4", []byte("x"), 10, 10)), bridge.ErrNotAllowed, errFileNotSendable},
		"voice":            {withFiles(1, "", fileOf("voice", "audio/ogg", "voice.ogg", []byte("x"), 0, 0)), bridge.ErrNotAllowed, errFileNotSendable},
		"mp4 as a file":    {withFiles(1, "", fileOf("document", "video/mp4", "v.MP4", []byte("x"), 0, 0)), bridge.ErrNotAllowed, errFileNotSendable},
		"gif":              {withFiles(1, "", fileOf("document", "image/gif", "a.gif", []byte("x"), 0, 0)), bridge.ErrNotAllowed, errFileNotSendable},
		"unmeasured image": {withFiles(1, "", fileOf("document", "image/png", "a.png", []byte("x"), 0, 0)), bridge.ErrNotAllowed, errFileNotSendable},
		"empty":            {withFiles(1, "", empty), bridge.ErrNotAllowed, errFileNotSendable},
		"too large":        {withFiles(1, "", big), bridge.ErrTooLarge, "file too large"},
		"too many":         {withFiles(1, "", tooMany...), bridge.ErrNotAllowed, errFileNotSendable},
		"file caption":     {withFiles(1, "đọc nhé", pdf), bridge.ErrNotAllowed, errFileCaption},
		"long caption":     {withFiles(1, strings.Repeat("ê", maxTextRunes+1), fileOf("photo", "image/png", "a.png", []byte("x"), 1, 1)), bridge.ErrNotAllowed, ""},
	} {
		_, err := send(t, a, c.m)
		if !errors.Is(err, c.want) || !strings.Contains(err.Error(), c.says) {
			t.Errorf("%s: err = %v, want %v saying %q", name, err, c.want, c.says)
		}
	}
	if _, err := send(t, a, withFiles(1, "", pdf)); !errors.Is(err, errNotListening) {
		t.Errorf("no listener: err = %v, want errNotListening", err)
	}
}

// A file that is not the size Chat recorded never reaches send_media.
func TestSendFileOfAnotherSizeSendsNothing(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	short := fileOf("document", "application/pdf", "a.pdf", []byte("abc"), 0, 0)
	short.Size = 4
	if _, err := send(t, a, withFiles(100, "", short)); err == nil || errors.Is(err, bridge.ErrNotAllowed) {
		t.Fatalf("err = %v, want a plain error", err)
	}
	if z.sends() != 0 {
		t.Fatalf("sends = %d, want none", z.sends())
	}
}

func TestSendFileErrorsAreClassified(t *testing.T) {
	z := newZaloSim(t)
	a, _, _ := simAccount(t, z, false)
	pdf := fileOf("document", "application/pdf", "a.pdf", []byte("x"), 0, 0)
	z.set(func(z *zaloSim) { z.failNext = "too_large" })
	if _, err := send(t, a, withFiles(110, "", pdf)); !errors.Is(err, bridge.ErrTooLarge) {
		t.Fatalf("too_large: err = %v", err)
	}
	z.set(func(z *zaloSim) { z.failNext = "file_refused" })
	if _, err := send(t, a, withFiles(111, "", pdf)); !errors.Is(err, bridge.ErrNotAllowed) || !strings.Contains(err.Error(), errFileNotSendable) {
		t.Fatalf("file_refused: err = %v", err)
	}
	// An upload that failed created nothing: the retry goes out at once, without the history.
	z.set(func(z *zaloSim) { z.failNext = "upload_failed" })
	if _, err := send(t, a, withFiles(112, "", pdf)); err == nil || errors.Is(err, bridge.ErrNotAllowed) {
		t.Fatalf("upload_failed: err = %v, want a plain error", err)
	}
	if _, err := send(t, a, withFiles(112, "", pdf)); err != nil || z.historyReads() != 0 || z.files("a.pdf") != 1 {
		t.Fatalf("retry: err %v, history reads %d, files %d", err, z.historyReads(), z.files("a.pdf"))
	}
}

// A lost answer leaves a file of the owner in the history that may be the earlier
// try: it is not sent again.
func TestSendFileLostAnswerIsNotSentAgain(t *testing.T) {
	z := newZaloSim(t)
	z.seed("500", false, "cũ", time.Now().Add(-time.Hour))
	a, _, _ := simAccount(t, z, false)
	z.set(func(z *zaloSim) { z.dropAnswers = 1 })
	pdf := withFiles(120, "", fileOf("document", "application/pdf", "a.pdf", []byte("x"), 0, 0))
	if _, err := send(t, a, pdf); err == nil {
		t.Fatal("the unanswered send succeeded")
	}
	if _, err := send(t, a, pdf); !errors.Is(err, errUnsure) {
		t.Fatalf("at once: err = %v, want errUnsure", err)
	}
	time.Sleep(a.timing.mediaAnswer + 20*time.Millisecond)
	if _, err := send(t, a, pdf); !errors.Is(err, errUnsure) {
		t.Fatalf("later: err = %v, want errUnsure", err)
	}
	if z.files("a.pdf") != 1 || z.sends() != 1 {
		t.Fatalf("files %d, sends %d; want one", z.files("a.pdf"), z.sends())
	}
}

// A retry of a send that may have gone out (another process) goes out only when
// the history reaches back to it and holds no photo or file of the owner since.
func TestSendFileRetryOfAnUnclearSendChecksTheHistory(t *testing.T) {
	z := newZaloSim(t)
	z.seed("500", false, "cũ", time.Now().Add(-time.Hour))
	a, _, _ := simAccount(t, z, false)
	pdf := fileOf("document", "application/pdf", "a.pdf", []byte("x"), 0, 0)
	if _, err := send(t, a, retry(withFiles(130, "", pdf), time.Now().Add(-5*time.Minute))); err != nil {
		t.Fatalf("nothing in the history: %v", err)
	}
	z.seedFile("500", "phone.jpg", time.Now()) // sent from the phone, or an earlier try
	if _, err := send(t, a, retry(withFiles(131, "", pdf), time.Now().Add(-5*time.Minute))); !errors.Is(err, errUnsure) {
		t.Fatalf("a file of the owner since: err = %v, want errUnsure", err)
	}
	if z.files("a.pdf") != 1 {
		t.Fatalf("files = %d, want 1", z.files("a.pdf"))
	}
}

func TestSendFileLogsNoName(t *testing.T) {
	z := newZaloSim(t)
	a, h, _ := simAccount(t, z, false)
	z.set(func(z *zaloSim) { z.failNext = "file_refused" })
	_, _ = send(t, a, withFiles(140, "", fileOf("document", "application/pdf", "hop-dong-mat.pdf", []byte("bí mật"), 0, 0)))
	logged := strings.Join(h.all(), "\n")
	for _, s := range []string{"hop-dong", "bí mật", "500"} {
		if strings.Contains(logged, s) {
			t.Errorf("log contains %q:\n%s", s, logged)
		}
	}
}

func TestCleanFileName(t *testing.T) {
	long := strings.Repeat("ả", maxNameRunes+10) + ".pdf"
	for in, want := range map[string]string{
		`C:\Users\a\Báo cáo "Q3".pdf`: "Báo cáo Q3.pdf",
		"../../etc/passwd":            "passwd",
		"a\r\nb\x00c.txt":             "abc.txt",
		" .hidden. ":                  "hidden",
		"<x>|y?*.doc":                 "xy.doc",
		long:                          strings.Repeat("ả", maxNameRunes-4) + ".pdf",
	} {
		if got := cleanFileName(in); got != want {
			t.Errorf("cleanFileName(%q) = %q, want %q", in, got, want)
		}
	}
}
