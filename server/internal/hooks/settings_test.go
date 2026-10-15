package hooks_test

import (
	"context"
	"net/http"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
)

// stopped is a hook-stopped service message as a member sees it.
type stopped struct {
	from   int64
	name   string
	reason appv1.IncomingHookStopReason
}

// stoppedMessages returns the hook-stopped service messages of the chat as
// me sees them, oldest first.
func (h *harness) stoppedMessages(me, chatID int64) []stopped {
	h.t.Helper()
	resp, err := h.chat.GetHistory(context.Background(), me, &appv1.GetHistoryRequest{ChatId: chatID, Limit: 100})
	if err != nil {
		h.t.Fatal(err)
	}
	var out []stopped
	for _, m := range resp.GetMessages() {
		if a := m.GetAction().GetIncomingHookStopped(); a != nil {
			out = append(out, stopped{from: m.GetFromId(), name: a.GetHookName(), reason: a.GetReason()})
		}
	}
	return out
}

func expectStopped(t *testing.T, got []stopped, want ...stopped) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("hook-stopped messages %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("hook-stopped message %d is %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestStoppedHooksPostAServiceMessageInTheGroup(t *testing.T) {
	h := newHarness(t, allowAll{})
	ctx := context.Background()
	owner, minh, lan := h.user("owner"), h.user("minh"), h.user("lan")
	chatID := h.group(owner, minh, lan)
	for _, u := range []int64{minh, lan} {
		if _, err := h.chat.SetAdmin(ctx, owner, chatID, u, true); err != nil {
			t.Fatal(err)
		}
	}
	native := appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE
	grafana, _ := h.create(minh, chatID, "Grafana prod", native)
	gitlab, _ := h.create(minh, chatID, "GitLab ops/deploy", native)
	jenkins, _ := h.create(lan, chatID, "Jenkins build", native)
	// Turned off by hand before the creator loses admin: no second message later.
	if _, err := h.hooks.SetIncomingHookEnabled(ctx, minh, &appv1.SetIncomingHookEnabledRequest{HookId: gitlab.GetId()}); err != nil {
		t.Fatal(err)
	}
	expectStopped(t, h.stoppedMessages(owner, chatID),
		stopped{from: minh, name: "GitLab ops/deploy", reason: appv1.IncomingHookStopReason_INCOMING_HOOK_STOP_REASON_DISABLED})

	// Demoting the creator stops only their active hooks, announced by the server.
	if _, err := h.chat.SetAdmin(ctx, owner, chatID, minh, false); err != nil {
		t.Fatal(err)
	}
	expectStopped(t, h.stoppedMessages(lan, chatID)[1:],
		stopped{from: 0, name: "Grafana prod", reason: appv1.IncomingHookStopReason_INCOMING_HOOK_STOP_REASON_CREATOR_NOT_ADMIN})
	if got := h.hook(lan, grafana.GetId()).GetState(); got != appv1.IncomingHookState_INCOMING_HOOK_STATE_AUTO_DISABLED {
		t.Fatalf("grafana hook state %v", got)
	}

	// A membership change that stops no hook posts none.
	if _, err := h.chat.SetAdmin(ctx, owner, chatID, minh, true); err != nil {
		t.Fatal(err)
	}
	if got := len(h.stoppedMessages(owner, chatID)); got != 2 {
		t.Fatalf("%d hook-stopped messages after a promotion", got)
	}

	// The creator leaving: reason creator_left.
	if _, err := h.chat.LeaveChat(ctx, lan, chatID, 0); err != nil {
		t.Fatal(err)
	}
	all := h.stoppedMessages(owner, chatID)
	expectStopped(t, all[2:],
		stopped{from: 0, name: "Jenkins build", reason: appv1.IncomingHookStopReason_INCOMING_HOOK_STOP_REASON_CREATOR_LEFT})

	// Deleting announces the admin who did it, whatever the hook's state.
	if err := h.hooks.DeleteIncomingHook(ctx, owner, jenkins.GetId()); err != nil {
		t.Fatal(err)
	}
	expectStopped(t, h.stoppedMessages(minh, chatID)[3:],
		stopped{from: owner, name: "Jenkins build", reason: appv1.IncomingHookStopReason_INCOMING_HOOK_STOP_REASON_DELETED})

	// Members are told in realtime like for any new message.
	eventually(t, "realtime hook-stopped message", func() bool {
		for _, u := range h.sink.updates(owner) {
			if a := u.GetMessageNew().GetMessage().GetAction().GetIncomingHookStopped(); a != nil && a.GetReason() == appv1.IncomingHookStopReason_INCOMING_HOOK_STOP_REASON_DELETED {
				return true
			}
		}
		return false
	})
}

func TestStoppedHooksPostNothingInAChannel(t *testing.T) {
	h := newHarness(t, allowAll{})
	ctx := context.Background()
	owner := h.user("owner")
	resp, err := h.chat.CreateChannel(ctx, owner, "Trạng thái", "")
	if err != nil {
		t.Fatal(err)
	}
	chatID := resp.GetChat().GetId()
	hook, _ := h.create(owner, chatID, "Status", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE)
	if _, err := h.hooks.SetIncomingHookEnabled(ctx, owner, &appv1.SetIncomingHookEnabledRequest{HookId: hook.GetId()}); err != nil {
		t.Fatal(err)
	}
	if err := h.hooks.DeleteIncomingHook(ctx, owner, hook.GetId()); err != nil {
		t.Fatal(err)
	}
	if got := h.stoppedMessages(owner, chatID); len(got) != 0 {
		t.Fatalf("channel got %+v", got)
	}
}

func TestUpdateIncomingHook(t *testing.T) {
	h := newHarness(t, allowAll{})
	ctx := context.Background()
	owner, member := h.user("owner"), h.user("member")
	chatID := h.group(owner, member)
	hook, hookURL := h.create(owner, chatID, "Jenkins", appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE)

	update := func(me int64, name string, allowAlert, silent bool) (*appv1.IncomingHook, error) {
		resp, err := h.hooks.UpdateIncomingHook(ctx, me, &appv1.UpdateIncomingHookRequest{
			HookId: hook.GetId(), Name: name, AllowAlert: allowAlert, Silent: silent,
		})
		return resp.GetHook(), err
	}
	got, err := update(owner, "  Jenkins build  ", true, true)
	if err != nil {
		t.Fatal(err)
	}
	if got.GetName() != "Jenkins build" || !got.GetAllowAlert() || !got.GetSilent() || got.GetFormat() != hook.GetFormat() {
		t.Fatalf("updated hook %v", got)
	}
	if again := h.hook(owner, hook.GetId()); again.GetName() != "Jenkins build" || !again.GetSilent() {
		t.Fatalf("stored hook %v", again)
	}

	// The next message carries the new label and is silent.
	seq := h.post(hookURL, "", `{"text": "Build #318 thành công"}`).seq(t)
	m := h.message(member, chatID, seq)
	if m.GetIntegrationLabel() != "Jenkins build" || !m.GetSilent() {
		t.Fatalf("message after update: label %q silent %v", m.GetIntegrationLabel(), m.GetSilent())
	}

	// Same settings again: no audit entry.
	if _, err := update(owner, "Jenkins build", true, true); err != nil {
		t.Fatal(err)
	}
	if _, err := update(owner, "Jenkins build", false, true); err != nil {
		t.Fatal(err)
	}
	audit, err := h.hooks.GetIncomingHookAudit(ctx, owner, &appv1.GetIncomingHookAuditRequest{ChatId: chatID})
	if err != nil {
		t.Fatal(err)
	}
	var details []string
	for _, e := range audit.GetEntries() {
		if e.GetAction() == appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_UPDATED {
			if e.GetActorId() != owner || e.GetHookName() != "Jenkins build" {
				t.Fatalf("audit entry %v", e)
			}
			details = append(details, e.GetDetail())
		}
	}
	want := []string{"allow_alert off", `name (was "Jenkins"), allow_alert on, silent on`}
	if len(details) != len(want) || details[0] != want[0] || details[1] != want[1] {
		t.Fatalf("audit details %q, want %q", details, want)
	}

	// Validation and access.
	for _, name := range []string{"", "   ", string(make([]rune, 65))} {
		if _, err := update(owner, name, false, false); codeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("name %q: %v", name, err)
		}
	}
	if _, err := update(member, "Hijack", false, false); codeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member update: %v", err)
	}
	if _, err := h.hooks.UpdateIncomingHook(ctx, owner, &appv1.UpdateIncomingHookRequest{HookId: "hk_missing0000", Name: "x"}); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown hook: %v", err)
	}
	if r := h.post(hookURL, "", `{"text": "still works"}`); r.status != http.StatusOK {
		t.Fatalf("hook after updates: %d %s", r.status, r.body)
	}
}
