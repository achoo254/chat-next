package api_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/api"
	"app.local/server/internal/config"
	"app.local/server/internal/webpush/webpushtest"
	"connectrpc.com/connect"
)

func withWebPush(t *testing.T) func(*config.Config, *api.Options) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return func(cfg *config.Config, _ *api.Options) {
		cfg.WebPush = &config.WebPush{VAPIDKey: key, Subject: "mailto:ops@example.test"}
	}
}

func (e *env) pushClient(c *http.Client) appv1connect.PushServiceClient {
	return appv1connect.NewPushServiceClient(c, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
}

func (e *env) subscriptionCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := e.store.Pool().QueryRow(context.Background(), `SELECT count(*) FROM push_subscriptions`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestWebPushRPCs(t *testing.T) {
	e := newEnv(t, withWebPush(t))
	ctx := context.Background()
	_, c := e.signedIn(t)
	pc := e.pushClient(c)
	cfg, err := pc.GetWebPushConfig(ctx, connect.NewRequest(&appv1.GetWebPushConfigRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Msg.GetApplicationServerKey()) != 65 || cfg.Msg.GetEndpoint() != "" {
		t.Fatalf("config %x %q", cfg.Msg.GetApplicationServerKey(), cfg.Msg.GetEndpoint())
	}
	b, err := webpushtest.NewBrowser()
	if err != nil {
		t.Fatal(err)
	}
	// An endpoint outside the push services is refused (no SSRF through
	// the endpoint a client picks).
	_, err = pc.RegisterWebPush(ctx, connect.NewRequest(&appv1.RegisterWebPushRequest{
		Endpoint: "https://169.254.169.254/latest", P256Dh: b.P256DH, Auth: b.Auth, Locale: "vi"}))
	if codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("internal endpoint: %v", err)
	}
	endpoint := "https://fcm.googleapis.com/fcm/send/rpc-test"
	if _, err := pc.RegisterWebPush(ctx, connect.NewRequest(&appv1.RegisterWebPushRequest{
		Endpoint: endpoint, P256Dh: b.P256DH, Auth: b.Auth, Locale: "vi"})); err != nil {
		t.Fatal(err)
	}
	cfg, err = pc.GetWebPushConfig(ctx, connect.NewRequest(&appv1.GetWebPushConfigRequest{}))
	if err != nil || cfg.Msg.GetEndpoint() != endpoint {
		t.Fatalf("registered endpoint %q: %v", cfg.Msg.GetEndpoint(), err)
	}

	// The service worker re-registers over JSON when the browser renews
	// the subscription (pushsubscriptionchange), with the session cookie.
	renewed := "https://fcm.googleapis.com/fcm/send/rpc-test-renewed"
	body := fmt.Sprintf(`{"endpoint":%q,"p256dh":%q,"auth":%q}`, renewed,
		base64.StdEncoding.EncodeToString(b.P256DH), base64.StdEncoding.EncodeToString(b.Auth))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.srv.URL+"/rpc/app.v1.PushService/RegisterWebPush", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", e.srv.URL)
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if got := readBody(t, resp); resp.StatusCode != http.StatusOK {
		t.Fatalf("JSON register: %d %s", resp.StatusCode, got)
	}
	cfg, _ = pc.GetWebPushConfig(ctx, connect.NewRequest(&appv1.GetWebPushConfigRequest{}))
	if cfg.Msg.GetEndpoint() != renewed || e.subscriptionCount(t) != 1 {
		t.Fatalf("renewed endpoint %q, %d subscriptions", cfg.Msg.GetEndpoint(), e.subscriptionCount(t))
	}

	if _, err := e.pushClient(e.browser(t)).GetWebPushConfig(ctx, connect.NewRequest(&appv1.GetWebPushConfigRequest{})); codeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("signed out: %v", err)
	}

	// Signing out revokes the session and with it the subscription.
	e.postLogout(t, c)
	if n := e.subscriptionCount(t); n != 0 {
		t.Fatalf("%d subscriptions after sign-out", n)
	}
}

func TestWebPushOff(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, c := e.signedIn(t)
	pc := e.pushClient(c)
	cfg, err := pc.GetWebPushConfig(ctx, connect.NewRequest(&appv1.GetWebPushConfigRequest{}))
	if err != nil || len(cfg.Msg.GetApplicationServerKey()) != 0 {
		t.Fatalf("config without a key: %x %v", cfg.Msg.GetApplicationServerKey(), err)
	}
	b, err := webpushtest.NewBrowser()
	if err != nil {
		t.Fatal(err)
	}
	_, err = pc.RegisterWebPush(ctx, connect.NewRequest(&appv1.RegisterWebPushRequest{
		Endpoint: "https://fcm.googleapis.com/fcm/send/x", P256Dh: b.P256DH, Auth: b.Auth}))
	if codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("register without a key: %v", err)
	}
	if _, err := pc.UnregisterWebPush(ctx, connect.NewRequest(&appv1.UnregisterWebPushRequest{})); err != nil {
		t.Fatal(err)
	}
}
