package engine_test

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/contracttest"
)

// pngSticker serves one PNG as the file of every sticker, named like Telegram.
type pngSticker struct {
	*contracttest.Fake
	data []byte
}

func (a *pngSticker) Name() string { return "telegram" }

func (a *pngSticker) FetchMedia(context.Context, bridge.Account, string) (bridge.MediaStream, error) {
	return &pngStream{bytes.NewReader(a.data), int64(len(a.data))}, nil
}

type pngStream struct {
	*bytes.Reader
	size int64
}

func (s *pngStream) Close() error     { return nil }
func (s *pngStream) MimeType() string { return "image/png" }
func (s *pngStream) Size() int64      { return s.size }

// A sticker imported as a label (its type was not known then) gets its
// picture when the engine starts again, and the label goes.
func TestStickersImportedAsALabelGetTheirPictureAtTheNextStart(t *testing.T) {
	e := newEnvWithMedia(t, true)
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for x := 0; x < 32; x++ {
		for y := 0; y < 32; y++ {
			img.Set(x, y, color.RGBA{R: 200, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	e.adapter = &pngSticker{Fake: e.fake, data: buf.Bytes()}
	conv := e.group("g1")
	sticker := e.msg("1", lan, "", 0)
	sticker.Media = []bridge.Media{{Kind: "sticker", Ref: "g1/1", MimeType: ""}}
	e.fake.AddHistory("g1", sticker)
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"[Nhãn dán]"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill never finished" })

	e.start()
	e.eventually(func() bool {
		var withFile int
		err := e.st.Pool().QueryRow(context.Background(),
			`SELECT count(*) FROM messages WHERE chat_id = $1 AND text = '' AND media_kind <> 0`, chatID).Scan(&withFile)
		return err == nil && withFile == 1
	}, func() string { return "the sticker never got its picture: " + strings.Join(e.texts(chatID), "|") })
	var edited bool
	if err := e.st.Pool().QueryRow(context.Background(),
		`SELECT edit_date IS NOT NULL FROM messages WHERE chat_id = $1 AND media_kind <> 0`, chatID).Scan(&edited); err != nil || edited {
		t.Fatalf("a restored sticker is marked edited: %v, %v", edited, err)
	}

	// A sticker marked edited by the earlier way of restoring loses the mark at the next start.
	if _, err := e.st.Pool().Exec(context.Background(), `UPDATE messages SET edit_date = now() WHERE chat_id = $1 AND media_kind <> 0`, chatID); err != nil {
		t.Fatal(err)
	}
	e.start()
	e.eventually(func() bool {
		var marked bool
		err := e.st.Pool().QueryRow(context.Background(), `SELECT edit_date IS NOT NULL FROM messages WHERE chat_id = $1 AND media_kind <> 0`, chatID).Scan(&marked)
		return err == nil && !marked
	}, func() string { return "the edit mark of a restored sticker stayed" })
}
