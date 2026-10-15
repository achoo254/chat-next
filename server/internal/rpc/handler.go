// Package rpc serves the Connect services of the client protocol. The
// handler is mounted under /rpc (http.StripPrefix), so procedures live at
// /rpc/app.v1.<Service>/<Method>.
package rpc

import (
	"errors"
	"log/slog"
	"net/http"

	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/auth"
	"app.local/server/internal/chat"
	"app.local/server/internal/hooks"
	"app.local/server/internal/media"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// maxRequestBytes bounds a request message.
const maxRequestBytes = 1 << 20

var (
	errMediaDisabled = errors.New("media_disabled: media storage is not configured")
	errBadURLBatch   = errors.New("requests must hold 1 to 100 files")
)

// Deps are the collaborators of the services.
type Deps struct {
	Store    *store.Store
	IdP      *auth.IdP
	Sessions *auth.Sessions
	Origins  *auth.Origins
	Chat     *chat.Service
	Hooks    *hooks.Service
	// Media is nil when no storage is configured.
	Media      *media.Service
	TenantID   string
	TenantName string
	Logger     *slog.Logger
}

// NewHandler returns the Connect handler for AuthService, UsersService,
// ConfigService, ChatsService, MessagesService, UpdatesService,
// ModerationService, IntegrationsService and MediaService. Every call passes the Origin check, the id-contract check
// on request and response, and (except public procedures) the session check.
func NewHandler(d Deps) (http.Handler, error) {
	if d.Chat == nil || d.Hooks == nil {
		return nil, errors.New("rpc: chat and hooks services are required")
	}
	var uploadMax int64
	if d.Media != nil {
		uploadMax = d.Media.Config().UploadMaxBytes
	}
	appConfig, err := newAppConfig(uploadMax)
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
		store: d.Store, chat: d.Chat, tenantID: d.TenantID, logger: d.Logger,
	}, opts...))
	mux.Handle(appv1connect.NewConfigServiceHandler(&configService{config: appConfig}, opts...))
	mux.Handle(appv1connect.NewChatsServiceHandler(&chatsService{chat: d.Chat, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewMessagesServiceHandler(&messagesService{chat: d.Chat, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewUpdatesServiceHandler(&updatesService{chat: d.Chat, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewModerationServiceHandler(&moderationService{chat: d.Chat, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewIntegrationsServiceHandler(&integrationsService{hooks: d.Hooks, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewMediaServiceHandler(&mediaService{media: d.Media, chat: d.Chat, logger: d.Logger}, opts...))
	return mux, nil
}
