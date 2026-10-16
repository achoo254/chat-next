package hooks_test

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/ratelimit"
	"connectrpc.com/connect"
)

func fixture(t *testing.T, name string) string {
	t.Helper()
	return string(mustRead(t, name))
}

func mustRead(t testing.TB, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("format", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func codeOf(err error) connect.Code {
	return connect.CodeOf(err)
}

func TestEveryFormatPostsAnIntegrationMessage(t *testing.T) {
	h := newHarness(t, allowAll{})
	owner, member := h.user("owner"), h.user("member")
	chatID := h.group(owner, member)
	ctx := context.Background()

	cases := []struct {
		format      appv1.IncomingHookFormat
		suffix      string
		body        string
		contentType string
		text        string
	}{
		{appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE, "",
			`{"text": "Build *#318* lỗi", "parse_mode": "markdown", "buttons": [{"text": "Mở job", "url": "https://ci.example.invalid/318"}]}`,
			"", "Build #318 lỗi"},
		{appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_SLACK, "/slack", fixture(t, "uptime-kuma-slack.json"), "", "Uptime Kuma Alert"},
		{appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_SLACK, "/slack",
			url.Values{"payload": {`{"text": "*Jenkins* build ok"}`}}.Encode(), "application/x-www-form-urlencoded", "Jenkins build ok"},
		{appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_ALERTMANAGER, "/alertmanager", fixture(t, "alertmanager-firing.json"), "", "Firing DiskFull trên db-02"},
		{appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_GRAFANA, "/grafana", fixture(t, "grafana-webhook.json"), "", "Firing HighCPU Lab (lab-174)"},
		{appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_GITLAB, "/gitlab", fixture(t, "gitlab-pipeline.json"), "", "Pipeline #5121 success"},
	}
	for _, c := range cases {
		hook, hookURL := h.create(owner, chatID, "Hook "+c.suffix, c.format)
		if !strings.HasSuffix(hookURL, c.suffix) || !strings.HasPrefix(hookURL, h.srv.URL+"/hook/"+hook.GetId()+"/") {
			t.Fatalf("url %q for format %v", hookURL, c.format)
		}
		r := h.post(hookURL, c.contentType, c.body)
		if r.status != http.StatusOK {
			t.Fatalf("%v: status %d %s", c.format, r.status, r.body)
		}
		var seq int64
		if c.suffix == "/slack" {
			if r.body != "ok" {
				t.Fatalf("slack answer %q, want ok", r.body)
			}
			msgs := h.history(member, chatID)
			seq = msgs[len(msgs)-1].GetSeq()
		} else {
			seq = r.seq(t)
			if got := int64(r.json(t)["chat_id"].(float64)); got != chatID {
				t.Fatalf("chat_id %d, want %d", got, chatID)
			}
		}
		m := h.message(member, chatID, seq)
		if m.GetFromId() != 0 || m.GetIntegrationLabel() != hook.GetName() || !strings.HasPrefix(m.GetText(), c.text) {
			t.Fatalf("%v: message from %d label %q text %q", c.format, m.GetFromId(), m.GetIntegrationLabel(), m.GetText())
		}
	}
	// URL buttons arrive as an inline keyboard.
	native := h.history(member, chatID)[0]
	if b := native.GetReplyMarkup().GetInlineKeyboard().GetRows()[0].GetButtons()[0]; b.GetUrl() != "https://ci.example.invalid/318" {
		t.Fatalf("buttons %v", native.GetReplyMarkup())
	}

	// GitLab events without a message are accepted and ignored.
	_, gitlabURL := h.create(owner, chatID, "GitLab jobs", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_GITLAB)
	if r := h.post(gitlabURL, "", `{"object_kind": "build"}`); r.status != http.StatusOK || r.json(t)["ignored"] != true {
		t.Fatalf("ignored event: %d %s", r.status, r.body)
	}

	// A silent hook posts silent messages.
	resp, err := h.hooks.CreateIncomingHook(ctx, owner, &appv1.CreateIncomingHookRequest{ChatId: chatID, Name: "Jenkins build",
		Format: appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE, Silent: true})
	if err != nil {
		t.Fatal(err)
	}
	seq := h.post(resp.GetUrl(), "", `{"text": "Build chat-server #318 thành công"}`).seq(t)
	if !h.message(member, chatID, seq).GetSilent() {
		t.Fatal("message of a silent hook is not silent")
	}
}

func TestManagementNeedsChatAdmin(t *testing.T) {
	h := newHarness(t, allowAll{})
	ctx := context.Background()
	owner, admin, member, stranger := h.user("owner"), h.user("admin"), h.user("member"), h.user("stranger")
	chatID := h.group(owner, admin, member)
	if _, err := h.chat.SetAdmin(ctx, owner, chatID, admin, true); err != nil {
		t.Fatal(err)
	}
	req := &appv1.CreateIncomingHookRequest{ChatId: chatID, Name: "x", Format: appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE}
	if _, err := h.hooks.CreateIncomingHook(ctx, member, req); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member create: %v", err)
	}
	if _, err := h.hooks.CreateIncomingHook(ctx, stranger, req); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("stranger create: %v", err)
	}
	private, _, err := h.chat.CreatePrivate(ctx, owner, member)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.hooks.CreateIncomingHook(ctx, owner, &appv1.CreateIncomingHookRequest{ChatId: private.GetId(), Name: "x",
		Format: appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE}); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("private chat create: %v", err)
	}
	for _, bad := range []*appv1.CreateIncomingHookRequest{
		{ChatId: chatID, Name: " ", Format: appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE},
		{ChatId: chatID, Name: strings.Repeat("n", 65), Format: appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE},
		{ChatId: chatID, Name: "x"},
	} {
		if _, err := h.hooks.CreateIncomingHook(ctx, owner, bad); codeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("bad request %v: %v", bad, err)
		}
	}
	hook, _ := h.create(admin, chatID, "Grafana prod", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_SLACK)
	if _, err := h.hooks.GetIncomingHook(ctx, member, hook.GetId()); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member get: %v", err)
	}
	if _, err := h.hooks.GetIncomingHooks(ctx, member, chatID); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member list: %v", err)
	}
	if err := h.hooks.DeleteIncomingHook(ctx, member, hook.GetId()); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member delete: %v", err)
	}
	list, err := h.hooks.GetIncomingHooks(ctx, owner, chatID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.GetHooks()) != 1 || list.GetHooks()[0].GetCreatedBy() != admin || len(list.GetUsers()) != 1 {
		t.Fatalf("list %v", list)
	}
	for i := range 19 {
		h.create(owner, chatID, "h"+string(rune('a'+i)), appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE)
	}
	if _, err := h.hooks.CreateIncomingHook(ctx, owner, req); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("21st hook: %v", err)
	}
}

