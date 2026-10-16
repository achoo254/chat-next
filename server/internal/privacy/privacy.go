// Package privacy carries out the user's rights over their chat data
// (Phase 12, Nghị định 13/2023): a downloadable export of personal data,
// deletion of the chat account with a 30-day grace period, and
// auto-deletion of accounts unused for the months the user chose. Only chat
// data is concerned; the hoandat account belongs to the IdP.
// docs/privacy/data-inventory.md lists what is kept, where and how long.
package privacy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/chat"
	"app.local/server/internal/media"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Timing of the rights (Phase 12 requirements).
const (
	// GracePeriod runs from the deletion request to the erasure; signing
	// in during it offers to cancel.
	GracePeriod = 30 * 24 * time.Hour
	// ExportRetention keeps a ready export downloadable.
	ExportRetention = 30 * 24 * time.Hour
	// ExportInterval is the least time between two export requests
	// (failed exports do not count).
	ExportInterval = 7 * 24 * time.Hour
	// RecentSignIn bounds the age of the IdP sign-in that confirms a
	// deletion (ADR 0006).
	RecentSignIn = 10 * time.Minute
	// jobInterval runs the purge of due accounts, the inactivity scan and
	// the expiry of old exports.
	jobInterval = time.Hour
	// jobTimeout bounds one run of those jobs.
	jobTimeout = 30 * time.Minute
)

// AutoDeleteMonths are the choices of the auto-delete setting (0 is off).
var AutoDeleteMonths = []int32{0, 6, 12, 24}

// SessionRevoker ends every session of an account and its IdP grants
// (auth.Sessions).
type SessionRevoker interface {
	RevokeAll(ctx context.Context, userID int64) (int, error)
}

// Bots are the owner's bots: listed on the delete screen, deleted with the
// account (botadmin.Service).
type Bots interface {
	OwnedBots(ctx context.Context, owner int64) ([]*appv1.OwnedBot, error)
	DeleteOwnedBots(ctx context.Context, owner int64) (int, error)
}

// MediaReader reads stored files into an export (media.Service).
type MediaReader interface {
	ReadOriginal(ctx context.Context, f *media.File) (io.ReadCloser, error)
}

// Config configures the Service.
type Config struct {
	TenantID string
	// ExportDir holds the export ZIPs; empty turns exports off.
	ExportDir string
	// MediaOrigin is the media host that serves export downloads, e.g.
	// https://media-chat.hoandat.com; empty turns exports off.
	MediaOrigin string
	// SessionKey derives the key of download tokens.
	SessionKey []byte
	// SessionKeyPrevious still verifies tokens signed before a key rotation.
	SessionKeyPrevious []byte
	// ExportMaxBytes bounds one ZIP (0: DefaultExportMaxBytes); the files
	// that would pass it are listed as left out instead of copied.
	ExportMaxBytes int64
	// MinFreeBytes is the disk space an export build leaves free in
	// ExportDir.
	MinFreeBytes int64
}

// DefaultExportMaxBytes bounds an export ZIP.
const DefaultExportMaxBytes = 4 << 30

// Deps are the collaborators of the Service.
type Deps struct {
	Pool     *pgxpool.Pool
	Chat     *chat.Service
	Sessions SessionRevoker
	Bots     Bots
	// Media is nil when media storage is off (exports then carry no files).
	Media  MediaReader
	Logger *slog.Logger
}

// Service implements PrivacyService and its background jobs.
type Service struct {
	cfg    Config
	pool   *pgxpool.Pool
	chat   *chat.Service
	revoke SessionRevoker
	bots   Bots
	media  MediaReader
	logger *slog.Logger
	sign   signer
	now    func() time.Time
	// kick wakes the export builder after a request.
	kick chan struct{}
	// jobs serializes the purge, scan and expiry runs of this process.
	jobs sync.Mutex
}

// New returns the Service; exports are on when cfg names an export
// directory and a media host, and the directory can be created.
func New(cfg Config, d Deps) (*Service, error) {
	if d.Pool == nil || d.Chat == nil || d.Sessions == nil || d.Bots == nil || d.Logger == nil {
		return nil, errors.New("privacy: pool, chat, sessions, bots and logger are required")
	}
	if cfg.ExportMaxBytes <= 0 {
		cfg.ExportMaxBytes = DefaultExportMaxBytes
	}
	if cfg.MediaOrigin == "" {
		cfg.ExportDir = ""
	}
	if cfg.ExportDir != "" {
		if err := os.MkdirAll(cfg.ExportDir, 0o750); err != nil {
			return nil, fmt.Errorf("privacy: export directory: %w", err)
		}
	}
	return &Service{
		cfg: cfg, pool: d.Pool, chat: d.Chat, revoke: d.Sessions, bots: d.Bots, media: d.Media, logger: d.Logger,
		sign: newSigner(cfg.SessionKey, cfg.SessionKeyPrevious), now: time.Now, kick: make(chan struct{}, 1),
	}, nil
}

// ExportsEnabled reports whether exports can be built and downloaded.
func (s *Service) ExportsEnabled() bool {
	return s.cfg.ExportDir != ""
}

// Run builds requested exports and runs the hourly jobs until ctx ends.
func (s *Service) Run(ctx context.Context) {
	s.RunJobs(ctx)
	hourly := time.NewTicker(jobInterval)
	defer hourly.Stop()
	poll := time.NewTicker(exportPoll)
	defer poll.Stop()
	for {
		s.buildPending(ctx)
		select {
		case <-ctx.Done():
			return
		case <-hourly.C:
			s.RunJobs(ctx)
		case <-poll.C:
		case <-s.kick:
		}
	}
}

// RunJobs runs the jobs once: erase the accounts whose grace period ended,
// schedule the deletion of accounts unused for their auto-delete period,
// and delete expired exports. Errors are logged; the next run retries.
func (s *Service) RunJobs(ctx context.Context) {
	s.jobs.Lock()
	defer s.jobs.Unlock()
	ctx, cancel := context.WithTimeout(ctx, jobTimeout)
	defer cancel()
	if n, err := s.purgeDue(ctx); err != nil {
		s.logger.Error("erasing deleted accounts failed", "err", err)
	} else if n > 0 {
		s.logger.Info("deleted accounts erased", "accounts", n)
	}
	if n, err := s.scheduleInactive(ctx); err != nil {
		s.logger.Error("auto-delete scan failed", "err", err)
	} else if n > 0 {
		s.logger.Info("unused accounts scheduled for deletion", "accounts", n)
	}
	if n, err := s.expireExports(ctx); err != nil {
		s.logger.Error("expiring data exports failed", "err", err)
	} else if n > 0 {
		s.logger.Info("data exports expired", "exports", n)
	}
}

func errInvalid(format string, args ...any) error {
	return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf(format, args...))
}

func errPrecondition(format string, args ...any) error {
	return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf(format, args...))
}

func errNotFound(what string) error {
	return connect.NewError(connect.CodeNotFound, fmt.Errorf("%s not found", what))
}

func errReauth() error {
	return errPrecondition("reauth_required: sign in again (within the last 10 minutes) to do this")
}
