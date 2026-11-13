package api_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/accountdeleted"
	"app.local/server/internal/auth/idptest"
	"app.local/server/internal/config"
	"connectrpc.com/connect"
)

func (m *chatClients) privacy(e *env) appv1connect.PrivacyServiceClient {
	return appv1connect.NewPrivacyServiceClient(m.http, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
}

// as makes the fake IdP sign the next browser in as the account member()
// created for username.
func (e *env) as(username string) {
	e.idp.SetAccount(idptest.Account{Sub: "acc_" + username, SID: "sid-" + username, PreferredUsername: username,
		Name: strings.ToUpper(username)})
}

// reauth signs m's browser in again with a fresh IdP sign-in (prompt=login).
func (e *env) reauth(t *testing.T, m *chatClients, username string) {
	t.Helper()
	e.as(username)
	resp, body := e.signIn(t, m.http, "?reauth=1")
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `http-equiv="refresh"`) {
		t.Fatalf("reauth sign-in: %d %q", resp.StatusCode, body)
	}
}

func waitExport(t *testing.T, p appv1connect.PrivacyServiceClient) *appv1.DataExport {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := p.GetDataExport(t.Context(), connect.NewRequest(&appv1.GetDataExportRequest{}))
		if err != nil {
			t.Fatal(err)
		}
		if ex := resp.Msg.GetExport(); ex.GetStatus() == appv1.DataExportStatus_DATA_EXPORT_STATUS_READY ||
			ex.GetStatus() == appv1.DataExportStatus_DATA_EXPORT_STATUS_FAILED {
			return ex
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the export did not finish in time")
	return nil
}

func unzip(t *testing.T, body []byte) map[string][]byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	out := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		out[f.Name] = b
	}
	return out
}