func TestGroupKeyUpdatesTheAlertInPlace(t *testing.T) {
	h := newHarness(t, allowAll{})
	owner, member := h.user("owner"), h.user("member")
	chatID := h.group(owner, member)
	_, hookURL := h.create(owner, chatID, "Alertmanager prod", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_ALERTMANAGER)
	firing, resolved := fixture(t, "alertmanager-firing.json"), fixture(t, "alertmanager-resolved.json")

	seq := h.post(hookURL, "", firing).seq(t)
	// Alertmanager repeats a firing group: same message, no new one.
	if again := h.post(hookURL, "", firing).seq(t); again != seq {
		t.Fatalf("repeat firing posted %d, want %d", again, seq)
	}
	if got := h.post(hookURL, "", resolved).seq(t); got != seq {
		t.Fatalf("resolved posted %d, want %d", got, seq)
	}
	msgs := h.history(member, chatID)
	if len(msgs) != 1 || !strings.HasPrefix(msgs[0].GetText(), "Resolved DiskFull") || msgs[0].GetEditDate() == 0 {
		t.Fatalf("history %v", msgs)
	}
	// A firing older (by source time) than the resolution arriving late
	// changes nothing.
	if got := h.post(hookURL, "", firing).seq(t); got != seq {
		t.Fatalf("late firing posted %d", got)
	}
	if text := h.message(member, chatID, seq).GetText(); !strings.HasPrefix(text, "Resolved") {
		t.Fatalf("late firing overwrote the resolution: %q", text)
	}
	// Only the change of status notifies: the repeat edit did not.
	eventually(t, "realtime edits", func() bool {
		edits := 0
		for _, u := range h.sink.updates(member) {
			if u.GetMessageEdit() != nil {
				edits++
			}
		}
		return edits == 2
	})
	var notified []bool
	for _, u := range h.sink.updates(member) {
		if e := u.GetMessageEdit(); e != nil {
			notified = append(notified, e.GetNotify())
		}
	}
	if len(notified) != 2 || notified[0] || !notified[1] {
		t.Fatalf("edit notify flags %v, want [false true]", notified)
	}

	// Resolved first for a new group, firing (older) second: stays resolved.
	other := strings.ReplaceAll(resolved, `alertname=\"DiskFull\"}`, `alertname=\"DiskFull2\"}`)
	otherFiring := strings.ReplaceAll(firing, `alertname=\"DiskFull\"}`, `alertname=\"DiskFull2\"}`)
	first := h.post(hookURL, "", other).seq(t)
	if got := h.post(hookURL, "", otherFiring).seq(t); got != first {
		t.Fatalf("out of order firing posted %d", got)
	}
	if text := h.message(member, chatID, first).GetText(); !strings.HasPrefix(text, "Resolved") {
		t.Fatalf("out of order: %q", text)
	}

	// Two firings of a new group at the same time post one message.
	race := strings.ReplaceAll(firing, `alertname=\"DiskFull\"}`, `alertname=\"Race\"}`)
	before := len(h.history(member, chatID))
	var wg sync.WaitGroup
	seqs := make([]int64, 2)
	for i := range seqs {
		wg.Go(func() { seqs[i] = h.post(hookURL, "", race).seq(t) })
	}
	wg.Wait()
	if seqs[0] != seqs[1] || len(h.history(member, chatID)) != before+1 {
		t.Fatalf("parallel firings: seqs %v, %d new messages", seqs, len(h.history(member, chatID))-before)
	}

	// A deleted alert message is posted again on the next update.
	if _, err := h.chat.DeleteMessages(context.Background(), owner, chatID, []int64{seq}, true); err != nil {
		t.Fatal(err)
	}
	refired := strings.ReplaceAll(firing, "2026-10-14T02:42:00.000Z", "2026-10-14T05:00:00.000Z")
	if got := h.post(hookURL, "", refired).seq(t); got == seq {
		t.Fatal("update of a deleted alert edited the placeholder")
	}
}

