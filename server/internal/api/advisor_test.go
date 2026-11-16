package api_test

import (
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"connectrpc.com/connect"
)

// The Advisor profile end to end: under /rpc with the session only, the
// caller's own profile, and a change reaches the user's log as
// advisor_profile.
func TestAdvisorProfileService(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, c := e.signedIn(t)
	base := e.srv.URL + "/rpc"
	advisor := appv1connect.NewAdvisorServiceClient(c, base, withOrigin(e.srv.URL))
	updates := appv1connect.NewUpdatesServiceClient(c, base, withOrigin(e.srv.URL))

	anonymous := appv1connect.NewAdvisorServiceClient(e.browser(t), base, withOrigin(e.srv.URL))
	if _, err := anonymous.GetAdvisorProfile(ctx, connect.NewRequest(&appv1.GetAdvisorProfileRequest{})); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("without a session: %v", err)
	}

	got := rpcOK(t, advisor.GetAdvisorProfile, &appv1.GetAdvisorProfileRequest{}).GetProfile()
	if got.GetName() != "" || got.GetLookId() != "owl" || got.GetTone() != appv1.AdvisorTone_ADVISOR_TONE_SHORT {
		t.Fatalf("defaults = %v", got)
	}
	start := rpcOK(t, updates.GetState, &appv1.GetStateRequest{}).GetState()
	look := "suit"
	set := rpcOK(t, advisor.SetAdvisorProfile, &appv1.SetAdvisorProfileRequest{LookId: &look})
	if set.GetProfile().GetLookId() != "suit" || set.GetAck().GetPts() == 0 {
		t.Fatalf("set = %v", set)
	}
	bad := "Suit!"
	if _, err := advisor.SetAdvisorProfile(ctx, connect.NewRequest(&appv1.SetAdvisorProfileRequest{LookId: &bad})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bad look: %v", err)
	}
	diff := rpcOK(t, updates.GetDifference, &appv1.GetDifferenceRequest{Pts: start.GetPts(), ServerEpoch: start.GetServerEpoch()}).GetFull()
	found := false
	for _, u := range diff.GetUpdates() {
		if p := u.GetAdvisorProfile().GetProfile(); p != nil && p.GetLookId() == "suit" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no advisor_profile update after the change: %v", diff.GetUpdates())
	}
}
