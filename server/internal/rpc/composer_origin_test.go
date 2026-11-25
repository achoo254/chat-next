package rpc

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/chat"
	"app.local/server/internal/ids"
	"app.local/server/internal/linkpreview"
	"app.local/server/internal/media"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store"
	"app.local/server/internal/store/testdb"
	"connectrpc.com/connect"
)

func TestMain(m *testing.M) {
	os.Exit(testdb.Main(m))
}

const composerTestTenant = "primary"

// composerEnv is a chat service behind the messages handler, with Zalo taking
// only composer text, and a user owning a Zalo-linked chat, a Telegram-linked
// chat and a plain one holding a message to forward or copy.
type composerEnv struct {
	msgs                  *messagesService
	sess                  store.Session
	zalo, telegram, plain int64
	originalSeq           int64
	st                    *store.Store
}

func newComposerEnv(t *testing.T) *composerEnv {
	t.Helper()
	ctx := context.Background()
	st := testdb.Open(t)
	if err := st.EnsureTenant(ctx, composerTestTenant, "example.test", "example.test"); err != nil {
		t.Fatal(err)
	}
	gen, err := ids.NewSnowflake(1)
	if err != nil {
		t.Fatal(err)
	}
	previews := linkpreview.NewService(st.Pool(), linkpreview.NewFetcher(linkpreview.Options{}), discard)
	objects, err := media.NewFilesystem(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	files, err := media.New(media.Config{TenantID: composerTestTenant, PublicOrigin: "https://media.example.test", UploadMaxBytes: 1 << 20,
		UserQuotaBytes: 1 << 20, SessionKey: []byte("0123456789abcdef0123456789abcdef")}, st.Pool(), objects, ratelimit.NewMemory(), discard)
	if err != nil {
		t.Fatal(err)
	}
	svc, err := chat.New(chat.Config{TenantID: composerTestTenant, PublicOrigin: "https://chat.example.test", AppScheme: "com.example.chat"},
		chat.Deps{Pool: st.Pool(), IDs: gen, Previews: previews, Limiter: ratelimit.NewMemory(), Logger: discard, Media: files})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Stop)
	svc.SetComposerOnlyApps([]string{"zalo"})

	u, err := st.UpsertIdPUser(ctx, composerTestTenant, store.IdPProfile{Sub: "acc_owner", PreferredUsername: "owner", Name: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	group := func() int64 {
		resp, err := svc.CreateGroup(ctx, u.ID, "group", nil, false)
		if err != nil {
			t.Fatal(err)
		}
		return resp.GetChat().GetId()
	}
	link := func(app string, chatID int64) {
		var account int64
		if err := st.Pool().QueryRow(ctx, `
			INSERT INTO external_accounts (owner_id, source, external_ref, secret) VALUES ($1, $2, $3, '\x00') RETURNING id`,
			u.ID, app, fmt.Sprintf("%s-%d", app, chatID)).Scan(&account); err != nil {
			t.Fatal(err)
		}
		if _, err := st.Pool().Exec(ctx, `INSERT INTO external_chats (account_id, external_chat_id, chat_id, direction) VALUES ($1, 'c1', $2, 'both')`,
			account, chatID); err != nil {
			t.Fatal(err)
		}
	}
	e := &composerEnv{
		msgs: &messagesService{chat: svc, logger: discard},
		sess: store.Session{TenantID: composerTestTenant, UserID: u.ID},
		zalo: group(), telegram: group(), plain: group(), st: st,
	}
	link("zalo", e.zalo)
	link("telegram", e.telegram)
	sent, err := svc.SendMessage(ctx, u.ID, &appv1.SendMessageRequest{ChatId: e.plain, Text: "gốc"})
	if err != nil {
		t.Fatal(err)
	}
	e.originalSeq = sent.GetMessage().GetSeq()
	return e
}

// overRPC is the context a /rpc call reaches the handler with (the auth
// interceptor attaches the session).
func (e *composerEnv) overRPC() context.Context {
	return context.WithValue(context.Background(), sessionKey{}, e.sess)
}

// sends counts the sends a chat queued for its app.
func (e *composerEnv) sends(t *testing.T, chatID int64) int {
	t.Helper()
	var n int
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM external_outbox WHERE chat_id = $1 AND op = 'send'`, chatID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func wantComposerOnly(t *testing.T, what string, err error) {
	t.Helper()
	if connect.CodeOf(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "imported_chat_composer_only") {
		t.Errorf("%s = %v, want PermissionDenied imported_chat_composer_only", what, err)
	}
}

// The apps' composers send over /rpc; an MCP tool runs the same handler in
// process. A Zalo-linked chat takes only the first; a forward or a copy is
// refused whichever way it comes; a Telegram-linked chat takes both as before.
func TestOnlyTheComposerSendsIntoAChatOfAComposerOnlyApp(t *testing.T) {
	e := newComposerEnv(t)
	ctx := context.Background()
	forward := &appv1.ForwardMessagesRequest{FromChatId: e.plain, Seqs: []int64{e.originalSeq}, ToChatId: e.zalo}

	if _, err := e.msgs.SendMessage(e.overRPC(), connect.NewRequest(&appv1.SendMessageRequest{ChatId: e.zalo, Text: "gõ trong Chat"})); err != nil {
		t.Fatalf("composer send into the Zalo chat: %v", err)
	}
	_, err := Invoke(ctx, e.sess, e.msgs.SendMessage, &appv1.SendMessageRequest{ChatId: e.zalo, Text: "gửi qua MCP"})
	wantComposerOnly(t, "MCP send into the Zalo chat", err)
	_, err = Invoke(ctx, e.sess, e.msgs.ForwardMessages, forward)
	wantComposerOnly(t, "MCP forward into the Zalo chat", err)
	_, err = e.msgs.ForwardMessages(e.overRPC(), connect.NewRequest(forward))
	wantComposerOnly(t, "forward into the Zalo chat", err)
	_, err = e.msgs.CopyMessage(e.overRPC(), connect.NewRequest(&appv1.CopyMessageRequest{FromChatId: e.plain, Seq: e.originalSeq, ToChatId: e.zalo}))
	wantComposerOnly(t, "copy into the Zalo chat", err)
	if n := e.sends(t, e.zalo); n != 1 {
		t.Fatalf("the Zalo chat queued %d sends, want only the composer's", n)
	}

	if _, err := Invoke(ctx, e.sess, e.msgs.SendMessage, &appv1.SendMessageRequest{ChatId: e.telegram, Text: "gửi qua MCP"}); err != nil {
		t.Fatalf("MCP send into the Telegram chat: %v", err)
	}
	if _, err := e.msgs.SendMessage(e.overRPC(), connect.NewRequest(&appv1.SendMessageRequest{ChatId: e.telegram, Text: "gõ trong Chat"})); err != nil {
		t.Fatalf("composer send into the Telegram chat: %v", err)
	}
	if n := e.sends(t, e.telegram); n != 2 {
		t.Fatalf("the Telegram chat queued %d sends, want 2", n)
	}
}

// file stores a document of the owner, as an upload leaves it, and returns its file_id.
func (e *composerEnv) file(t *testing.T, name string) string {
	t.Helper()
	id := fmt.Sprintf("%-22s", name)[:22]
	id = strings.ReplaceAll(id, " ", "x")
	if _, err := e.st.Pool().Exec(context.Background(), `
		INSERT INTO files (public_id, tenant_id, owner_id, kind, mime_type, size, file_name, file_hash, source_hash, object_key, sizes)
		VALUES ($1, $2, $3, 'document', 'application/pdf', 4, $4, $5, $5, $6, '[]')`,
		id, composerTestTenant, e.sess.UserID, name+".pdf", strings.Repeat("a", 64), "k/"+id); err != nil {
		t.Fatal(err)
	}
	return id
}

// A file the owner attached in the composer goes into a Zalo-linked chat like typed
// text; the same send run by an MCP tool does not.
func TestTheComposerSendsAttachedFilesIntoAChatOfAComposerOnlyApp(t *testing.T) {
	e := newComposerEnv(t)
	attached := &appv1.SendMediaRequest{ChatId: e.zalo, FileId: e.file(t, "hopdong")}
	if _, err := e.msgs.SendMedia(e.overRPC(), connect.NewRequest(attached)); err != nil {
		t.Fatalf("composer file into the Zalo chat: %v", err)
	}
	_, err := Invoke(context.Background(), e.sess, e.msgs.SendMedia, &appv1.SendMediaRequest{ChatId: e.zalo, FileId: e.file(t, "congcu")})
	wantComposerOnly(t, "MCP file into the Zalo chat", err)
	if n := e.sends(t, e.zalo); n != 1 {
		t.Fatalf("the Zalo chat queued %d sends, want only the composer's file", n)
	}
}