func TestIdempotencyKey(t *testing.T) {
	h := newHarness(t, allowAll{})
	owner := h.user("owner")
	chatID := h.group(owner)
	_, hookURL := h.create(owner, chatID, "Jenkins", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE)
	body := `{"text": "chat-server #318 lỗi", "idempotency_key": "jenkins-chat-server-318"}`
	var wg sync.WaitGroup
	seqs := make([]int64, 20)
	for i := range seqs {
		wg.Go(func() { seqs[i] = h.post(hookURL, "", body).seq(t) })
	}
	wg.Wait()
	for _, s := range seqs {
		if s != seqs[0] {
			t.Fatalf("seqs differ: %v", seqs)
		}
	}
	if n := len(h.history(owner, chatID)); n != 1 {
		t.Fatalf("%d messages for one idempotency key", n)
	}
	if other := h.post(hookURL, "", `{"text": "x", "idempotency_key": "another"}`).seq(t); other == seqs[0] {
		t.Fatal("another key returned the same message")
	}
}

func TestEndpointRejectsWrongHostsAndSecrets(t *testing.T) {
	h := newHarness(t, allowAll{})
	owner := h.user("owner")
	chatID := h.group(owner)
	hook, hookURL := h.create(owner, chatID, "Slack", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_SLACK)
	body := `{"text": "hi"}`
	if r := h.post(hookURL, "", body); r.status != http.StatusOK {
		t.Fatalf("right host: %d", r.status)
	}
	base := strings.TrimSuffix(hookURL, "/slack")
	secret := base[strings.LastIndex(base, "/")+1:]
	for name, c := range map[string]struct{ url, host string }{
		"other tenant host": {hookURL, "chat.inetdev.io.vn"},
		"bare domain":       {hookURL, "hoandat.com"},
		"wrong secret":      {strings.Replace(hookURL, secret, strings.Repeat("A", len(secret)), 1), ""},
		"unknown hook":      {strings.Replace(hookURL, hook.GetId(), "hk_AAAAAAAAAAAA", 1), ""},
		"bad id":            {strings.Replace(hookURL, hook.GetId(), "hk_1", 1), ""},
		"unknown format":    {base + "/discord", ""},
		"native suffix":     {base + "/native", ""},
	} {
		if r := h.postHost(c.url, c.host, "", body); r.status != http.StatusNotFound {
			t.Errorf("%s: status %d %q", name, r.status, r.body)
		}
	}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, hookURL, nil)
	resp, err := h.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", resp.StatusCode)
	}
}

