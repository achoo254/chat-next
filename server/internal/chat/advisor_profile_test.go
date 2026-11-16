package chat

import (
	"context"
	"strings"
	"testing"

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
