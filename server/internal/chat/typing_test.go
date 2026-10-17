package chat

import (
	"context"
	"slices"
	"testing"

	appv1 "app.local/server/gen/app/v1"
)

func TestTypingViewersFollowActivityPrivacy(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b, c, d := h.user("a"), h.user("b"), h.user("c"), h.user("d")
	g := h.group(a, b, c, d)
	viewers := func(typer int64, bot bool, viewing ...int64) []int64 {
		t.Helper()
		ids, _, err := h.svc.TypingViewers(ctx, g, typer, bot, viewing)
		if err != nil {
			t.Fatal(err)
		}
		slices.Sort(ids)
		return ids
	}
	// Activity status "my contacts": only people a listed see a typing.
	contacts := appv1.PrivacyAudience_PRIVACY_AUDIENCE_CONTACTS
	if _, err := h.svc.SetPrivacy(ctx, a, &appv1.SetPrivacyRequest{LastSeen: &contacts}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.AddContact(ctx, a, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: b}}); err != nil {
		t.Fatal(err)
	}
	if got := viewers(a, false); !slices.Equal(got, []int64{b}) {
		t.Fatalf("contacts only: %v, want [%d]", got, b)
	}
	// "Everyone": every member, except across a block in either direction.
	everyone := appv1.PrivacyAudience_PRIVACY_AUDIENCE_EVERYONE
	if _, err := h.svc.SetPrivacy(ctx, a, &appv1.SetPrivacyRequest{LastSeen: &everyone}); err != nil {
		t.Fatal(err)
	}
	if got := viewers(a, false); !slices.Equal(got, []int64{b, c, d}) {
		t.Fatalf("everyone: %v, want [%d %d %d]", got, b, c, d)
	}
	if err := h.svc.Block(ctx, a, c); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Block(ctx, d, a); err != nil {
		t.Fatal(err)
	}
	if got := viewers(a, false); !slices.Equal(got, []int64{b}) {
		t.Fatalf("everyone but blocks: %v, want [%d]", got, b)
	}
	// "Nobody" hides it from all; a bot's chat actions ignore privacy.
	nobody := appv1.PrivacyAudience_PRIVACY_AUDIENCE_NOBODY
	if _, err := h.svc.SetPrivacy(ctx, a, &appv1.SetPrivacyRequest{LastSeen: &nobody}); err != nil {
		t.Fatal(err)
	}
	if got := viewers(a, false); len(got) != 0 {
		t.Fatalf("nobody: %v", got)
	}
	if got := viewers(b, true); !slices.Equal(got, []int64{a, c, d}) {
		t.Fatalf("bot action: %v, want every other member", got)
	}
	// A large chat only considers who views it.
	if _, err := h.st.Pool().Exec(ctx, `UPDATE chats SET sync_mode = 'large' WHERE id = $1`, g); err != nil {
		t.Fatal(err)
	}
	if got := viewers(b, true); len(got) != 0 {
		t.Fatalf("large chat, nobody viewing: %v", got)
	}
	if _, large, _ := h.svc.TypingViewers(ctx, g, b, true, []int64{d}); !large {
		t.Fatal("the chat is large")
	}
	if got := viewers(b, true, d, 999); !slices.Equal(got, []int64{d}) {
		t.Fatalf("large chat viewers: %v, want [%d]", got, d)
	}
}
