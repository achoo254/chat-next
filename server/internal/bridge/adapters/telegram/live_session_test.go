package telegram

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

// liveSession logs in to a real Telegram account for a by-hand test and returns
// the adapter, the account and a context that lasts timeout. BRIDGE_LIVE_DIR holds
// the files phone, otp and pw; TELEGRAM_API_ID and TELEGRAM_API_HASH name the app.
// The session is ended when the test is.
func liveSession(t *testing.T, name string, timeout time.Duration) (context.Context, *Adapter, bridge.Account) {
	t.Helper()
	dir := os.Getenv("BRIDGE_LIVE_DIR")
	apiID, _ := strconv.Atoi(os.Getenv("TELEGRAM_API_ID"))
	if dir == "" || apiID == 0 || os.Getenv("TELEGRAM_API_HASH") == "" {
		t.Fatal("BRIDGE_LIVE_DIR, TELEGRAM_API_ID and TELEGRAM_API_HASH are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	t.Cleanup(cancel)
	a := New(Config{APIID: apiID, APIHash: os.Getenv("TELEGRAM_API_HASH")})
	t.Cleanup(a.Close)
	fileValue := func(file string, wait time.Duration) string {
		deadline := time.Now().Add(wait)
		for {
			if b, err := os.ReadFile(filepath.Join(dir, file)); err == nil {
				return strings.TrimSpace(string(b))
			}
			if time.Now().After(deadline) {
				t.Fatalf("file %s never appeared in BRIDGE_LIVE_DIR", file)
			}
			time.Sleep(500 * time.Millisecond)
		}
	}
	step, err := a.Login(ctx, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	for step.Kind == bridge.StepInput {
		in := map[string]string{}
		for _, f := range step.Fields {
			switch f.Name {
			case "phone":
				in[f.Name] = fileValue("phone", time.Second)
			case "code":
				in[f.Name] = fileValue("otp", 6*time.Minute)
			case "password":
				in[f.Name] = fileValue("pw", time.Second)
			}
		}
		if step, err = a.Login(ctx, step.Token, in); err != nil {
			t.Fatal(err)
		}
	}
	if step.Kind != bridge.StepDone {
		t.Fatalf("login ended at %v", step.Kind)
	}
	acct := bridge.Account{ID: name, Session: step.Session}
	t.Cleanup(func() {
		c2, cancel2 := context.WithTimeout(context.Background(), time.Minute)
		defer cancel2()
		t.Logf("logout err=%v", a.Logout(c2, acct))
	})
	return ctx, a, acct
}
