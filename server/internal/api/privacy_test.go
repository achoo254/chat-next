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
	}
	if err := json.Unmarshal(files["profile.json"], &profile); err != nil || profile.Username != "annguyen" {
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

// fastForward ends the grace period of every account waiting for deletion
// and runs the privacy jobs.
func (e *env) fastForward(t *testing.T) {
	t.Helper()
	if _, err := e.store.Pool().Exec(t.Context(), `
		UPDATE users SET deletion_requested_at = deletion_requested_at - interval '31 days'
		WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL`); err != nil {
		t.Fatal(err)
	}
	e.app.Privacy.RunJobs(t.Context())
}

func TestAccountDeletionGraceCancelAndErase(t *testing.T) {
	e := newEnv(t)
	an, binh := e.member(t, "annguyen"), e.member(t, "binhtran")
	ctx := t.Context()
	p := an.privacy(e)

	// A group An owns blocks the deletion.
	group, err := an.chats.CreateGroup(ctx, connect.NewRequest(&appv1.CreateGroupRequest{Title: "Trực sự cố"}))
	if err != nil {
		t.Fatal(err)
	}
	groupID := group.Msg.GetChat().GetId()
	// A bot of An, with a token.
	admin := appv1connect.NewBotAdminServiceClient(an.http, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	bot, err := admin.CreateBot(ctx, connect.NewRequest(&appv1.CreateBotRequest{Username: "an_deploy_bot", Name: "Deploy"}))
	if err != nil {
		t.Fatal(err)
	}
	botID := bot.Msg.GetBot().GetUser().GetId()
	chatID := privateChat(t, an, binh)
	sent, err := an.messages.SendMessage(ctx, connect.NewRequest(&appv1.SendMessageRequest{ChatId: chatID, Text: "hẹn gặp lại", RandomId: 9}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := binh.users.AddContact(ctx, connect.NewRequest(&appv1.AddContactRequest{Target: &appv1.AddContactRequest_Username{Username: "annguyen"}})); err != nil {
		t.Fatal(err)
	}

	// Without a recent IdP sign-in: reauth first.
	if _, err := p.DeleteAccount(ctx, connect.NewRequest(&appv1.DeleteAccountRequest{Confirmation: "annguyen"})); codeOf(err) != connect.CodeFailedPrecondition ||
		!strings.Contains(err.Error(), "reauth_required") {
		t.Fatalf("delete without reauth: %v", err)
	}
	e.reauth(t, an, "annguyen")
	reset, err := admin.ResetBotToken(ctx, connect.NewRequest(&appv1.ResetBotTokenRequest{BotId: botID}))
	if err != nil {
		t.Fatal(err)
	}
	token := reset.Msg.GetToken()
	info, err := p.GetAccountDeletion(ctx, connect.NewRequest(&appv1.GetAccountDeletionRequest{}))
	if err != nil || len(info.Msg.GetOwnedChats()) != 1 || info.Msg.GetOwnedChats()[0].GetChatId() != groupID ||
		len(info.Msg.GetBots()) != 1 || info.Msg.GetBots()[0].GetUsername() != "an_deploy_bot" || info.Msg.GetGraceDays() != 30 ||
		time.Since(time.Unix(info.Msg.GetSignedInAt(), 0)) > time.Minute {
		t.Fatalf("deletion info: %v %v", info, err)
	}
	if _, err := p.DeleteAccount(ctx, connect.NewRequest(&appv1.DeleteAccountRequest{Confirmation: "annguyen"})); codeOf(err) != connect.CodeFailedPrecondition ||
		!strings.Contains(err.Error(), "owns_chats") {
		t.Fatalf("delete while owning a group: %v", err)
	}
	if _, err := an.chats.DeleteChat(ctx, connect.NewRequest(&appv1.DeleteChatRequest{ChatId: groupID})); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DeleteAccount(ctx, connect.NewRequest(&appv1.DeleteAccountRequest{Confirmation: "binhtran"})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("wrong confirmation: %v", err)
	}
	revokedBefore := len(e.idp.Revoked())
	del, err := p.DeleteAccount(ctx, connect.NewRequest(&appv1.DeleteAccountRequest{Confirmation: " @ANNGUYEN "}))
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Now().Add(30 * 24 * time.Hour).Unix(); del.Msg.GetPurgeAt() < want-60 || del.Msg.GetPurgeAt() > want+60 {
		t.Fatalf("purge at %d", del.Msg.GetPurgeAt())
	}

	// Locked: every session ended, the IdP grant revoked.
	if _, err := getSelf(t, an.clients); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("old session after deletion: %v", err)
	}
	waitFor(t, func() bool { return len(e.idp.Revoked()) > revokedBefore })
	// Others see a deleted account and cannot write to it or find it.
	users, err := binh.users.GetUsers(ctx, connect.NewRequest(&appv1.GetUsersRequest{UserIds: []int64{an.userID}}))
	if err != nil || len(users.Msg.GetUsers()) != 1 || !users.Msg.GetUsers()[0].GetDeleted() || users.Msg.GetUsers()[0].GetName() != "" ||
		users.Msg.GetUsers()[0].GetUsername() != "" {
		t.Fatalf("binh sees: %v %v", users, err)
	}
	if _, err := binh.messages.SendMessage(ctx, connect.NewRequest(&appv1.SendMessageRequest{ChatId: chatID, Text: "còn đó không?", RandomId: 10})); codeOf(err) != connect.CodeFailedPrecondition ||
		!strings.Contains(err.Error(), "account_deleted") {
		t.Fatalf("writing to a deleted account: %v", err)
	}
	if _, err := binh.users.ResolveUsername(ctx, connect.NewRequest(&appv1.ResolveUsernameRequest{Username: "annguyen"})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("resolving a deleted account: %v", err)
	}
	// Its bot is stopped.
	if status, _ := e.botCall(t, http.MethodGet, "/bot/v1/me", token, ""); status != http.StatusUnauthorized {
		t.Fatalf("bot of a deleted account: %d", status)
	}

	// Signing in during the grace period: only cancelling works.
	e.as("annguyen")
	back, browser := e.signedIn(t)
	self, err := back.users.GetSelf(ctx, connect.NewRequest(&appv1.GetSelfRequest{}))
	if err != nil || self.Msg.GetUser().GetId() != an.userID ||
		self.Msg.GetDeletion().GetReason() != appv1.AccountDeletionReason_ACCOUNT_DELETION_REASON_USER ||
		self.Msg.GetDeletion().GetPurgeAt() != del.Msg.GetPurgeAt() {
		t.Fatalf("GetSelf in the grace period: %v %v", self, err)
	}
	backChats := appv1connect.NewChatsServiceClient(browser, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
	if _, err := backChats.GetDialogs(ctx, connect.NewRequest(&appv1.GetDialogsRequest{})); codeOf(err) != connect.CodeFailedPrecondition ||
		!strings.Contains(err.Error(), "account_pending_deletion") {
		t.Fatalf("dialogs in the grace period: %v", err)
	}
	if _, resp, err := e.dial(t, &chatClients{http: browser}, e.srv.URL); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("websocket in the grace period: %v %v", resp, err)
	}
	backPrivacy := (&chatClients{http: browser}).privacy(e)
	if _, err := backPrivacy.CancelAccountDeletion(ctx, connect.NewRequest(&appv1.CancelAccountDeletionRequest{})); err != nil {
		t.Fatal(err)
	}
	if _, err := backChats.GetDialogs(ctx, connect.NewRequest(&appv1.GetDialogsRequest{})); err != nil {
		t.Fatalf("dialogs after cancelling: %v", err)
	}
	if status, _ := e.botCall(t, http.MethodGet, "/bot/v1/me", token, ""); status != http.StatusOK {
		t.Fatalf("bot after cancelling: %d", status)
	}
	users, err = binh.users.GetUsers(ctx, connect.NewRequest(&appv1.GetUsersRequest{UserIds: []int64{an.userID}}))
	if err != nil || users.Msg.GetUsers()[0].GetDeleted() || users.Msg.GetUsers()[0].GetUsername() != "annguyen" {
		t.Fatalf("binh sees after cancelling: %v %v", users, err)
	}

	// Delete again and let the grace period pass.
	backAn := &chatClients{clients: back, http: browser, userID: an.userID}
	e.reauth(t, backAn, "annguyen")
	if _, err := backPrivacy.DeleteAccount(ctx, connect.NewRequest(&appv1.DeleteAccountRequest{Confirmation: "annguyen"})); err != nil {
		t.Fatal(err)
	}
	e.fastForward(t)

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
	// Left: only the private chat Bình keeps; the saved chat and the chat
	// with the assistant bot are gone.
	var chatsLeft []int64
	rows, err := e.store.Pool().Query(ctx, `
		SELECT c.id FROM chat_members m JOIN chats c ON c.id = m.chat_id
		WHERE m.user_id = $1 AND m.left_at IS NULL AND c.deleted_at IS NULL ORDER BY c.id`, an.userID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		chatsLeft = append(chatsLeft, id)
	}
	if rows.Err() != nil || len(chatsLeft) != 1 || chatsLeft[0] != chatID {
		t.Fatalf("chats of the erased account: %v %v", chatsLeft, rows.Err())
	}
	var botName string
	var botGone bool
	if err := e.store.Pool().QueryRow(ctx, `SELECT u.username, b.deleted_at IS NOT NULL FROM bots b JOIN users u ON u.id = b.user_id WHERE b.user_id = $1`,
		botID).Scan(&botName, &botGone); err != nil || !botGone || botName == "an_deploy_bot" {
		t.Fatalf("bot after the erasure: %q %v %v", botName, botGone, err)
	}
	// The message to Bình stays, from a deleted account.
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

	// Signing in again creates a new, empty account with the username free.
	e.as("annguyen")
	fresh, _ := e.signedIn(t)
	again, err := getSelf(t, fresh)
	if err != nil || again.GetId() == an.userID || again.GetUsername() != "annguyen" {
		t.Fatalf("new account: %v %v", again, err)
	}
}

func TestAutoDeleteWhenUnused(t *testing.T) {
	e := newEnv(t)
	an, binh := e.member(t, "annguyen"), e.member(t, "binhtran")
	ctx := t.Context()
	p := an.privacy(e)
	if _, err := p.SetAutoDelete(ctx, connect.NewRequest(&appv1.SetAutoDeleteRequest{Months: 3})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("3 months: %v", err)
	}
	set, err := p.SetAutoDelete(ctx, connect.NewRequest(&appv1.SetAutoDeleteRequest{Months: 6}))
	if err != nil || set.Msg.GetMonths() != 6 {
		t.Fatalf("6 months: %v %v", set, err)
	}
	// An owns a group with Bình: after the erasure Bình owns it.
	if _, err := an.users.AddContact(ctx, connect.NewRequest(&appv1.AddContactRequest{Target: &appv1.AddContactRequest_Username{Username: "binhtran"}})); err != nil {
		t.Fatal(err)
	}
	if _, err := binh.users.AddContact(ctx, connect.NewRequest(&appv1.AddContactRequest{Target: &appv1.AddContactRequest_Username{Username: "annguyen"}})); err != nil {
		t.Fatal(err)
	}
	group, err := an.chats.CreateGroup(ctx, connect.NewRequest(&appv1.CreateGroupRequest{Title: "Nhóm", UserIds: []int64{binh.userID}}))
	if err != nil || len(group.Msg.GetFailedUserIds()) != 0 {
		t.Fatalf("group: %v %v", group, err)
	}

	// Used recently: nothing happens.
	e.app.Privacy.RunJobs(ctx)
	if self, err := an.users.GetSelf(ctx, connect.NewRequest(&appv1.GetSelfRequest{})); err != nil || self.Msg.GetDeletion() != nil {
		t.Fatalf("active account: %v %v", self, err)
	}
	// Seven months without a session in use.
	if _, err := e.store.Pool().Exec(ctx, `UPDATE user_sessions SET last_seen_at = now() - interval '7 months' WHERE user_id = $1`, an.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.Pool().Exec(ctx, `UPDATE users SET created_at = now() - interval '8 months' WHERE id = $1`, an.userID); err != nil {
		t.Fatal(err)
	}
	e.app.Privacy.RunJobs(ctx)
	var reason string
	if err := e.store.Pool().QueryRow(ctx, `SELECT coalesce(deletion_reason, '') FROM users WHERE id = $1`, an.userID).Scan(&reason); err != nil || reason != "inactive" {
		t.Fatalf("reason %q %v", reason, err)
	}
	e.as("annguyen")
	back, _ := e.signedIn(t)
	self, err := back.users.GetSelf(ctx, connect.NewRequest(&appv1.GetSelfRequest{}))
	if err != nil || self.Msg.GetDeletion().GetReason() != appv1.AccountDeletionReason_ACCOUNT_DELETION_REASON_INACTIVE {
		t.Fatalf("GetSelf of an unused account: %v %v", self, err)
	}
	// Bình does not use auto-delete: untouched.
	if self, err := binh.users.GetSelf(ctx, connect.NewRequest(&appv1.GetSelfRequest{})); err != nil || self.Msg.GetDeletion() != nil {
		t.Fatalf("binh: %v %v", self, err)
	}

	e.fastForward(t)
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
