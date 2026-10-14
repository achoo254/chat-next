// Package rpc serves the Connect services of the client protocol. The
// handler is mounted under /rpc (http.StripPrefix), so procedures live at
// /rpc/app.v1.<Service>/<Method>.
package rpc

import (
	"log/slog"
	"net/http"

	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/auth"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// maxRequestBytes bounds a request message.
const maxRequestBytes = 1 << 20

// Deps are the collaborators of the services.
type Deps struct {
	Store      *store.Store
	IdP        *auth.IdP
	Sessions   *auth.Sessions
	Origins    *auth.Origins
	TenantID   string
	TenantName string
	Logger     *slog.Logger
}

// NewHandler returns the Connect handler for AuthService, UsersService and
// ConfigService. Every call passes the Origin check, the id-contract check
// on request and response, and (except public procedures) the session check.
func NewHandler(d Deps) (http.Handler, error) {
	appConfig, err := newAppConfig()
	if err != nil {
		return nil, err
	}
	opts := []connect.HandlerOption{
		connect.WithInterceptors(
			originInterceptor(d.Origins),
			idsInterceptor(d.Logger),
			authInterceptor(d.Sessions, d.Logger),
		),
		connect.WithReadMaxBytes(maxRequestBytes),
	}
	mux := http.NewServeMux()
	mux.Handle(appv1connect.NewAuthServiceHandler(&authService{
		idp: d.IdP, sessions: d.Sessions, store: d.Store,
		tenantID: d.TenantID, tenantName: d.TenantName, logger: d.Logger,
	}, opts...))
	mux.Handle(appv1connect.NewUsersServiceHandler(&usersService{
		store: d.Store, tenantID: d.TenantID, logger: d.Logger,
	}, opts...))
	mux.Handle(appv1connect.NewConfigServiceHandler(&configService{config: appConfig}, opts...))
	return mux, nil
}