func TestRotationKeepsTheOldSecretForTheGracePeriod(t *testing.T) {
	h := newHarness(t, allowAll{})
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	hook, oldURL := h.create(owner, chatID, "Alertmanager prod", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE)
	body := `{"text": "ping"}`

	rot, err := h.hooks.RotateIncomingHookSecret(ctx, owner, &appv1.RotateIncomingHookSecretRequest{HookId: hook.GetId()})
	if err != nil {
		t.Fatal(err)
	}
	newURL := rot.GetUrl()
	if newURL == oldURL {
		t.Fatal("rotation kept the secret")
	}
	if exp := time.Unix(rot.GetHook().GetPreviousSecretExpiresAt(), 0); exp.Before(time.Now().Add(7*24*time.Hour - time.Minute)) {
		t.Fatalf("grace ends %v", exp)
	}
	for _, u := range []string{oldURL, newURL} {
		if r := h.post(u, "", body); r.status != http.StatusOK {
			t.Fatalf("during grace: %d", r.status)
		}
	}
	// The grace period ends.
	if _, err := h.st.Pool().Exec(ctx, `UPDATE incoming_hooks SET prev_expires_at = now() - interval '1 second' WHERE id = $1`, hook.GetId()); err != nil {
		t.Fatal(err)
	}
	if r := h.post(oldURL, "", body); r.status != http.StatusNotFound {
		t.Fatalf("after grace: %d", r.status)
	}
	if h.hook(owner, hook.GetId()).GetPreviousSecretExpiresAt() != 0 {
		t.Fatal("expired previous secret still shown")
	}

	// Revoke the previous secret at once.
	rot2, err := h.hooks.RotateIncomingHookSecret(ctx, owner, &appv1.RotateIncomingHookSecretRequest{HookId: hook.GetId()})
	if err != nil {
		t.Fatal(err)
	}
	if r := h.post(newURL, "", body); r.status != http.StatusOK {
		t.Fatalf("previous within grace: %d", r.status)
	}
	if _, err := h.hooks.RevokePreviousHookSecret(ctx, owner, hook.GetId()); err != nil {
		t.Fatal(err)
	}
	if r := h.post(newURL, "", body); r.status != http.StatusNotFound {
		t.Fatalf("revoked previous: %d", r.status)
	}
	if _, err := h.hooks.RevokePreviousHookSecret(ctx, owner, hook.GetId()); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("second revoke: %v", err)
	}

	// Rotate and revoke in one call.
	rot3, err := h.hooks.RotateIncomingHookSecret(ctx, owner, &appv1.RotateIncomingHookSecretRequest{HookId: hook.GetId(), RevokePrevious: true})
	if err != nil {
		t.Fatal(err)
	}
	if r := h.post(rot2.GetUrl(), "", body); r.status != http.StatusNotFound {
		t.Fatalf("rotate with revoke kept the old URL: %d", r.status)
	}
	if r := h.post(rot3.GetUrl(), "", body); r.status != http.StatusOK {
		t.Fatalf("new URL: %d", r.status)
	}
	audit, err := h.hooks.GetIncomingHookAudit(ctx, owner, &appv1.GetIncomingHookAuditRequest{ChatId: chatID, HookId: hook.GetId()})
	if err != nil {
		t.Fatal(err)
	}
	var actions []appv1.IncomingHookAuditAction
	for _, e := range audit.GetEntries() {
		actions = append(actions, e.GetAction())
	}
	want := []appv1.IncomingHookAuditAction{
		appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_SECRET_ROTATED,
		appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_PREVIOUS_SECRET_REVOKED,
		appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_SECRET_ROTATED,
		appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_SECRET_ROTATED,
		appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_CREATED,
	}
	if len(actions) != len(want) {
		t.Fatalf("audit %v", actions)
	}
	for i := range want {
		if actions[i] != want[i] {
			t.Fatalf("audit %v, want %v", actions, want)
		}
	}
}