func TestDataExport(t *testing.T) {
	e := newMediaEnv(t, config.StorageFilesystem, func(m *config.Media) { m.ExportDir = filepath.Join(m.Root, "exports") })
	an, binh := e.member(t, "annguyen"), e.member(t, "binhtran")
	ctx := t.Context()
	chatID := privateChat(t, an, binh)
	if _, err := an.messages.SendMessage(ctx, connect.NewRequest(&appv1.SendMessageRequest{ChatId: chatID, Text: "xin chào <b>Bình</b>", RandomId: 1})); err != nil {
		t.Fatal(err)
	}
	if _, err := binh.messages.SendMessage(ctx, connect.NewRequest(&appv1.SendMessageRequest{ChatId: chatID, Text: "tin riêng của Bình", RandomId: 2})); err != nil {
		t.Fatal(err)
	}
	ref, err := e.upload(t, an, appv1.MediaKind_MEDIA_KIND_PHOTO, "Ảnh nhà.jpg", photoWithGPS(t, 64, 48), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := an.messages.SendMedia(ctx, connect.NewRequest(&appv1.SendMediaRequest{ChatId: chatID, FileId: ref.GetFileId(), Text: "ảnh"})); err != nil {
		t.Fatal(err)
	}
	saved, err := an.chats.CreatePrivate(ctx, connect.NewRequest(&appv1.CreatePrivateRequest{UserId: an.userID}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := an.messages.SendMessage(ctx, connect.NewRequest(&appv1.SendMessageRequest{ChatId: saved.Msg.GetChat().GetId(), Text: "ghi chú riêng", RandomId: 3})); err != nil {
		t.Fatal(err)
	}

	// The app language the user picked is their data too.
	if _, err := an.users.SetLocale(ctx, connect.NewRequest(&appv1.SetLocaleRequest{Locale: "zh-CN"})); err != nil {
		t.Fatal(err)
	}

	p := an.privacy(e.env)
	state, err := p.GetDataExport(ctx, connect.NewRequest(&appv1.GetDataExportRequest{}))
	if err != nil || !state.Msg.GetAvailable() || state.Msg.GetExport() != nil || state.Msg.GetNextRequestAt() != 0 {
		t.Fatalf("initial state: %v %v", state, err)
	}
	req, err := p.RequestDataExport(ctx, connect.NewRequest(&appv1.RequestDataExportRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	next := req.Msg.GetNextRequestAt()
	if want := time.Now().Add(7 * 24 * time.Hour).Unix(); next < want-60 || next > want+60 {
		t.Fatalf("next request at %d, want about %d", next, want)
	}
	// One per 7 days.
	if _, err := p.RequestDataExport(ctx, connect.NewRequest(&appv1.RequestDataExportRequest{})); codeOf(err) != connect.CodeResourceExhausted ||
		!strings.Contains(err.Error(), "export_rate_limited") {
		t.Fatalf("second request: %v", err)
	}
	ex := waitExport(t, p)
	if ex.GetStatus() != appv1.DataExportStatus_DATA_EXPORT_STATUS_READY || ex.GetSize() == 0 ||
		ex.GetExpiresAt()-ex.GetReadyAt() != int64(30*24*3600) || !strings.HasPrefix(ex.GetFileName(), "chat-export-annguyen-") {
		t.Fatalf("export = %v", ex)
	}

	// Only the owner gets a URL.
	if _, err := binh.privacy(e.env).GetDataExportUrl(ctx, connect.NewRequest(&appv1.GetDataExportUrlRequest{ExportId: ex.GetId()})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("someone else's export: %v", err)
	}
	link, err := p.GetDataExportUrl(ctx, connect.NewRequest(&appv1.GetDataExportUrlRequest{ExportId: ex.GetId()}))
	if err != nil {
		t.Fatal(err)
	}
	resp := e.fetch(t, http.MethodGet, link.Msg.GetUrl(), nil, nil)
	body := []byte(readBody(t, resp))
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "application/zip" ||
		!strings.Contains(resp.Header.Get("Content-Disposition"), ex.GetFileName()) || resp.Header.Get("Set-Cookie") != "" {
		t.Fatalf("download: %d %v", resp.StatusCode, resp.Header)
	}
	files := unzip(t, body)
	for _, name := range []string{"README.txt", "index.html", "profile.json", "contacts.json", "blocked.json", "sessions.json",
		"bots.json", "chats.json", "messages/" + strconv.FormatInt(chatID, 10) + ".json", "chats/" + strconv.FormatInt(chatID, 10) + ".html"} {
		if _, ok := files[name]; !ok {
			t.Errorf("missing %s", name)
		}
	}
	var profile struct {
		Username string `json:"username"`
		Locale   string `json:"locale"`
	}
	if err := json.Unmarshal(files["profile.json"], &profile); err != nil || profile.Username != "annguyen" || profile.Locale != "zh-CN" {
		t.Fatalf("profile.json: %s %v", files["profile.json"], err)
	}
	messages := string(files["messages/"+strconv.FormatInt(chatID, 10)+".json"])
	if !strings.Contains(messages, "xin chào") || strings.Contains(messages, "tin riêng của Bình") {
		t.Fatalf("messages: %s", messages)
	}
	var sent []struct {
		Files []struct {
			Path     string `json:"path"`
			Included bool   `json:"included"`
		} `json:"files"`
	}
	if err := json.Unmarshal([]byte(messages), &sent); err != nil || len(sent) != 2 || len(sent[1].Files) != 1 || !sent[1].Files[0].Included {
		t.Fatalf("messages with the photo: %s %v", messages, err)
	}
	if photo := files[sent[1].Files[0].Path]; len(photo) == 0 || bytes.Contains(photo, []byte(gpsMarker)) {
		t.Fatalf("photo %s: %d bytes", sent[1].Files[0].Path, len(photo))
	}
	if !strings.Contains(string(files["chats.json"]), "Cloud của tôi") || !strings.Contains(string(files["index.html"]), "BINHTRAN") {
		t.Fatalf("chats: %s", files["chats.json"])
	}
	page := string(files["chats/"+strconv.FormatInt(chatID, 10)+".html"])
	if !strings.Contains(page, "xin chào &lt;b&gt;Bình&lt;/b&gt;") || strings.Contains(page, "<b>Bình</b>") {
		t.Fatalf("the chat page does not escape text: %s", page)
	}

	// A forged or tampered token opens nothing.
	resp = e.fetch(t, http.MethodGet, link.Msg.GetUrl()+"x", nil, nil)
	if _ = readBody(t, resp); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("tampered token: %d", resp.StatusCode)
	}

	// 30 days later the file is gone.
	if _, err := e.store.Pool().Exec(ctx, `UPDATE data_exports SET expires_at = now() - interval '1 minute'`); err != nil {
		t.Fatal(err)
	}
	var fileName string
	if err := e.store.Pool().QueryRow(ctx, `SELECT file_name FROM data_exports`).Scan(&fileName); err != nil {
		t.Fatal(err)
	}
	e.app.Privacy.RunJobs(ctx)
	if _, err := os.Stat(filepath.Join(e.root, "exports", fileName)); !os.IsNotExist(err) {
		t.Fatalf("expired export still on disk: %v", err)
	}
	resp = e.fetch(t, http.MethodGet, link.Msg.GetUrl(), nil, nil)
	if _ = readBody(t, resp); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expired download: %d", resp.StatusCode)
	}
	if _, err := p.GetDataExportUrl(ctx, connect.NewRequest(&appv1.GetDataExportUrlRequest{ExportId: ex.GetId()})); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("URL of an expired export: %v", err)
	}
	// A week after the request a new one is allowed.
	if _, err := e.store.Pool().Exec(ctx, `UPDATE data_exports SET created_at = now() - interval '8 days'`); err != nil {
		t.Fatal(err)
	}
	if _, err := p.RequestDataExport(ctx, connect.NewRequest(&appv1.RequestDataExportRequest{})); err != nil {
		t.Fatalf("request after a week: %v", err)
	}
}

// deletedAtIdP pushes the IdP's account.deleted SET for sub, as auth-next
// does (ADR 0016); mod changes the claims (or returns a typ to sign with)
// to build bad events. It returns the status.
func (e *env) deletedAtIdP(t *testing.T, sub string, mod func(claims map[string]any) string) int {
	t.Helper()
	now := time.Now()
	claims := map[string]any{
		"iss": e.idp.Issuer(), "aud": e.srv.URL + accountdeleted.Path, "sub": sub, "jti": "del-" + sub,
		"iat": now.Unix(), "exp": now.Add(10 * time.Minute).Unix(), "toe": now.Unix(),
		"events": map[string]any{accountdeleted.Event: map[string]any{}},
	}
	typ := "secevent+jwt"
	if mod != nil {
		if v := mod(claims); v != "" {
			typ = v
		}
	}
	set, err := e.idp.Sign(claims, typ)
	if err != nil {
		t.Fatal(err)
	}
	return e.postSET(t, set)
}

func (e *env) postSET(t *testing.T, body string) int {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, e.srv.URL+accountdeleted.Path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/secevent+jwt")
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = readBody(t, resp)
	return resp.StatusCode
}

// TestAccountDeletedAtIdP: the IdP's event erases the account at once.
// Its groups pass to the admin (highest role) or, among members, to the
// earliest joiner, a group nobody else is in goes with it, its bots are
// deleted, and the messages it sent elsewhere stay from a deleted account.
func TestAccountDeletedAtIdP(t *testing.T) {
	e := newEnv(t)
	an, binh, chi := e.member(t, "annguyen"), e.member(t, "binhtran"), e.member(t, "chile")
	ctx := t.Context()
	// Contacts both ways, so An may add them to groups.
	for _, pair := range []struct {
		from *chatClients
		to   string
	}{{an, "binhtran"}, {an, "chile"}, {binh, "annguyen"}, {chi, "annguyen"}} {
		if _, err := pair.from.users.AddContact(ctx, connect.NewRequest(&appv1.AddContactRequest{Target: &appv1.AddContactRequest_Username{Username: pair.to}})); err != nil {
			t.Fatal(err)
		}
	}
	// Bình joins first, Chi later but as admin: Chi takes the group over.
	withAdmin, err := an.chats.CreateGroup(ctx, connect.NewRequest(&appv1.CreateGroupRequest{Title: "Trực sự cố", UserIds: []int64{binh.userID}}))
	if err != nil || len(withAdmin.Msg.GetFailures()) != 0 {
		t.Fatalf("group: %v %v", withAdmin, err)
	}
	withAdminID := withAdmin.Msg.GetChat().GetId()
	if _, err := an.chats.AddMembers(ctx, connect.NewRequest(&appv1.AddMembersRequest{ChatId: withAdminID, UserIds: []int64{chi.userID}})); err != nil {
		t.Fatal(err)
	}
	if _, err := an.chats.SetAdmin(ctx, connect.NewRequest(&appv1.SetAdminRequest{ChatId: withAdminID, UserId: chi.userID, Admin: true})); err != nil {
		t.Fatal(err)
	}
	// Members only: the earliest joiner (Bình) takes it over.
	membersOnly, err := an.chats.CreateGroup(ctx, connect.NewRequest(&appv1.CreateGroupRequest{Title: "Cà phê", UserIds: []int64{binh.userID}}))
	if err != nil {
		t.Fatal(err)
	}
	membersOnlyID := membersOnly.Msg.GetChat().GetId()
	if _, err := an.chats.AddMembers(ctx, connect.NewRequest(&appv1.AddMembersRequest{ChatId: membersOnlyID, UserIds: []int64{chi.userID}})); err != nil {
		t.Fatal(err)
	}
	// Nobody else: deleted with the account.
	alone, err := an.chats.CreateGroup(ctx, connect.NewRequest(&appv1.CreateGroupRequest{Title: "Ghi chú nhóm"}))
	if err != nil {
		t.Fatal(err)
	}
	aloneID := alone.Msg.GetChat().GetId()
	// A bot of An, with a token.
	e.reauth(t, an, "annguyen")
	admin := appv1connect.NewBotAdminServiceClient(an.http, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	bot, err := admin.CreateBot(ctx, connect.NewRequest(&appv1.CreateBotRequest{Username: "an_deploy_bot", Name: "Deploy"}))
	if err != nil {
		t.Fatal(err)
	}
	botID := bot.Msg.GetBot().GetUser().GetId()
	reset, err := admin.ResetBotToken(ctx, connect.NewRequest(&appv1.ResetBotTokenRequest{BotId: botID}))
	if err != nil {
		t.Fatal(err)
	}
	token := reset.Msg.GetToken()
	chatID := privateChat(t, an, binh)
	sent, err := an.messages.SendMessage(ctx, connect.NewRequest(&appv1.SendMessageRequest{ChatId: chatID, Text: "hẹn gặp lại", RandomId: 9}))
	if err != nil {
		t.Fatal(err)
	}
	revokedBefore := len(e.idp.Revoked())
	if status := e.deletedAtIdP(t, "acc_annguyen", nil); status != http.StatusAccepted {
		t.Fatalf("event: %d", status)
	}

	// Every session ended, the IdP grant revoked.
	if _, err := getSelf(t, an.clients); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("old session after deletion: %v", err)
	}
	waitFor(t, func() bool { return len(e.idp.Revoked()) > revokedBefore })
	var username, name string
	var idpSub *string
	var deleted *time.Time
	if err := e.store.Pool().QueryRow(ctx, `SELECT username, name, idp_sub, deleted_at FROM users WHERE id = $1`, an.userID).
		Scan(&username, &name, &idpSub, &deleted); err != nil {
		t.Fatal(err)
	}
	if username != "deleted_"+strconv.FormatInt(an.userID, 10) || name != "" || idpSub != nil || deleted == nil {
		t.Fatalf("erased account: %q %q %v %v", username, name, idpSub, deleted)
	}
	var sessions, contacts int
	if err := e.store.Pool().QueryRow(ctx, `
		SELECT (SELECT count(*) FROM user_sessions WHERE user_id = $1), (SELECT count(*) FROM contacts WHERE contact_id = $1 OR owner_id = $1)`,
		an.userID).Scan(&sessions, &contacts); err != nil || sessions != 0 || contacts != 0 {
		t.Fatalf("sessions %d contacts %d %v", sessions, contacts, err)
	}

	// The groups changed hands; the one nobody else was in is gone.
	owner := func(chatID int64) int64 {
		t.Helper()
		members, err := binh.chats.GetMembers(ctx, connect.NewRequest(&appv1.GetMembersRequest{ChatId: chatID}))
		if err != nil {
			t.Fatal(err)
		}
		var owners []int64
		for _, m := range members.Msg.GetMembers() {
			if m.GetUserId() == an.userID {
				t.Fatalf("the erased account is still in chat %d", chatID)
			}
			if m.GetRole() == appv1.MemberRole_MEMBER_ROLE_OWNER {
				owners = append(owners, m.GetUserId())
			}
		}
		if len(owners) != 1 {
			t.Fatalf("owners of chat %d: %v", chatID, owners)
		}
		return owners[0]
	}
	if got := owner(withAdminID); got != chi.userID {
		t.Fatalf("owner with an admin: %d, want chi %d", got, chi.userID)
	}
	if got := owner(membersOnlyID); got != binh.userID {
		t.Fatalf("owner among members: %d, want binh %d", got, binh.userID)
	}
	var aloneGone bool
	if err := e.store.Pool().QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM chats WHERE id = $1`, aloneID).Scan(&aloneGone); err != nil || !aloneGone {
		t.Fatalf("group with nobody else: deleted %v %v", aloneGone, err)
	}

	// The bot is deleted and its token refused.
	if status, _ := e.botCall(t, http.MethodGet, "/bot/v1/me", token, ""); status != http.StatusUnauthorized {
		t.Fatalf("bot of a deleted account: %d", status)
	}
	var botName string
	var botGone bool
	if err := e.store.Pool().QueryRow(ctx, `SELECT u.username, b.deleted_at IS NOT NULL FROM bots b JOIN users u ON u.id = b.user_id WHERE b.user_id = $1`,
		botID).Scan(&botName, &botGone); err != nil || !botGone || botName == "an_deploy_bot" {
		t.Fatalf("bot after the erasure: %q %v %v", botName, botGone, err)
	}

	// Bình keeps the message, from a deleted account it cannot write to or find.
	history, err := binh.messages.GetHistory(ctx, connect.NewRequest(&appv1.GetHistoryRequest{ChatId: chatID, Limit: 10}))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range history.Msg.GetMessages() {
		if m.GetSeq() == sent.Msg.GetMessage().GetSeq() && m.GetFromId() == an.userID && m.GetText() == "hẹn gặp lại" {
			found = true
		}
	}
	if !found {
		t.Fatalf("history after the erasure: %v", history.Msg.GetMessages())
	}
	for _, u := range history.Msg.GetUsers() {
		if u.GetId() == an.userID && (!u.GetDeleted() || u.GetName() != "") {
			t.Fatalf("author after the erasure: %v", u)
		}
	}
	if _, err := binh.messages.SendMessage(ctx, connect.NewRequest(&appv1.SendMessageRequest{ChatId: chatID, Text: "còn đó không?", RandomId: 10})); codeOf(err) != connect.CodeFailedPrecondition ||
		!strings.Contains(err.Error(), "account_deleted") {
		t.Fatalf("writing to a deleted account: %v", err)
	}
	if _, err := binh.users.ResolveUsername(ctx, connect.NewRequest(&appv1.ResolveUsernameRequest{Username: "annguyen"})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("resolving a deleted account: %v", err)
	}

	// The IdP retries with the same SET, and sends events for accounts the
	// chat never had: both accepted, nothing changes.
	if status := e.deletedAtIdP(t, "acc_annguyen", nil); status != http.StatusAccepted {
		t.Fatalf("repeated event: %d", status)
	}
	if status := e.deletedAtIdP(t, "acc_nobody", nil); status != http.StatusAccepted {
		t.Fatalf("event for an unknown account: %d", status)
	}
	if strings.Contains(e.logs.String(), "acc_annguyen") || strings.Contains(e.logs.String(), "acc_nobody") {
		t.Fatal("the sub of a deleted account reached the log")
	}
}

// TestAccountDeletionEventRejected: only a valid SET for this endpoint
// deletes anything; a body that is not a SET is 400, a SET that fails is
// 401, so the IdP retries until its configuration is fixed.
func TestAccountDeletionEventRejected(t *testing.T) {
	e := newEnv(t)
	an := e.member(t, "annguyen")
	for _, tc := range []struct {
		name   string
		status int
		mod    func(map[string]any) string
		body   string
	}{
		{name: "empty body", status: http.StatusBadRequest, body: " "},
		{name: "not a JWS", status: http.StatusBadRequest, body: "a.b.c"},
		{name: "access token typ", status: http.StatusBadRequest, mod: func(map[string]any) string { return "at+jwt" }},
		{name: "logout token typ", status: http.StatusBadRequest, mod: func(map[string]any) string { return "logout+jwt" }},
		{name: "other endpoint", status: http.StatusUnauthorized, mod: func(c map[string]any) string { c["aud"] = e.srv.URL + "/api/account-notices"; return "" }},
		{name: "other issuer", status: http.StatusUnauthorized, mod: func(c map[string]any) string { c["iss"] = "https://idp.example.test"; return "" }},
		{name: "expired", status: http.StatusUnauthorized, mod: func(c map[string]any) string { c["exp"] = time.Now().Add(-time.Hour).Unix(); return "" }},
		{name: "no exp", status: http.StatusUnauthorized, mod: func(c map[string]any) string { delete(c, "exp"); return "" }},
		{name: "other event", status: http.StatusUnauthorized, mod: func(c map[string]any) string {
			c["events"] = map[string]any{"urn:hoandat:auth:event:account.updated": map[string]any{}}
			return ""
		}},
		{name: "no jti", status: http.StatusUnauthorized, mod: func(c map[string]any) string { delete(c, "jti"); return "" }},
		{name: "no sub", status: http.StatusUnauthorized, mod: func(c map[string]any) string { delete(c, "sub"); return "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var status int
			if tc.body != "" {
				status = e.postSET(t, tc.body)
			} else {
				status = e.deletedAtIdP(t, "acc_annguyen", tc.mod)
			}
			if status != tc.status {
				t.Fatalf("status %d, want %d", status, tc.status)
			}
		})
	}
	if _, err := getSelf(t, an.clients); err != nil {
		t.Fatalf("the account after rejected events: %v", err)
	}
	resp, err := e.srv.Client().Get(e.srv.URL + accountdeleted.Path)
	if err != nil {
		t.Fatal(err)
	}
	if _ = readBody(t, resp); resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", resp.StatusCode)
	}
}

// TestQueuedErasureFinishedByJob: an account whose erasure is queued but
// not done (an erasure cut short, or an account left in the 30-day grace
// period of the chat's former own deletion) is locked, and the privacy
// job erases it at once.
func TestQueuedErasureFinishedByJob(t *testing.T) {
	e := newEnv(t)
	an, binh := e.member(t, "annguyen"), e.member(t, "binhtran")
	ctx := t.Context()
	for _, pair := range []struct {
		from *chatClients
		to   string
	}{{an, "binhtran"}, {binh, "annguyen"}} {
		if _, err := pair.from.users.AddContact(ctx, connect.NewRequest(&appv1.AddContactRequest{Target: &appv1.AddContactRequest_Username{Username: pair.to}})); err != nil {
			t.Fatal(err)
		}
	}
	group, err := an.chats.CreateGroup(ctx, connect.NewRequest(&appv1.CreateGroupRequest{Title: "Nhóm", UserIds: []int64{binh.userID}}))
	if err != nil || len(group.Msg.GetFailures()) != 0 {
		t.Fatalf("group: %v %v", group, err)
	}
	if _, err := e.store.Pool().Exec(ctx, `UPDATE users SET deletion_requested_at = now() - interval '3 days', deletion_reason = 'user' WHERE id = $1`,
		an.userID); err != nil {
		t.Fatal(err)
	}
	// Locked meanwhile: a session there may only learn it is signed out.
	if _, err := getSelf(t, an.clients); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("GetSelf of a queued account: %v", err)
	}
	if _, err := an.chats.GetDialogs(ctx, connect.NewRequest(&appv1.GetDialogsRequest{})); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("dialogs of a queued account: %v", err)
	}

	e.app.Privacy.RunJobs(ctx)
	var deleted bool
	if err := e.store.Pool().QueryRow(ctx, `SELECT deleted_at IS NOT NULL AND idp_sub IS NULL FROM users WHERE id = $1`, an.userID).Scan(&deleted); err != nil || !deleted {
		t.Fatalf("erased by the job: %v %v", deleted, err)
	}
	members, err := binh.chats.GetMembers(ctx, connect.NewRequest(&appv1.GetMembersRequest{ChatId: group.Msg.GetChat().GetId()}))
	if err != nil {
		t.Fatal(err)
	}
	if len(members.Msg.GetMembers()) != 1 || members.Msg.GetMembers()[0].GetUserId() != binh.userID ||
		members.Msg.GetMembers()[0].GetRole() != appv1.MemberRole_MEMBER_ROLE_OWNER {
		t.Fatalf("members after the erasure: %v", members.Msg.GetMembers())
	}
}

// waitFor polls cond for up to 5 seconds.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached in time")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Members of the groups of a person whose account is deleted learn it at
// once (user_changed with the user as they see it now), not only when that
// person shows up again in an update.
func TestAccountDeletionTellsGroupMembers(t *testing.T) {
	e := newEnv(t)
	an, binh, chi := e.member(t, "annguyen"), e.member(t, "binhtran"), e.member(t, "chile")
	ctx := t.Context()
	for _, m := range []*chatClients{an, chi} {
		if _, err := m.users.AddContact(ctx, connect.NewRequest(&appv1.AddContactRequest{Target: &appv1.AddContactRequest_Username{Username: "binhtran"}})); err != nil {
			t.Fatal(err)
		}
	}
	group, err := binh.chats.CreateGroup(ctx, connect.NewRequest(&appv1.CreateGroupRequest{Title: "Trực ca", UserIds: []int64{an.userID, chi.userID}}))
	if err != nil || len(group.Msg.GetFailures()) != 0 {
		t.Fatalf("group: %v, %v", group, err)
	}
	start := rpcOK(t, chi.updates.GetState, &appv1.GetStateRequest{}).GetState()
	if status := e.deletedAtIdP(t, "acc_annguyen", nil); status != http.StatusAccepted {
		t.Fatalf("event: %d", status)
	}
	diff := rpcOK(t, chi.updates.GetDifference, &appv1.GetDifferenceRequest{Pts: start.GetPts(), ServerEpoch: start.GetServerEpoch()}).GetFull()
	told := false
	for _, u := range diff.GetUpdates() {
		if u.GetUserChanged().GetUserId() == an.userID {
			told = true
		}
	}
	deleted := false
	for _, u := range diff.GetUsers() {
		if u.GetId() == an.userID {
			deleted = u.GetDeleted() && u.GetName() == ""
		}
	}
	if !told || !deleted {
		t.Fatalf("chi's difference: told %v, deleted %v: %v", told, deleted, diff)
	}
}
