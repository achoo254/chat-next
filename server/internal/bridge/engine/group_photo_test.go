package engine_test

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/media"
)

// jpegOf makes a small photo of one colour.
func jpegOf(t *testing.T, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	for x := 0; x < 64; x++ {
		for y := 0; y < 64; y++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// chatPhoto is the public id of a chat's photo, "" for none.
func (e *env) chatPhoto(chatID int64) string {
	var id string
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT coalesce((SELECT f.public_id FROM files f WHERE f.id = c.photo_file_id), '') FROM chats c WHERE c.id = $1`, chatID).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func TestTheGroupPhotoOfTheOtherAppIsCopiedWhenItChanges(t *testing.T) {
	e := newEnvWithMedia(t, true)
	e.fake.SetGroupInfoRemotely("g1", bridge.GroupInfo{Title: "Nhóm", About: ""})
	e.fake.SetGroupPhotoRemotely("g1", "p1", jpegOf(t, color.RGBA{R: 200, A: 255}))
	chatID := e.twoWay()
	e.eventually(func() bool { return e.chatPhoto(chatID) != "" }, func() string { return "the photo did not come in" })
	first := e.chatPhoto(chatID)
	// the same photo is not copied again on the next looks
	time.Sleep(400 * time.Millisecond)
	if got := e.chatPhoto(chatID); got != first {
		t.Fatalf("the same photo was copied again: %s then %s", first, got)
	}
	if n := e.fake.PhotoFetches(); n != 1 {
		t.Fatalf("the photo was read %d times, want once", n)
	}
	e.fake.SetGroupPhotoRemotely("g1", "p2", jpegOf(t, color.RGBA{G: 200, A: 255}))
	e.eventually(func() bool { return e.chatPhoto(chatID) != first && e.chatPhoto(chatID) != "" }, func() string { return "the new photo did not come in" })
	e.fake.SetGroupPhotoRemotely("g1", "", nil)
	e.eventually(func() bool { return e.chatPhoto(chatID) == "" }, func() string { return "the removed photo stayed" })
}

func TestAGroupPhotoSetInChatGoesOutAndIsNotCopiedBack(t *testing.T) {
	e := newEnvWithMedia(t, true)
	ctx := context.Background()
	e.fake.SetGroupInfoRemotely("g1", bridge.GroupInfo{Title: "Nhóm", About: ""})
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	data := jpegOf(t, color.RGBA{B: 200, A: 255})
	f, err := e.media.UploadStream(ctx, e.owner, media.StreamUpload{Kind: appv1.MediaKind_MEDIA_KIND_PHOTO, FileName: "nhom.jpg",
		Body: bytes.NewReader(data), MaxBytes: 1 << 20})
	if err != nil {
		t.Fatal(err)
	}
	photo := f.PublicID
	if _, err := e.chat.UpdateChatInfo(ctx, e.owner, &appv1.UpdateChatInfoRequest{ChatId: chatID, PhotoFileId: &photo}); err != nil {
		t.Fatal(err)
	}
	e.eventually(func() bool { return len(e.fake.PhotoCalls()) == 1 }, func() string { return fmt.Sprint(e.fake.PhotoCalls()) })
	time.Sleep(400 * time.Millisecond)
	if got := e.chatPhoto(chatID); got != photo {
		t.Fatalf("Chat's photo is %q after the looks, want the owner's %q", got, photo)
	}
	if n := e.fake.PhotoFetches(); n != 0 {
		t.Fatalf("the photo Chat sent was read back %d times", n)
	}
}
