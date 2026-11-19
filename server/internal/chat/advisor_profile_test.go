package chat

import (
	"context"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

func TestAdvisorProfile(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a, b := h.user("a"), h.user("b")
	defaults := &appv1.AdvisorProfile{LookId: "owl", Tone: appv1.AdvisorTone_ADVISOR_TONE_SHORT}
	got, err := h.svc.GetAdvisorProfile(ctx, a)
	if err != nil || !proto.Equal(got, defaults) {
		t.Fatalf("defaults = %v, %v", got, err)
	}

	name, look, tone := "  Bác Cú  ", "cat", appv1.AdvisorTone_ADVISOR_TONE_FUN
	resp, err := h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{Name: &name, LookId: &look, Tone: &tone})
	if err != nil {
		t.Fatal(err)
	}
	want := &appv1.AdvisorProfile{Name: "Bác Cú", LookId: "cat", Tone: tone}
	if !proto.Equal(resp.GetProfile(), want) || resp.GetAck().GetPts() == 0 {
		t.Fatalf("set = %v", resp)
	}
	if got, _ := h.svc.GetAdvisorProfile(ctx, a); !proto.Equal(got, want) {
		t.Fatalf("stored = %v", got)
	}
	// Only my profile changes.
	if got, _ := h.svc.GetAdvisorProfile(ctx, b); !proto.Equal(got, defaults) {
		t.Fatalf("other user = %v", got)
	}

	// My sessions get the whole profile, in realtime and from the log.
	tail := h.logOf(a)
	if p := tail[len(tail)-1].GetAdvisorProfile().GetProfile(); !proto.Equal(p, want) {
		t.Fatalf("log tail = %v", tail[len(tail)-1])
	}
	h.drain()
	var live *appv1.AdvisorProfile
	for _, u := range h.sink.updatesOf(a) {
		if p := u.GetAdvisorProfile(); p != nil {
			live = p.GetProfile()
		}
	}
	if !proto.Equal(live, want) {
		t.Fatalf("realtime = %v", live)
	}

	// Only the given fields change; the same values again write nothing.
	serious := appv1.AdvisorTone_ADVISOR_TONE_SERIOUS
	resp, err = h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{Tone: &serious})
	if err != nil {
		t.Fatal(err)
	}
	want.Tone = serious
	if !proto.Equal(resp.GetProfile(), want) {
		t.Fatalf("partial set = %v", resp.GetProfile())
	}
	before := len(h.logOf(a))
	resp, err = h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{Tone: &serious})
	if err != nil || resp.GetAck().GetPts() != 0 || len(h.logOf(a)) != before {
		t.Fatalf("unchanged set: %v, %v, log %d → %d", resp, err, before, len(h.logOf(a)))
	}
	// The automatic Advisor wish is kept with the profile, and changes only when given.
	on := true
	want.AutoSession = true
	if resp, err = h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{AutoSession: &on}); err != nil || !proto.Equal(resp.GetProfile(), want) {
		t.Fatalf("auto_session set: %v, %v", resp, err)
	}
	if resp, err = h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{Tone: &serious}); err != nil || !resp.GetProfile().GetAutoSession() {
		t.Fatalf("auto_session kept by a later change: %v, %v", resp, err)
	}
	// An empty name goes back to the default name.
	empty := ""
	if resp, err = h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{Name: &empty}); err != nil || resp.GetProfile().GetName() != "" {
		t.Fatalf("empty name: %v, %v", resp, err)
	}
}

