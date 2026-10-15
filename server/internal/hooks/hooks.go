// Package hooks implements incoming webhooks (release R2): admins of a group
// or channel create a hook and get a secret URL once; external tools POST
// to <web origin>/hook/<id>/<secret>[/<format>] and their notifications are
// posted (or updated in place, by group key) as integration messages.
//
// Secrets are stored as SHA-256 and compared in constant time; rotation
// keeps the previous secret working for 7 days unless revoked. A hook is
// turned off by a database trigger when its creator stops being an admin
// of the chat (see migration 0007). Counters are kept in memory and added
// to hook_counters every few seconds; unprocessable requests go to
// hook_dead_letters. Request paths are never logged: they carry the secret.
package hooks

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/chat"
	"app.local/server/internal/hooks/format"
	"app.local/server/internal/ratelimit"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Limits and timings.
const (
	hooksPerChatMax = 20
	nameMax         = 64
	// SecretGrace is how long a rotated-out secret keeps working.
	SecretGrace = 7 * 24 * time.Hour
	idLength    = 12
	secretLen   = 32
	// BodyMax bounds a request body.
	BodyMax          = 64 << 10
	deadLetterMax    = 16 << 10
	pageDefault      = 50
	pageMax          = 100
	statsHoursMax    = 720
	statsHoursDef    = 24
	idempotencyTTL   = 24 * time.Hour
	retention        = 30 * 24 * time.Hour
	flushEvery       = 5 * time.Second
	maintenanceEvery = time.Hour
)

// Rate limits per hook (stage 1 values, tuned in load tests). Dead letters
// have their own budget so a flood of bad requests cannot flood the table.
var (
	limitRequests    = ratelimit.Rule{Rate: 10, Burst: 100}
	limitDeadLetters = ratelimit.Rule{Rate: 1, Burst: 20}
)

// Vietnam has no daylight saving time; alert texts show local clock times.
var alertLocation = time.FixedZone("ICT", 7*60*60)

// Config holds the tenant settings of the hooks.
type Config struct {
	TenantID string
	// PublicOrigin is the tenant's web origin (https://chat.<domain>);
	// hooks answer only on its host and their URLs start with it.
	PublicOrigin string
	// AppScheme is the app's own URL scheme allowed in links (ADR 0004).
	AppScheme string
}

// Service manages hooks and serves their endpoint.
type Service struct {
	pool     *pgxpool.Pool
	chat     *chat.Service
	cfg      Config
	host     string
	limiter  ratelimit.Limiter
	logger   *slog.Logger
	counters *counters
	opts     format.Options
}

// New returns the Service; run Run in the background and Flush at shutdown.
func New(cfg Config, pool *pgxpool.Pool, chatSvc *chat.Service, limiter ratelimit.Limiter, logger *slog.Logger) (*Service, error) {
	if cfg.TenantID == "" || pool == nil || chatSvc == nil || limiter == nil || logger == nil {
		return nil, errors.New("hooks: missing configuration or dependency")
	}
	u, err := url.Parse(cfg.PublicOrigin)
	if err != nil || u.Host == "" {
		return nil, errors.New("hooks: PublicOrigin must be an absolute URL")
	}
	return &Service{
		pool: pool, chat: chatSvc, cfg: cfg, host: strings.ToLower(u.Host), limiter: limiter, logger: logger,
		counters: newCounters(),
		opts: format.Options{
			AppScheme: cfg.AppScheme, MaxLength: chatSvc.Config().MessageLengthMax, Location: alertLocation,
		},
	}, nil
}

// ------------------------------------------------------------------ rows

type hookRow struct {
	ID              string
	ChatID          int64
	Name            string
	Format          string
	AllowAlert      bool
	Silent          bool
	CreatedBy       int64
	CreatedAt       time.Time
	SecretHash      []byte
	SecretCreatedAt time.Time
	SecretCreatedBy int64
	PrevHash        []byte
	PrevExpiresAt   *time.Time
	State           string
	DisabledReason  string
	DisabledAt      *time.Time
	LastUsedAt      *time.Time
}

const hookColumns = `id, chat_id, name, format, allow_alert, silent, created_by, created_at, secret_hash, secret_created_at,
	secret_created_by, prev_secret_hash, prev_expires_at, state, disabled_reason, disabled_at, last_used_at`

func scanHook(row pgx.Row) (*hookRow, error) {
	h := &hookRow{}
	err := row.Scan(&h.ID, &h.ChatID, &h.Name, &h.Format, &h.AllowAlert, &h.Silent, &h.CreatedBy, &h.CreatedAt,
		&h.SecretHash, &h.SecretCreatedAt, &h.SecretCreatedBy, &h.PrevHash, &h.PrevExpiresAt, &h.State,
		&h.DisabledReason, &h.DisabledAt, &h.LastUsedAt)
	return h, err
}

