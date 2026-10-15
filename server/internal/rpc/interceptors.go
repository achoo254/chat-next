package rpc

import (
	"context"
	"errors"
	"log/slog"

	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/auth"
	"app.local/server/internal/protoids"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
)

// publicProcedures run without a session. Every other procedure requires
// one.
var publicProcedures = map[string]bool{
	appv1connect.AuthServiceGetAuthConfigProcedure:      true,
	appv1connect.AuthServiceExchangeNativeCodeProcedure: true,
	appv1connect.ConfigServiceGetAppConfigProcedure:     true,
}

// signedOutProcedures also run for a caller without a session (no session
// attached); the handler decides what that caller gets. A caller with a
// session gets it attached as for every other procedure.
var signedOutProcedures = map[string]bool{
	appv1connect.UsersServiceGetSelfProcedure: true,
}

type sessionKey struct{}

// sessionFrom returns the session the auth interceptor attached.
func sessionFrom(ctx context.Context) (store.Session, bool) {
	s, ok := ctx.Value(sessionKey{}).(store.Session)
	return s, ok
}

// mustSession returns the caller's session; handlers of non-public
// procedures always have one.
func mustSession(ctx context.Context) (store.Session, error) {
	s, ok := sessionFrom(ctx)
	if !ok {
		return store.Session{}, errUnauthenticated()
	}
	return s, nil
}

func errUnauthenticated() error {
	return connect.NewError(connect.CodeUnauthenticated, errors.New("sign-in required"))
}

// The services served here are unary only, so unary interceptors cover
// every call; a streaming service would need streaming interceptors too.

// originInterceptor rejects every call whose Origin header is not in the
// allowlist (CSRF defence together with the SameSite=Strict cookie).
func originInterceptor(origins *auth.Origins) connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			if !origins.Allowed(req.Header().Get("Origin")) {
				return nil, connect.NewError(connect.CodePermissionDenied, errors.New("origin not allowed"))
			}
			return next(ctx, req)
		}
	}
}

// idsInterceptor enforces the JS safe-integer contract (ADR 0001) on every
// request and response message.
func idsInterceptor(logger *slog.Logger) connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			if msg, ok := req.Any().(proto.Message); ok {
				if err := protoids.Check(msg); err != nil {
					return nil, connect.NewError(connect.CodeInvalidArgument, err)
				}
			}
			resp, err := next(ctx, req)
			if err != nil || resp == nil {
				return resp, err
			}
			if msg, ok := resp.Any().(proto.Message); ok {
				if err := protoids.Check(msg); err != nil {
					logger.Error("response violates the id contract", "procedure", req.Spec().Procedure, "err", err)
					return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
				}
			}
			return resp, nil
		}
	}
}

// authInterceptor resolves the session cookie into the caller's session.
// Authenticate also schedules the hourly IdP grant check.
func authInterceptor(sessions *auth.Sessions, logger *slog.Logger) connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			procedure := req.Spec().Procedure
			if publicProcedures[procedure] {
				return next(ctx, req)
			}
			token := auth.SessionToken(req.Header())
			if token == "" {
				if signedOutProcedures[procedure] {
					return next(ctx, req)
				}
				return nil, errUnauthenticated()
			}
			s, err := sessions.Authenticate(ctx, token)
			if errors.Is(err, auth.ErrNoSession) {
				if signedOutProcedures[procedure] {
					return next(ctx, req)
				}
				return nil, errUnauthenticated()
			}
			if err != nil {
				return nil, internal(ctx, logger, procedure, err)
			}
			return next(context.WithValue(ctx, sessionKey{}, s), req)
		}
	}
}

// internal logs err and returns an opaque Internal error. A call whose
// request context ended (the client aborted it or its deadline passed)
// failed because of the client, not the server: it is logged at Debug and
// answered Canceled or DeadlineExceeded rather than Internal. A deadline
// the server set on its own work leaves ctx alive and stays an error.
func internal(ctx context.Context, logger *slog.Logger, procedure string, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		code := connect.CodeCanceled
		if errors.Is(ctxErr, context.DeadlineExceeded) {
			code = connect.CodeDeadlineExceeded
		}
		logger.Debug("rpc ended by the client", "procedure", procedure, "code", code.String(), "err", err)
		return connect.NewError(code, ctxErr)
	}
	logger.Error("rpc failed", "procedure", procedure, "err", err)
	return connect.NewError(connect.CodeInternal, errors.New("internal error"))
}
