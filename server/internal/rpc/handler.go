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
	"app.local/server/internal/botadmin"
	"app.local/server/internal/botupdates"
	"app.local/server/internal/chat"
	"app.local/server/internal/hooks"
	"app.local/server/internal/media"
	"app.local/server/internal/privacy"
	"app.local/server/internal/push"
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
	// Bots manages bots (BotAdminService, GetBotInfo); BotUpdates carries
	// button presses to bots and their answers back.
	Bots       *botadmin.Service
	BotUpdates *botupdates.Service
	// Media is nil when no storage is configured.
	Media *media.Service
	// Push holds the sessions' Web Push registrations (PushService).
	Push *push.Service
	// Privacy runs data exports and account deletion (PrivacyService).
	Privacy *privacy.Service
	// Feedback answers feedback through the tenant's assistant bot; nil
	// when the assistant is off (ReplyFeedback then fails).
	Feedback FeedbackReplier
	// Announcer sends operators' announcements through the assistant bot;
	// nil when the assistant is off (the announcement calls then fail).
	Announcer  Announcer
	TenantID   string
	TenantName string
	Logger     *slog.Logger
}

// NewHandler returns the Connect handler for AuthService, UsersService,
// ConfigService, ChatsService, MessagesService, UpdatesService,
// ModerationService, IntegrationsService, MediaService, SearchService,
// BotsService, BotAdminService, PushService and PrivacyService. Every call passes the Origin check, the id-contract check
// on request and response, and (except public procedures) the session check.
func NewHandler(d Deps) (http.Handler, error) {
	if d.Chat == nil || d.Hooks == nil || d.Bots == nil || d.BotUpdates == nil || d.Push == nil || d.Privacy == nil {
		return nil, errors.New("rpc: chat, hooks, bot, push and privacy services are required")
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
	mux.Handle(appv1connect.NewMessagesServiceHandler(&messagesService{chat: d.Chat, bots: d.BotUpdates, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewUpdatesServiceHandler(&updatesService{chat: d.Chat, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewModerationServiceHandler(&moderationService{chat: d.Chat, feedback: d.Feedback, announcer: d.Announcer, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewIntegrationsServiceHandler(&integrationsService{hooks: d.Hooks, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewMediaServiceHandler(&mediaService{media: d.Media, chat: d.Chat, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewSearchServiceHandler(&searchService{chat: d.Chat, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewBotsServiceHandler(&botsService{chat: d.Chat, bots: d.Bots, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewBotAdminServiceHandler(&botAdminService{bots: d.Bots, updates: d.BotUpdates, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewPushServiceHandler(&pushService{push: d.Push, logger: d.Logger}, opts...))
	mux.Handle(appv1connect.NewPrivacyServiceHandler(&privacyService{
		privacy: d.Privacy, store: d.Store, tenantID: d.TenantID, logger: d.Logger,
	}, opts...))
	return mux, nil
}