func TestHookStopsWhenItsCreatorLosesAdmin(t *testing.T) {
	h := newHarness(t, allowAll{})
	ctx := context.Background()
	owner, minh, lan := h.user("owner"), h.user("minh"), h.user("lan")
	chatID := h.group(owner, minh, lan)
	for _, u := range []int64{minh, lan} {
		if _, err := h.chat.SetAdmin(ctx, owner, chatID, u, true); err != nil {
			t.Fatal(err)
		}
	}
	hook, hookURL := h.create(minh, chatID, "GitLab ops/deploy", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE)
	body := `{"text": "Pipeline #5121 thành công trên main"}`
	h.post(hookURL, "", body).seq(t)

	if _, err := h.chat.SetAdmin(ctx, owner, chatID, minh, false); err != nil {
		t.Fatal(err)
	}
	if r := h.post(hookURL, "", body); r.status != http.StatusForbidden || r.json(t)["error"] != "hook_disabled" {
		t.Fatalf("after demotion: %d %s", r.status, r.body)
	}
	got := h.hook(lan, hook.GetId())
	if got.GetState() != appv1.IncomingHookState_INCOMING_HOOK_STATE_AUTO_DISABLED ||
		got.GetDisabledReason() != appv1.IncomingHookDisabledReason_INCOMING_HOOK_DISABLED_REASON_CREATOR_NOT_ADMIN {
		t.Fatalf("state %v reason %v", got.GetState(), got.GetDisabledReason())
	}
	// Turning it on needs the creator to be an admin again.
	if _, err := h.hooks.SetIncomingHookEnabled(ctx, lan, &appv1.SetIncomingHookEnabledRequest{HookId: hook.GetId(), Enabled: true}); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("enable: %v", err)
	}
	// Another admin takes it over: same URL, works again.
	over, err := h.hooks.TakeOverIncomingHook(ctx, lan, &appv1.TakeOverIncomingHookRequest{HookId: hook.GetId()})
	if err != nil {
		t.Fatal(err)
	}
	if over.GetUrl() != "" || over.GetHook().GetCreatedBy() != lan || over.GetHook().GetState() != appv1.IncomingHookState_INCOMING_HOOK_STATE_ACTIVE {
		t.Fatalf("take over %v", over)
	}
	h.post(hookURL, "", body).seq(t)

	// The new creator leaves; the owner takes over and rotates the secret.
	if _, err := h.chat.LeaveChat(ctx, lan, chatID, 0); err != nil {
		t.Fatal(err)
	}
	if got := h.hook(owner, hook.GetId()); got.GetDisabledReason() != appv1.IncomingHookDisabledReason_INCOMING_HOOK_DISABLED_REASON_CREATOR_LEFT {
		t.Fatalf("after leaving: %v", got)
	}
	over, err = h.hooks.TakeOverIncomingHook(ctx, owner, &appv1.TakeOverIncomingHookRequest{HookId: hook.GetId(), RotateSecret: true})
	if err != nil {
		t.Fatal(err)
	}
	if r := h.post(hookURL, "", body); r.status != http.StatusNotFound {
		t.Fatalf("old URL after rotating take over: %d", r.status)
	}
	h.post(over.GetUrl(), "", body).seq(t)

	audit, err := h.hooks.GetIncomingHookAudit(ctx, owner, &appv1.GetIncomingHookAuditRequest{ChatId: chatID})
	if err != nil {
		t.Fatal(err)
	}
	autos := 0
	for _, e := range audit.GetEntries() {
		if e.GetAction() == appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_AUTO_DISABLED {
			autos++
			if e.GetActorId() != 0 {
				t.Fatalf("auto disable by %d", e.GetActorId())
			}
		}
	}
	if autos != 2 {
		t.Fatalf("%d auto_disabled entries", autos)
	}
}

