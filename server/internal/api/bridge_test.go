package api_test

import (
	"context"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/api"
	"app.local/server/internal/config"
	"connectrpc.com/connect"
)

// With the bridge off (the default), BridgeService answers that it is off
// and does nothing; without a session it answers like every user service.
func TestBridgeServiceIsOffByDefault(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, c := e.signedIn(t)
	base := e.srv.URL + "/rpc"
	bridge := appv1connect.NewBridgeServiceClient(c, base, withOrigin(e.srv.URL))
	_, err := bridge.GetBridgeStatus(ctx, connect.NewRequest(&appv1.GetBridgeStatusRequest{}))
	if codeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "bridge_disabled") {
		t.Fatalf("status with the bridge off = %v, want failed_precondition bridge_disabled", err)
	}
	anonymous := appv1connect.NewBridgeServiceClient(e.browser(t), base, withOrigin(e.srv.URL))
	if _, err := anonymous.GetBridgeStatus(ctx, connect.NewRequest(&appv1.GetBridgeStatusRequest{})); codeOf(err) != connect.CodeUnauthenticated &&
		!strings.Contains(err.Error(), "bridge_disabled") {
		t.Fatalf("without a session = %v", err)
	}
}

// With the bridge on and no app connected, the user sees an empty status and
// a login for an app the server does not have is refused.
func TestBridgeServiceWithTheBridgeOn(t *testing.T) {
	e := newEnv(t, func(c *config.Config, _ *api.Options) { c.BridgeEnabled = true })
	ctx := context.Background()
	_, c := e.signedIn(t)
	base := e.srv.URL + "/rpc"
	bridge := appv1connect.NewBridgeServiceClient(c, base, withOrigin(e.srv.URL))
	status := rpcOK(t, bridge.GetBridgeStatus, &appv1.GetBridgeStatusRequest{})
	if len(status.GetApps()) != 0 || len(status.GetAccounts()) != 0 {
		t.Fatalf("status = %v, want no app and no account", status)
	}
	_, err := bridge.StartBridgeLogin(ctx, connect.NewRequest(&appv1.StartBridgeLoginRequest{Source: "telegram"}))
	if code := codeOf(err); code != connect.CodeInvalidArgument && code != connect.CodeFailedPrecondition {
		t.Fatalf("login to an app the server lacks = %v, want invalid_argument (or reauth_required)", err)
	}
}
