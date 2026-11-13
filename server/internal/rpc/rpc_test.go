package rpc

import (
	"context"
	"io"
	"log/slog"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/auth"
	"app.local/server/internal/ids"
	"connectrpc.com/connect"
)

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

func TestIDsInterceptorChecksRequestAndResponse(t *testing.T) {
	respond := func(resp connect.AnyResponse) connect.UnaryFunc {
		return func(context.Context, connect.AnyRequest) (connect.AnyResponse, error) { return resp, nil }
	}
	guard := idsInterceptor(discard)
	ctx := context.Background()
	ok := connect.NewResponse(&appv1.GetUsersResponse{})

	bad := connect.NewRequest(&appv1.GetUsersRequest{UserIds: []int64{ids.MaxSafeID + 1}})
	if _, err := guard(respond(ok))(ctx, bad); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("unsafe request: %v", err)
	}

	good := connect.NewRequest(&appv1.GetUsersRequest{UserIds: []int64{ids.MaxSafeID}})
	unsafe := connect.NewResponse(&appv1.GetUsersResponse{Users: []*appv1.User{{Id: ids.MaxSafeID + 1}}})
	if _, err := guard(respond(unsafe))(ctx, good); connect.CodeOf(err) != connect.CodeInternal {
		t.Fatalf("unsafe response: %v", err)
	}
	safe := connect.NewResponse(&appv1.GetUsersResponse{Users: []*appv1.User{{Id: ids.MaxSafeID}}})
	if _, err := guard(respond(safe))(ctx, good); err != nil {
		t.Fatalf("safe response: %v", err)
	}
}

func TestOriginInterceptor(t *testing.T) {
	next := func(context.Context, connect.AnyRequest) (connect.AnyResponse, error) {
		return connect.NewResponse(&appv1.GetSelfResponse{}), nil
	}
	guard := originInterceptor(auth.NewOrigins("https://chat.hoandat.com"))
	for origin, want := range map[string]connect.Code{
		"":                          connect.CodePermissionDenied,
		"https://evil.example":      connect.CodePermissionDenied,
		"http://chat.hoandat.com":   connect.CodePermissionDenied,
		"https://chat.hoandat.com":  0,
		"https://CHAT.hoandat.com":  0,
		"https://chat.hoandat.com.": connect.CodePermissionDenied,
	} {
		req := connect.NewRequest(&appv1.GetSelfRequest{})
		if origin != "" {
			req.Header().Set("Origin", origin)
		}
		_, err := guard(next)(context.Background(), req)
		if got := connect.CodeOf(err); err != nil && got != want || err == nil && want != 0 {
			t.Errorf("Origin %q: err %v, want code %v", origin, err, want)
		}
	}
}

func TestAppConfigHashIsStable(t *testing.T) {
	a, err := newAppConfig(2000 << 20)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := newAppConfig(2000 << 20)
	if a.GetHash() == "" || a.GetHash() != b.GetHash() {
		t.Fatalf("hashes %q / %q", a.GetHash(), b.GetHash())
	}
}
