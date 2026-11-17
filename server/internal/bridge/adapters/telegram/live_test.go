package telegram_test

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/adapters/telegram"
	"app.local/server/internal/bridge/engine"
	"app.local/server/internal/chat"
	"app.local/server/internal/ids"
	"app.local/server/internal/linkpreview"
	"app.local/server/internal/media"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Main(m)) }

type allowAll struct{}

func (allowAll) Allow(ratelimit.Rule, string) bool { return true }

// TestLiveTelegram runs the real adapter and engine against a real Telegram
// account into a throwaway database. It is for a person to run by hand, once
// in a while, and never runs on its own:
//
//	BRIDGE_LIVE=1 BRIDGE_LIVE_DIR=/some/dir TELEGRAM_API_ID=… TELEGRAM_API_HASH=… \
//	  BRIDGE_LIVE_PHONE=+84… BRIDGE_LIVE_TITLE="part of a conversation title" \
//	  go test ./internal/bridge/adapters/telegram -run LiveTelegram -timeout 40m -v
//
// It asks for the login code and the two-step password through files in
// BRIDGE_LIVE_DIR (otp, pw), so nothing secret is typed into a command line
// or logged. It writes progress to stdout (counts, not message text) and
// stops when the file BRIDGE_LIVE_DIR/stop appears, then signs the account
// out and deletes what it imported.
func TestLiveTelegram(t *testing.T) {
	if os.Getenv("BRIDGE_LIVE") == "" {
		t.Skip("set BRIDGE_LIVE=1 to run against a real Telegram account")
	}
	dir := os.Getenv("BRIDGE_LIVE_DIR")
	apiID, _ := strconv.Atoi(os.Getenv("TELEGRAM_API_ID"))
	if dir == "" || apiID == 0 || os.Getenv("TELEGRAM_API_HASH") == "" || os.Getenv("BRIDGE_LIVE_PHONE") == "" {
		t.Fatal("BRIDGE_LIVE_DIR, TELEGRAM_API_ID, TELEGRAM_API_HASH and BRIDGE_LIVE_PHONE are required")
	}
	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	st := testdb.Open(t)
	if err := st.EnsureTenant(ctx, "primary", "hoandat.com", "hoandat.com"); err != nil {
		t.Fatal(err)
	}
	gen, _ := ids.NewSnowflake(9)
	previews := linkpreview.NewService(st.Pool(), linkpreview.NewFetcher(linkpreview.Options{}), logger)
	files, err := media.NewFilesystem(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	mediaSvc, err := media.New(media.Config{TenantID: "primary", PublicOrigin: "https://media.example.test", UploadMaxBytes: 50 << 20,
		UserQuotaBytes: 1 << 30, SessionKey: bytes.Repeat([]byte{5}, 32)}, st.Pool(), files, allowAll{}, logger)
	if err != nil {
		t.Fatal(err)
	}
	svc, err := chat.New(chat.Config{TenantID: "primary", PublicOrigin: "https://chat.example.test", AppScheme: "com.example.chat"},
		chat.Deps{Pool: st.Pool(), IDs: gen, Previews: previews, Media: mediaSvc, Limiter: allowAll{}, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Stop)
	owner, err := st.UpsertIdPUser(ctx, "primary", store.IdPProfile{Sub: "acc_live", PreferredUsername: "liveowner", Name: "live owner"})
	if err != nil {
		t.Fatal(err)
	}
	box, _ := bridge.NewSecretBox(bytes.Repeat([]byte{4}, 32), nil)
	adapter := telegram.New(telegram.Config{APIID: apiID, APIHash: os.Getenv("TELEGRAM_API_HASH")})
	t.Cleanup(adapter.Close)
	newEngine := func() *engine.Engine {
		return engine.New(engine.Config{TenantID: "primary", ReconcileEvery: 2 * time.Second},
			engine.Deps{Pool: st.Pool(), Chat: svc, Box: box, Media: mediaSvc, Adapters: map[string]bridge.Adapter{telegram.Name: adapter}, Limiter: allowAll{}, Logger: logger})
	}
	eng := newEngine()

	// Login: the code and password come from files.
	step, err := eng.StartLogin(ctx, owner.ID, telegram.Name)
	if err != nil {
		t.Fatal(err)
	}
	step, err = eng.ContinueLogin(ctx, owner.ID, step.LoginID, map[string]string{"phone": os.Getenv("BRIDGE_LIVE_PHONE")})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("LIVE: code sent; waiting for", filepath.Join(dir, "otp"))
	step, err = eng.ContinueLogin(ctx, owner.ID, step.LoginID, map[string]string{"code": waitFile(t, dir, "otp")})
	if err != nil {
		t.Fatalf("code step: %v", err)
	}
	if step.Kind == bridge.StepInput {
		fmt.Println("LIVE: two-step password needed; waiting for", filepath.Join(dir, "pw"))
		step, err = eng.ContinueLogin(ctx, owner.ID, step.LoginID, map[string]string{"password": waitFile(t, dir, "pw")})
		if err != nil {
			t.Fatalf("password step: %v", err)
		}
	}
	if step.Kind != bridge.StepDone {
		t.Fatalf("login ended at %v", step.Kind)
	}
	account := step.AccountID
	fmt.Println("LIVE: signed in; account row", account)

	runCtx, stopRun := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); eng.Run(runCtx) }()
	t.Cleanup(func() { stopRun(); <-done })

	convs, err := eng.Conversations(ctx, owner.ID, account)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[bridge.ConvKind]int{}
	for _, c := range convs {
		counts[c.Kind]++
	}
	fmt.Printf("LIVE: %d conversations: %v\n", len(convs), counts)
	want := os.Getenv("BRIDGE_LIVE_TITLE")
	var pick *engine.Conversation
	for i := range convs {
		if strings.Contains(convs[i].Title, want) {
			pick = &convs[i]
			break
		}
	}
	if pick == nil {
		t.Fatalf("no conversation whose title contains %q", want)
	}
	window := 150
	if n, err := strconv.Atoi(os.Getenv("BRIDGE_LIVE_WINDOW")); err == nil && n > 0 {
		window = n
	}
	chatID, err := eng.EnableConversation(ctx, owner.ID, account, pick.ID, window)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("LIVE: syncing a %s conversation into chat %d (window %d)\n", pick.Kind, chatID, window)

	// report prints counts only (never message text) and returns the number
	// of live messages.
	report := func(label string) (total int) {
		var own, gone int
		var first, last time.Time
		ordered := true
		rows, err := st.Pool().Query(ctx, `
			SELECT date, from_id = $2, deleted_at IS NOT NULL FROM messages
			WHERE chat_id = $1 AND from_id <> 0 AND (text <> '' OR deleted_at IS NOT NULL OR content IS NOT NULL) ORDER BY seq`, chatID, owner.ID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var prev time.Time
		for rows.Next() {
			var d time.Time
			var isOwn, isGone bool
			if err := rows.Scan(&d, &isOwn, &isGone); err != nil {
				t.Fatal(err)
			}
			if isGone {
				gone++
				continue
			}
			total++
			if isOwn {
				own++
			}
			if !prev.IsZero() && d.Before(prev) {
				ordered = false
			}
			if first.IsZero() {
				first = d
			}
			last, prev = d, d
		}
		fmt.Printf("LIVE %s: %d messages (%d the owner's; %d deleted), dates %s .. %s, in time order: %v\n",
			label, total, own, gone, first.Format("2006-01-02 15:04"), last.Format("2006-01-02 15:04"), ordered)
		return total
	}
	deadline := time.Now().Add(35 * time.Minute)
	for time.Now().Before(deadline) {
		var done bool
		_ = st.Pool().QueryRow(ctx, `SELECT backfill_done FROM external_chats WHERE chat_id = $1`, chatID).Scan(&done)
		if done {
			break
		}
		time.Sleep(2 * time.Second)
	}
	imported := report("after the first import")
	var files2 int
	_ = st.Pool().QueryRow(ctx, `SELECT count(*) FROM message_files WHERE chat_id = $1`, chatID).Scan(&files2)
	fmt.Printf("LIVE: %d imported messages carry a copied file\n", files2)

	// Restart: a second engine process imports nothing twice.
	stopRun()
	<-done
	runCtx2, stopRun2 := context.WithCancel(ctx)
	done2 := make(chan struct{})
	eng = newEngine()
	go func() { defer close(done2); eng.Run(runCtx2) }()
	time.Sleep(15 * time.Second)
	if again := report("after a restart"); again != imported {
		t.Errorf("a restart changed the message count: %d -> %d", imported, again)
	}

	fmt.Println("LIVE: watching live changes; send, edit or delete a message in Telegram; create", filepath.Join(dir, "stop"), "to end")
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(dir, "stop")); err == nil {
			break
		}
		time.Sleep(10 * time.Second)
		report("live")
	}
	stopRun2()
	<-done2
	if os.Getenv("BRIDGE_LIVE_KEEP") == "" {
		stopCtx := context.Background()
		eng = newEngine()
		if err := eng.Disconnect(stopCtx, owner.ID, account, true); err != nil {
			t.Fatalf("disconnect: %v", err)
		}
		fmt.Println("LIVE: signed out of Telegram and deleted the imported data")
	}
}

// waitFile waits for dir/name to appear and returns its trimmed contents.
func waitFile(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	for range 600 {
		if b, err := os.ReadFile(path); err == nil && len(bytes.TrimSpace(b)) > 0 {
			_ = os.Remove(path)
			return strings.TrimSpace(string(b))
		}
		time.Sleep(time.Second)
	}
	t.Fatalf("%s never appeared", path)
	return ""
}
