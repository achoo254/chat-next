package botupdates_test

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"

	"app.local/server/internal/bottest"
	"app.local/server/internal/botupdates"
	"app.local/server/internal/sealbox"
)

var rotatedKey = bytes.Repeat([]byte{10}, 32)

func reseal(t *testing.T, env *bottest.Env, previous []byte) sealbox.Count {
	t.Helper()
	n, err := botupdates.ResealWebhookSecrets(context.Background(), env.Store.Pool(), bottest.TenantID, rotatedKey, previous)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// After SESSION_KEY rotates, a process with the previous key still delivers
// with the stored secret and moves it to the new key; the reseal role moves
// every other secret, after which the previous key can go.
func TestWebhookSecretsAcrossAKeyRotation(t *testing.T) {
	env := bottest.New(t)
	botID, user, group := talkativeBot(t, env, "rotbot")
	env.CatchUp()
	rcv := newReceiver(t, func(w http.ResponseWriter, _ delivery) { w.WriteHeader(http.StatusNoContent) })
	setHook(t, env, botID, rcv.srv.URL, botupdates.WebhookSettings{DropPending: true})

	// The api restarts with the new key and the old one as previous.
	env.StopUpdates()
	rotated := bottest.NewUpdates(t, env.Store, env.Chat)
	if err := rotated.EnableWebhooks(botupdates.WebhookOptions{
		TenantID: bottest.TenantID, SessionKey: rotatedKey, SessionKeyPrevious: bottest.WebhookKey, Local: true,
	}); err != nil {
		t.Fatal(err)
	}
	stop := bottest.RunUpdates(rotated)
	t.Cleanup(stop)
	send(t, env, user, group, "after the rotation")
	if d := rcv.wait(10 * time.Second); d.Header.Get(botupdates.HeaderSecret) != hookSecret {
		t.Fatalf("secret header = %q", d.Header.Get(botupdates.HeaderSecret))
	}
	eventually(t, "the secret moved to the new key", func() bool { return reseal(t, env, nil).Current == 1 })

	// A secret still under the old key: unreadable without it, moved with it
	// (the dispatcher stops so that it does not move the secret first).
	stop()
	setHook(t, env, botID, rcv.srv.URL, botupdates.WebhookSettings{})
	if n := reseal(t, env, nil); n.Unreadable != 1 || n.Current != 0 {
		t.Fatalf("without the previous key: %+v", n)
	}
	if n := reseal(t, env, bottest.WebhookKey); n.Resealed != 1 || n.Unreadable != 0 {
		t.Fatalf("with the previous key: %+v", n)
	}
	if n := reseal(t, env, nil); n.Current != 1 || n.Resealed != 0 || n.Unreadable != 0 {
		t.Fatalf("after the reseal: %+v", n)
	}
}
