package chat

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/ratelimit"
	"connectrpc.com/connect"
)

func abuseHarness(t *testing.T) *harness {
	return newHarness(t, func(c *Config) {
		c.Abuse = AbuseLimits{StrangerChatsNew: 3, StrangerChats: 5, NewAccountAge: 7 * 24 * time.Hour, Reporters: 2}
	})
}

// wantRefused checks that err is the anti-spam refusal with prefix.
func wantRefused(t *testing.T, err error, prefix string) {
	t.Helper()
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeResourceExhausted || !strings.HasPrefix(ce.Message(), prefix) {
		t.Fatalf("err = %v, want resource_exhausted %q", err, prefix)
	}
}

func TestStrangerChatsAreCappedPerDay(t *testing.T) {
	h := abuseHarness(t)
	ctx := context.Background()
	spammer := h.user("spammer")
	for i := range 3 {
		if _, _, err := h.svc.CreatePrivate(ctx, spammer, h.user("stranger")); err != nil {
			t.Fatalf("stranger chat %d: %v", i+1, err)
		}
	}
	_, _, err := h.svc.CreatePrivate(ctx, spammer, h.user("stranger"))
	wantRefused(t, err, "stranger_chat_limit")

	// People who know the spammer stay reachable: a contact who added them,
	// a member of a shared group, the saved chat, and chats that exist.
	friend := h.user("friend")
	if _, err := h.svc.AddContact(ctx, friend, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_Username{Username: "spammer"}}); err != nil {
		t.Fatal(err)
	}
	mate := h.user("mate")
	h.group(mate, spammer)
	for _, peer := range []int64{friend, mate, spammer} {
		if _, _, err := h.svc.CreatePrivate(ctx, spammer, peer); err != nil {
			t.Fatalf("chat with %d: %v", peer, err)
		}
	}
	// A stranger who added the spammer back no longer counts.
	var first int64
	if err := h.st.Pool().QueryRow(ctx, `
		SELECT pc.user_low + pc.user_high - $1 FROM private_chats pc JOIN chats c ON c.id = pc.chat_id
		WHERE c.creator_id = $1 AND pc.user_low <> pc.user_high ORDER BY c.created_at LIMIT 1`, spammer).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.AddContact(ctx, first, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: spammer}}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.CreatePrivate(ctx, spammer, h.user("stranger")); err != nil {
		t.Fatalf("after one stranger added them back: %v", err)
	}

	// An older account gets the larger allowance (5).
	if _, err := h.st.Pool().Exec(ctx, `UPDATE users SET created_at = now() - interval '30 days' WHERE id = $1`, spammer); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.CreatePrivate(ctx, spammer, h.user("stranger")); err != nil {
		t.Fatalf("older account, 4th stranger: %v", err)
	}
	_, _, err = h.svc.CreatePrivate(ctx, spammer, h.user("stranger"))
	if err != nil {
		t.Fatalf("older account, 5th stranger: %v", err)
	}
	_, _, err = h.svc.CreatePrivate(ctx, spammer, h.user("stranger"))
	wantRefused(t, err, "stranger_chat_limit")
}

func TestReportedAccountWaitsForReviewBeforeStrangerChats(t *testing.T) {
	h := abuseHarness(t)
	ctx := context.Background()
	spammer := h.user("spammer")
	victim := h.user("victim")
	chat, _, err := h.svc.CreatePrivate(ctx, spammer, victim)
	if err != nil {
		t.Fatal(err)
	}
	seq := h.send(spammer, chat.GetId(), "buy now").GetMessage().GetSeq()
	// One report on the account, one on its message: two distinct people.
	if err := h.svc.Report(ctx, victim, &appv1.ReportRequest{
		Target: &appv1.ReportRequest_Messages{Messages: &appv1.ReportedMessages{ChatId: chat.GetId(), Seqs: []int64{seq}}},
		Reason: appv1.ReportReason_REPORT_REASON_SPAM,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.CreatePrivate(ctx, spammer, h.user("stranger")); err != nil {
		t.Fatalf("one reporter: %v", err)
	}
	if err := h.svc.Report(ctx, h.user("witness"), &appv1.ReportRequest{
		Target: &appv1.ReportRequest_UserId{UserId: spammer}, Reason: appv1.ReportReason_REPORT_REASON_SPAM,
	}); err != nil {
		t.Fatal(err)
	}
	_, _, err = h.svc.CreatePrivate(ctx, spammer, h.user("stranger"))
	wantRefused(t, err, "stranger_chat_paused")
	// Dismissed reports lift it.
	if _, err := h.st.Pool().Exec(ctx, `UPDATE reports SET status = 'dismissed'`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.CreatePrivate(ctx, spammer, h.user("stranger")); err != nil {
		t.Fatalf("after review: %v", err)
	}
}

func TestOwnReportsDoNotCountAgainstTheReporter(t *testing.T) {
	h := abuseHarness(t)
	ctx := context.Background()
	me, spammer := h.user("me"), h.user("spammer")
	chat, _, err := h.svc.CreatePrivate(ctx, spammer, me)
	if err != nil {
		t.Fatal(err)
	}
	// me reports the chat with the spammer, and one more person reports me.
	if err := h.svc.Report(ctx, me, &appv1.ReportRequest{
		Target: &appv1.ReportRequest_ChatId{ChatId: chat.GetId()}, Reason: appv1.ReportReason_REPORT_REASON_SPAM,
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Report(ctx, h.user("other"), &appv1.ReportRequest{
		Target: &appv1.ReportRequest_UserId{UserId: me}, Reason: appv1.ReportReason_REPORT_REASON_SPAM,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.svc.CreatePrivate(ctx, me, h.user("stranger")); err != nil {
		t.Fatalf("one other reporter, own report not counted: %v", err)
	}
}

func TestStrangerLimitsOffByDefault(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	me := h.user("me")
	for i := range 8 {
		if _, _, err := h.svc.CreatePrivate(ctx, me, h.user("stranger")); err != nil {
			t.Fatalf("stranger chat %d: %v", i+1, err)
		}
	}
}

// keyRecorder allows everything and records the bucket keys.
type keyRecorder struct {
	mu   sync.Mutex
	keys []string
}

func (r *keyRecorder) Allow(_ ratelimit.Rule, key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.keys = append(r.keys, key)
	return true
}

func TestYoungAccountsSearchFromTheStricterBucket(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	young, old := h.user("young"), h.user("old")
	if _, err := h.st.Pool().Exec(ctx, `UPDATE users SET created_at = now() - interval '2 days' WHERE id = $1`, old); err != nil {
		t.Fatal(err)
	}
	rec := &keyRecorder{}
	h.svc.limiter = rec
	for _, me := range []int64{young, old} {
		if _, err := h.svc.SearchUsers(ctx, me, "someone", 10); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{"search-young:" + strconv.FormatInt(young, 10), "search:" + strconv.FormatInt(old, 10)}
	if len(rec.keys) != 2 || rec.keys[0] != want[0] || rec.keys[1] != want[1] {
		t.Fatalf("keys = %v, want %v", rec.keys, want)
	}
}
