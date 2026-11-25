package engine_test

import (
	"context"
	"image/color"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

// puppetPhoto is the public id of the photo of a person's puppet, "" for none.
func (e *env) puppetPhoto(person string) string {
	var id string
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT coalesce((SELECT f.public_id FROM files f WHERE f.id = u.photo_file_id), '')
		FROM external_users x JOIN users u ON u.id = x.user_id
		WHERE x.account_id = $1 AND x.external_user_id = $2`, e.account, person).Scan(&id); err != nil {
		return ""
	}
	return id
}

// withPhoto is a participant showing the photo id with the given ref.
func withPhoto(p bridge.Participant, id string) bridge.Participant {
	p.PhotoKnown, p.PhotoID = true, id
	if id != "" {
		p.PhotoRef = "person-photo:" + p.ID + ":" + id
	}
	return p
}

func TestThePhotoOfAPersonBecomesThePhotoOfTheirPuppetAndFollowsChanges(t *testing.T) {
	e := newEnvWithMedia(t, true)
	lan1 := withPhoto(lan, "p1")
	e.fake.SetPersonPhoto(lan1.PhotoRef, jpegOf(t, color.RGBA{R: 200, A: 255}))
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &lan1}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", lan1, "chào đại ca", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào đại ca"})
	e.eventually(func() bool { return e.puppetPhoto(lan.ID) != "" }, func() string { return "the photo did not come in" })
	first := e.puppetPhoto(lan.ID)

	// The same photo is not copied again on the next looks or messages.
	again := e.msg("2", lan1, "tin mới", 1)
	again.Conversation = "dm1"
	e.fake.Push(bridge.Event{Message: &again})
	e.waitTexts(chatID, []string{"chào đại ca", "tin mới"})
	time.Sleep(300 * time.Millisecond)
	if got := e.puppetPhoto(lan.ID); got != first {
		t.Fatalf("the same photo was copied again: %s then %s", first, got)
	}
	if n := e.fake.PhotoFetches(); n != 1 {
		t.Fatalf("the photo was read %d times, want once", n)
	}

	// A message that does not know the photo leaves it as it is.
	unknown := e.msg("3", lan, "không rõ ảnh", 2)
	unknown.Conversation = "dm1"
	e.fake.Push(bridge.Event{Message: &unknown})
	e.waitTexts(chatID, []string{"chào đại ca", "tin mới", "không rõ ảnh"})
	time.Sleep(300 * time.Millisecond)
	if got := e.puppetPhoto(lan.ID); got != first {
		t.Fatalf("a message without the photo changed it: %s then %q", first, got)
	}

	// A new photo replaces it; none removes it.
	lan2 := withPhoto(lan, "p2")
	e.fake.SetPersonPhoto(lan2.PhotoRef, jpegOf(t, color.RGBA{G: 200, A: 255}))
	changed := e.msg("4", lan2, "ảnh mới", 3)
	changed.Conversation = "dm1"
	e.fake.Push(bridge.Event{Message: &changed})
	e.eventually(func() bool { p := e.puppetPhoto(lan.ID); return p != "" && p != first }, func() string { return "the new photo did not come in" })
	removed := e.msg("5", withPhoto(lan, ""), "bỏ ảnh", 4)
	removed.Conversation = "dm1"
	e.fake.Push(bridge.Event{Message: &removed})
	e.eventually(func() bool { return e.puppetPhoto(lan.ID) == "" }, func() string { return "the removed photo stayed" })
}

func TestAPhotoThatCannotBeFetchedIsNotAskedForOnEveryLook(t *testing.T) {
	e := newEnvWithMedia(t, true)
	broken := withPhoto(lan, "p1")
	e.fake.SetPersonPhoto(broken.PhotoRef, nil) // the fetch fails
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &broken}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", broken, "chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào"})
	time.Sleep(400 * time.Millisecond) // many looks at 30 ms
	if got := e.puppetPhoto(lan.ID); got != "" {
		t.Fatalf("puppet photo = %q, want none", got)
	}
	var want, have *string
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT photo_want, photo_id FROM external_users WHERE account_id = $1 AND external_user_id = $2`, e.account, lan.ID).Scan(&want, &have); err != nil {
		t.Fatal(err)
	}
	if want == nil || *want != "p1" || have != nil {
		t.Fatalf("photo_want = %v, photo_id = %v; want p1 waiting", want, have)
	}
	if n := e.fake.PhotoFetches(); n != 1 {
		t.Fatalf("the failing photo was asked for %d times, want once", n)
	}
}

func TestANewPhotoOfAPersonWhoseCopyFailedIsNotHeld(t *testing.T) {
	e := newEnvWithMedia(t, true)
	broken := withPhoto(lan, "p1")
	e.fake.SetPersonPhoto(broken.PhotoRef, nil)
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &broken}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", broken, "chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào"})
	e.eventually(func() bool { return e.fake.PhotoFetches() == 1 }, func() string { return "the first photo was not asked for" })
	lan2 := withPhoto(lan, "p2")
	e.fake.SetPersonPhoto(lan2.PhotoRef, jpegOf(t, color.RGBA{G: 200, A: 255}))
	changed := e.msg("2", lan2, "ảnh mới", 1)
	changed.Conversation = "dm1"
	e.fake.Push(bridge.Event{Message: &changed})
	e.eventually(func() bool { return e.puppetPhoto(lan.ID) != "" }, func() string { return "the new photo waited behind the failed one" })
}

func TestAWaitAskedForWhileAPhotoIsReadHoldsTheOtherPhotos(t *testing.T) {
	e := newEnvWithMedia(t, true)
	minh1 := withPhoto(minh, "m1")
	e.fake.SetPersonPhoto(minh1.PhotoRef, jpegOf(t, color.RGBA{B: 200, A: 255}))
	conv := bridge.Conversation{ID: "g1", Kind: bridge.ConvGroup, Title: "Nhóm"}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("g1", e.msg("1", minh1, "chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào"})
	e.eventually(func() bool { return e.puppetPhoto(minh.ID) != "" }, func() string { return "Minh's photo did not come in" })

	// Lan's download fails with a long wait only once it is read, as Telegram's does.
	lan1 := withPhoto(lan, "p1")
	e.fake.SetPersonPhotoReadError(lan1.PhotoRef, &bridge.RateLimitError{RetryAfter: 10 * time.Minute})
	fromLan := e.msg("2", lan1, "Lan đây", 1)
	e.fake.Push(bridge.Event{Message: &fromLan})
	e.waitTexts(chatID, []string{"chào", "Lan đây"})
	e.eventually(func() bool { return e.fake.PhotoFetches() == 2 }, func() string { return "Lan's photo was not asked for" })

	// During the wait no other photo is asked for: a failure would have let Hoa's through.
	hoa := withPhoto(bridge.Participant{ID: "u-hoa", Name: "Hoa"}, "h1")
	e.fake.SetPersonPhoto(hoa.PhotoRef, jpegOf(t, color.RGBA{R: 90, G: 90, A: 255}))
	fromHoa := e.msg("3", hoa, "Hoa đây", 2)
	e.fake.Push(bridge.Event{Message: &fromHoa})
	e.waitTexts(chatID, []string{"chào", "Lan đây", "Hoa đây"})
	time.Sleep(400 * time.Millisecond) // many looks at 30 ms
	if got := e.puppetPhoto("u-hoa"); got != "" {
		t.Fatalf("Hoa's photo was copied during the wait the other app asked for: %q", got)
	}
	if n := e.fake.PhotoFetches(); n != 2 {
		t.Fatalf("photos were asked for %d times, want 2", n)
	}
}