// querier is a pool or a transaction.
type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// loadHook returns the tenant's hook, or nil when there is none. lock
// takes its row lock (inside a transaction).
func (s *Service) loadHook(ctx context.Context, q querier, id string, lock bool) (*hookRow, error) {
	sql := `SELECT ` + hookColumns + ` FROM incoming_hooks WHERE id = $1 AND tenant_id = $2`
	if lock {
		sql += ` FOR UPDATE`
	}
	h, err := scanHook(q.QueryRow(ctx, sql, id, s.cfg.TenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("hooks: load hook: %w", err)
	}
	return h, nil
}

var (
	formatOf = map[appv1.IncomingHookFormat]format.Kind{
		appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE:       format.Native,
		appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_SLACK:        format.Slack,
		appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_ALERTMANAGER: format.Alertmanager,
		appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_GRAFANA:      format.Grafana,
		appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_GITLAB:       format.GitLab,
	}
	stateOf = map[string]appv1.IncomingHookState{
		"active":        appv1.IncomingHookState_INCOMING_HOOK_STATE_ACTIVE,
		"disabled":      appv1.IncomingHookState_INCOMING_HOOK_STATE_DISABLED,
		"auto_disabled": appv1.IncomingHookState_INCOMING_HOOK_STATE_AUTO_DISABLED,
	}
	reasonOf = map[string]appv1.IncomingHookDisabledReason{
		"by_admin":          appv1.IncomingHookDisabledReason_INCOMING_HOOK_DISABLED_REASON_BY_ADMIN,
		"creator_not_admin": appv1.IncomingHookDisabledReason_INCOMING_HOOK_DISABLED_REASON_CREATOR_NOT_ADMIN,
		"creator_left":      appv1.IncomingHookDisabledReason_INCOMING_HOOK_DISABLED_REASON_CREATOR_LEFT,
	}
	auditActionOf = map[string]appv1.IncomingHookAuditAction{
		"created":                 appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_CREATED,
		"secret_rotated":          appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_SECRET_ROTATED,
		"previous_secret_revoked": appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_PREVIOUS_SECRET_REVOKED,
		"disabled":                appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_DISABLED,
		"enabled":                 appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_ENABLED,
		"auto_disabled":           appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_AUTO_DISABLED,
		"taken_over":              appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_TAKEN_OVER,
		"deleted":                 appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_DELETED,
		"updated":                 appv1.IncomingHookAuditAction_INCOMING_HOOK_AUDIT_ACTION_UPDATED,
	}
)

func formatEnum(k string) appv1.IncomingHookFormat {
	for e, kind := range formatOf {
		if string(kind) == k {
			return e
		}
	}
	return appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_UNSPECIFIED
}

func unix(t *time.Time) int64 {
	if t == nil {
		return 0
	}
	return t.Unix()
}

func (h *hookRow) render(now time.Time) *appv1.IncomingHook {
	out := &appv1.IncomingHook{
		Id: h.ID, ChatId: h.ChatID, Name: h.Name, Format: formatEnum(h.Format), AllowAlert: h.AllowAlert,
		Silent: h.Silent, CreatedBy: h.CreatedBy, CreatedAt: h.CreatedAt.Unix(), State: stateOf[h.State],
		DisabledReason: reasonOf[h.DisabledReason], DisabledAt: unix(h.DisabledAt), LastUsedAt: unix(h.LastUsedAt),
		SecretCreatedAt: h.SecretCreatedAt.Unix(), SecretCreatedBy: h.SecretCreatedBy,
	}
	if h.PrevHash != nil && h.PrevExpiresAt != nil && h.PrevExpiresAt.After(now) {
		out.PreviousSecretExpiresAt = h.PrevExpiresAt.Unix()
	}
	return out
}

// url is the hook's full URL with a secret.
func (s *Service) url(h *hookRow, secret string) string {
	return s.cfg.PublicOrigin + "/hook/" + h.ID + "/" + secret + format.Kind(h.Format).Suffix()
}

// --------------------------------------------------------------- secrets

const base62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

func randomBase62(n int) (string, error) {
	out := make([]byte, n)
	limit := big.NewInt(int64(len(base62)))
	for i := range out {
		v, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return "", fmt.Errorf("hooks: random: %w", err)
		}
		out[i] = base62[v.Int64()]
	}
	return string(out), nil
}

func hashSecret(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

func newSecret() (string, []byte, error) {
	secret, err := randomBase62(secretLen)
	if err != nil {
		return "", nil, err
	}
	return secret, hashSecret(secret), nil
}

// ---------------------------------------------------------------- errors

func errInvalid(format string, args ...any) error {
	return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf(format, args...))
}

func errNotFound() error {
	return connect.NewError(connect.CodeNotFound, errors.New("hook not found"))
}

func errPrecondition(format string, args ...any) error {
	return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf(format, args...))
}

// cleanName validates a hook name: 1 to 64 characters, no control
// characters, trimmed.
func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || name == "" || utf8.RuneCountInString(name) > nameMax {
		return "", errInvalid("name must have 1 to %d characters", nameMax)
	}
	if strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", errInvalid("name must not contain control characters")
	}
	return name, nil
}