func TestAdvisorProfileRefusesBadFields(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a := h.user("a")
	long := strings.Repeat("ạ", 33)
	control := "Cố\nvấn"
	badLooks := []string{"", "Owl", "1owl", "owl!", strings.Repeat("a", 33)}
	unspecified, unknown := appv1.AdvisorTone_ADVISOR_TONE_UNSPECIFIED, appv1.AdvisorTone(9)
	cases := []*appv1.SetAdvisorProfileRequest{
		{Name: &long},
		{Name: &control},
		{Tone: &unspecified},
		{Tone: &unknown},
	}
	for i := range badLooks {
		cases = append(cases, &appv1.SetAdvisorProfileRequest{LookId: &badLooks[i]})
	}
	for _, req := range cases {
		if _, err := h.svc.SetAdvisorProfile(ctx, a, req); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%v: err = %v", req, err)
		}
	}
	// 32 characters fit.
	fits := strings.Repeat("ạ", 32)
	if _, err := h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{Name: &fits}); err != nil {
		t.Fatalf("32 characters: %v", err)
	}
}

// The account key's removal time is kept with the profile, only moves forward,
// is never before the server's clock and survives later changes of other
// fields; it is no secret, only a time.
func TestAdvisorProfileKeyRemovedAt(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a := h.user("a")
	// A device whose clock runs a few minutes fast: its time is kept.
	at := time.Now().Add(5 * time.Minute).UnixMilli()
	resp, err := h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{KeyRemovedAt: &at})
	if err != nil || resp.GetProfile().GetKeyRemovedAt() != at || resp.GetAck().GetPts() == 0 {
		t.Fatalf("set: %v, %v", resp, err)
	}
	// My sessions hear it like every other change of the profile.
	tail := h.logOf(a)
	if got := tail[len(tail)-1].GetAdvisorProfile().GetProfile().GetKeyRemovedAt(); got != at {
		t.Fatalf("log tail key_removed_at = %d", got)
	}
	// An earlier time (another device's slower clock) changes nothing and writes nothing.
	earlier := at - 1
	before := len(h.logOf(a))
	resp, err = h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{KeyRemovedAt: &earlier})
	if err != nil || resp.GetProfile().GetKeyRemovedAt() != at || len(h.logOf(a)) != before {
		t.Fatalf("earlier: %v, %v", resp, err)
	}
	// Other fields leave it as it is.
	look := "cat"
	if resp, err = h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{LookId: &look}); err != nil || resp.GetProfile().GetKeyRemovedAt() != at {
		t.Fatalf("kept by a later change: %v, %v", resp, err)
	}
	if got, _ := h.svc.GetAdvisorProfile(ctx, a); got.GetKeyRemovedAt() != at {
		t.Fatalf("stored = %v", got)
	}
	// Out of range is refused: before 1970, or more than a day past the server's clock.
	for _, bad := range []int64{-1, time.Now().Add(25 * time.Hour).UnixMilli(), 1<<53 - 1} {
		if _, err := h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{KeyRemovedAt: &bad}); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%d: err = %v", bad, err)
		}
	}
}

// A removal from a device whose clock runs slow lands at the server's clock,
// so a key set meanwhile by a device with a right clock is removed too.
func TestAdvisorProfileKeyRemovedAtServerClock(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a := h.user("a")
	slow := time.Now().Add(-time.Hour).UnixMilli()
	start := time.Now().UnixMilli()
	resp, err := h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{KeyRemovedAt: &slow})
	if err != nil {
		t.Fatalf("set: %v", err)
	}
	if got := resp.GetProfile().GetKeyRemovedAt(); got < start || got > time.Now().UnixMilli() {
		t.Fatalf("key_removed_at = %d, want the server's clock (%d or later)", got, start)
	}
}

// Erasing an account deletes its Advisor profile.
func TestAdvisorProfileErasedWithAccount(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	a := h.user("a")
	look := "robot"
	if _, err := h.svc.SetAdvisorProfile(ctx, a, &appv1.SetAdvisorProfileRequest{LookId: &look}); err != nil {
		t.Fatal(err)
	}
	count := func() int {
		t.Helper()
		var n int
		if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM advisor_profiles WHERE user_id = $1`, a).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count() != 1 {
		t.Fatal("no profile row was written")
	}
	if _, err := h.st.Pool().Exec(ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, a); err != nil {
		t.Fatal(err)
	}
	if n := count(); n != 0 {
		t.Fatalf("%d profile rows after erasure", n)
	}
}