func TestDisableEnableAndDelete(t *testing.T) {
	h := newHarness(t, allowAll{})
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	hook, hookURL := h.create(owner, chatID, "Script", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE)
	if _, err := h.hooks.SetIncomingHookEnabled(ctx, owner, &appv1.SetIncomingHookEnabledRequest{HookId: hook.GetId()}); err != nil {
		t.Fatal(err)
	}
	if r := h.post(hookURL, "", `{"text": "x"}`); r.status != http.StatusForbidden {
		t.Fatalf("disabled: %d", r.status)
	}
	if _, err := h.hooks.SetIncomingHookEnabled(ctx, owner, &appv1.SetIncomingHookEnabledRequest{HookId: hook.GetId(), Enabled: true}); err != nil {
		t.Fatal(err)
	}
	h.post(hookURL, "", `{"text": "x"}`).seq(t)
	if err := h.hooks.DeleteIncomingHook(ctx, owner, hook.GetId()); err != nil {
		t.Fatal(err)
	}
	if r := h.post(hookURL, "", `{"text": "x"}`); r.status != http.StatusNotFound {
		t.Fatalf("deleted: %d", r.status)
	}
	if _, err := h.hooks.GetIncomingHook(ctx, owner, hook.GetId()); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("get deleted: %v", err)
	}
	audit, err := h.hooks.GetIncomingHookAudit(ctx, owner, &appv1.GetIncomingHookAuditRequest{ChatId: chatID, Limit: 1})
	if err != nil || len(audit.GetEntries()) != 1 ||
		audit.GetEntries()[0].GetAction() != appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_DELETED {
		t.Fatalf("audit after delete: %v %v", audit, err)
	}
}

func TestRateLimit(t *testing.T) {
	h := newHarness(t, ratelimit.NewMemory())
	owner := h.user("owner")
	chatID := h.group(owner)
	hook, hookURL := h.create(owner, chatID, "Noisy", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_SLACK)
	limited := 0
	for range 130 {
		r := h.post(hookURL, "", `{"text": "x"}`)
		switch r.status {
		case http.StatusOK:
		case http.StatusTooManyRequests:
			limited++
			if r.header.Get("Retry-After") != "1" || r.body != "rate_limited" {
				t.Fatalf("429 without Retry-After or code: %v %q", r.header, r.body)
			}
		default:
			t.Fatalf("status %d", r.status)
		}
	}
	if limited < 15 {
		t.Fatalf("only %d of 130 requests limited (burst 100)", limited)
	}
	stats, err := h.hooks.GetIncomingHookStats(context.Background(), owner, &appv1.GetIncomingHookStatsRequest{HookId: hook.GetId()})
	if err != nil {
		t.Fatal(err)
	}
	if stats.GetFailed() != int64(limited) || stats.GetAccepted() != int64(130-limited) ||
		len(stats.GetFailures()) != 1 || stats.GetFailures()[0].GetReason() != "rate_limited" {
		t.Fatalf("stats %v (limited %d)", stats, limited)
	}
}

func TestCountersAndDeadLetters(t *testing.T) {
	h := newHarness(t, allowAll{})
	ctx := context.Background()
	owner, member := h.user("owner"), h.user("member")
	chatID := h.group(owner, member)
	h.sink.mu.Lock()
	h.sink.online[member] = true
	h.sink.mu.Unlock()
	hook, hookURL := h.create(owner, chatID, "Script", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE)
	h.post(hookURL, "", `{"text": "one"}`).seq(t)
	h.post(hookURL, "", `{"text": "two"}`).seq(t)
	if r := h.post(hookURL, "", `{"text": `); r.status != http.StatusBadRequest || r.json(t)["error"] != "invalid_json" {
		t.Fatalf("bad json: %d %s", r.status, r.body)
	}
	if r := h.post(hookURL, "", `{"text": "x", "buttons": [{"text": "x", "url": "javascript:alert(1)"}]}`); r.status != http.StatusBadRequest ||
		r.json(t)["error"] != "url_not_allowed" {
		t.Fatalf("bad url: %d %s", r.status, r.body)
	}
	big := `{"text": "` + strings.Repeat("a", 70<<10) + `"}`
	if r := h.post(hookURL, "", big); r.status != http.StatusRequestEntityTooLarge || r.json(t)["error"] != "payload_too_large" {
		t.Fatalf("too large: %d %s", r.status, r.body)
	}

	eventually(t, "delivered_realtime", func() bool {
		stats, err := h.hooks.GetIncomingHookStats(ctx, owner, &appv1.GetIncomingHookStatsRequest{HookId: hook.GetId()})
		return err == nil && stats.GetDeliveredRealtime() == 2
	})
	stats, err := h.hooks.GetIncomingHookStats(ctx, owner, &appv1.GetIncomingHookStatsRequest{HookId: hook.GetId(), Hours: 1})
	if err != nil {
		t.Fatal(err)
	}
	if stats.GetAccepted() != 2 || stats.GetFailed() != 3 || len(stats.GetFailures()) != 3 || stats.GetHours() != 1 {
		t.Fatalf("stats %v", stats)
	}
	if _, err := h.hooks.GetIncomingHookStats(ctx, owner, &appv1.GetIncomingHookStatsRequest{HookId: hook.GetId(), Hours: 721}); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("hours 721: %v", err)
	}

	letters, err := h.hooks.GetIncomingHookDeadLetters(ctx, owner, &appv1.GetIncomingHookDeadLettersRequest{HookId: hook.GetId()})
	if err != nil {
		t.Fatal(err)
	}
	ls := letters.GetDeadLetters()
	if len(ls) != 3 || ls[0].GetReason() != "payload_too_large" || !ls[0].GetBodyTruncated() || len(ls[0].GetBody()) != 16<<10 ||
		ls[2].GetReason() != "invalid_json" || string(ls[2].GetBody()) != `{"text": ` || ls[2].GetHttpStatus() != 400 ||
		ls[2].GetContentType() != "application/json" {
		t.Fatalf("dead letters %v", ls)
	}
	page, err := h.hooks.GetIncomingHookDeadLetters(ctx, owner, &appv1.GetIncomingHookDeadLettersRequest{HookId: hook.GetId(), BeforeId: ls[0].GetId(), Limit: 1})
	if err != nil || len(page.GetDeadLetters()) != 1 || page.GetDeadLetters()[0].GetId() != ls[1].GetId() {
		t.Fatalf("page %v %v", page, err)
	}
	if got := h.hook(owner, hook.GetId()); got.GetLastUsedAt() == 0 {
		t.Fatal("last_used_at not set")
	}
}

func TestSecretsNeverReachTheLogs(t *testing.T) {
	h := newHarness(t, allowAll{})
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	_, hookURL := h.create(owner, chatID, "Secretive", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE)
	secret := strings.TrimPrefix(hookURL, h.srv.URL+"/hook/")
	secret = secret[strings.Index(secret, "/")+1:]

	// A broken table makes delivery fail: the error is logged.
	if _, err := h.st.Pool().Exec(ctx, `ALTER TABLE notify_groups RENAME TO notify_groups_broken`); err != nil {
		t.Fatal(err)
	}
	if r := h.post(hookURL, "", `{"text": "x", "group_key": "g"}`); r.status != http.StatusInternalServerError {
		t.Fatalf("broken delivery: %d %s", r.status, r.body)
	}
	if _, err := h.st.Pool().Exec(ctx, `ALTER TABLE notify_groups_broken RENAME TO notify_groups`); err != nil {
		t.Fatal(err)
	}
	h.post(hookURL, "", `{"text": `)
	h.post(strings.Replace(hookURL, secret, secret[:len(secret)-1]+"x", 1), "", `{"text": "x"}`)
	h.postHost(hookURL, "evil.example", "", `{"text": "x"}`)
	logs := h.logs.String()
	if !strings.Contains(logs, "hook delivery failed") {
		t.Fatalf("the failure was not logged: %s", logs)
	}
	if strings.Contains(logs, secret) || strings.Contains(logs, "/hook/") {
		t.Fatalf("logs contain the secret or the hook path:\n%s", logs)
	}
}

func TestModeratorDisabledHookStaysOff(t *testing.T) {
	h := newHarness(t, allowAll{})
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	hook, _ := h.create(owner, chatID, "Spammy", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE)
	if _, err := h.st.Pool().Exec(ctx, `
		UPDATE incoming_hooks SET state = 'disabled', disabled_reason = 'by_moderator', disabled_at = now() WHERE id = $1`,
		hook.GetId()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.hooks.SetIncomingHookEnabled(ctx, owner, &appv1.SetIncomingHookEnabledRequest{HookId: hook.GetId(), Enabled: true}); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("enable a moderator-disabled hook: %v", err)
	}
	if _, err := h.hooks.TakeOverIncomingHook(ctx, owner, &appv1.TakeOverIncomingHookRequest{HookId: hook.GetId()}); codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("take over a moderator-disabled hook: %v", err)
	}
	got, err := h.hooks.GetIncomingHook(ctx, owner, hook.GetId())
	if err != nil || got.GetHook().GetDisabledReason() != appv1.IncomingHookDisabledReason_INCOMING_HOOK_DISABLED_REASON_BY_MODERATOR {
		t.Fatalf("hook = %v, %v", got, err)
	}
}
