// Package botadmin manages bots for their owners (the Developer Console's
// BotAdminService) and authenticates Bot API tokens.
//
// A bot is a users row with is_bot plus a bots row in the owner's tenant.
// Its token is "<bot_id>:<secret>" with a 40 character CSPRNG secret of
// [A-Za-z0-9_-]; only SHA-256 of the secret is stored and compared in
// constant time, so a token is shown once (ResetBotToken). Revealing a new
// token and deleting a bot need an IdP sign-in within RecentSignIn (ADR 0006).
package botadmin

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/media"
	"app.local/server/internal/miniapp"
	"app.local/server/internal/profile"
	"app.local/server/internal/ratelimit"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Limits.
const (
	// BotsPerOwnerMax bounds the live bots of one owner.
	BotsPerOwnerMax = 20
	// RecentSignIn is how old the session's IdP sign-in may be for token
	// reveal and deletion (ADR 0006).
	RecentSignIn   = 10 * time.Minute
	secretLen      = 40
	descriptionMax = 512
	// inlinePlaceholderMax bounds the composer hint of inline mode.
	inlinePlaceholderMax = 64
	aboutMax             = 120
	commandsMax          = 100
	commandDescMax       = 256
)

// limitCreate bounds bot creations per owner (on top of BotsPerOwnerMax
// live bots), so create and delete cannot churn bot accounts without end.
var limitCreate = ratelimit.Rule{Rate: 1.0 / 180, Burst: BotsPerOwnerMax}

const secretAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"

var (
	botUsername = regexp.MustCompile(`^[a-z0-9_]{2,29}bot$`)
	commandName = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)
	tokenFormat = regexp.MustCompile(`^([1-9][0-9]{0,15}):([A-Za-z0-9_-]{35,128})$`)
)

// Tier names.
const (
	TierDefault    = "default"
	TierVerified   = "verified"
	TierInternal   = "internal"
	TierRestricted = "restricted"
	TierNew        = "new"
)

// NewBotAge is the age below which a bot that is not verified runs on the
// new tier.
const NewBotAge = 14 * 24 * time.Hour

// Command scopes as stored and as the Bot API names them.
const (
	ScopeDefault    = "default"
	ScopePrivate    = "private"
	ScopeGroup      = "group"
	ScopeGroupAdmin = "group_admin"
)

var scopeNames = map[appv1.BotCommandScope]string{
	appv1.BotCommandScope_BOT_COMMAND_SCOPE_DEFAULT:     ScopeDefault,
	appv1.BotCommandScope_BOT_COMMAND_SCOPE_PRIVATE:     ScopePrivate,
	appv1.BotCommandScope_BOT_COMMAND_SCOPE_GROUP:       ScopeGroup,
	appv1.BotCommandScope_BOT_COMMAND_SCOPE_GROUP_ADMIN: ScopeGroupAdmin,
}

// Command is one entry of a command menu.
type Command struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

// CommandSet is the menu of one scope.
type CommandSet struct {
	Scope    string    `json:"scope"`
	Commands []Command `json:"commands"`
}

// Bot is a bot as stored.
type Bot struct {
	ID          int64
	Username    string
	Name        string
	OwnerID     int64
	Description string
	About       string
	Privacy     bool
	// InlinePlaceholder is the composer hint of inline mode; "" is off.
	InlinePlaceholder string
	// PhotoID is the file_id of the bot's photo; "" without one.
	PhotoID string
	// MiniAppURL is the bot's main Mini App; "" for none.
	MiniAppURL    string
	Verified      bool
	Internal      bool
	Commands      []CommandSet
	CreatedAt     time.Time
	TokenIssuedAt *time.Time
	// LastUpdateAt is when the bot last asked for updates (RecordUpdateFetch);
	// nil when it never did.
	LastUpdateAt *time.Time
	// Webhook tells that updates are POSTed to the bot's webhook.
	Webhook bool
	// System marks the tenant's assistant: no human owner (OwnerID is the
	// bot itself), no token, run inside the api process.
	System bool
	// RestrictedAt is when the anti-abuse rule or an operator moved the bot
	// to the restricted tier; nil when it is not restricted.
	RestrictedAt *time.Time
	tokenHash    []byte
}

// Tier is the bot's rate limit tier.
func (b *Bot) Tier() string {
	switch {
	case b.Internal:
		return TierInternal
	case b.RestrictedAt != nil:
		return TierRestricted
	case b.Verified:
		return TierVerified
	case time.Since(b.CreatedAt) < NewBotAge:
		return TierNew
	default:
		return TierDefault
	}
}

// Service manages the bots of one tenant.
type Service struct {
	pool     *pgxpool.Pool
	tenantID string
	limiter  ratelimit.Limiter
	logger   *slog.Logger
	now      func() time.Time
	// miniAppURLs checks the URL of the bot's main Mini App.
	miniAppURLs *miniapp.URLs

	// fetchMu guards fetchWritten: when this process last wrote each bot's
	// last_update_fetch_at, so most polls skip the database (one entry per
	// bot that polled, bounded by the number of bots).
	fetchMu      sync.Mutex
	fetchWritten map[int64]time.Time
}

// New returns the Service.
func New(pool *pgxpool.Pool, tenantID string, miniAppURLs *miniapp.URLs, limiter ratelimit.Limiter, logger *slog.Logger) (*Service, error) {
	if pool == nil || tenantID == "" || miniAppURLs == nil || limiter == nil || logger == nil {
		return nil, errors.New("botadmin: missing configuration or dependency")
	}
	return &Service{pool: pool, tenantID: tenantID, limiter: limiter, logger: logger, now: time.Now,
		miniAppURLs: miniAppURLs, fetchWritten: map[int64]time.Time{}}, nil
}

// ------------------------------------------------------------------ errors

func errInvalid(format string, args ...any) error {
	return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf(format, args...))
}

func errNotFound() error {
	return connect.NewError(connect.CodeNotFound, errors.New("bot not found"))
}

// errReauth is the refusal clients act on by signing in again
// (/auth/login?reauth=1).
func errReauth() error {
	return connect.NewError(connect.CodeFailedPrecondition,
		errors.New("reauth_required: sign in again (within the last 10 minutes) to do this"))
}

// requireRecentSignIn checks the session's IdP auth_time.
func (s *Service) requireRecentSignIn(authTime time.Time) error {
	if authTime.IsZero() || s.now().Sub(authTime) > RecentSignIn {
		return errReauth()
	}
	return nil
}

// ------------------------------------------------------------------ tokens

// newSecret returns secretLen characters of secretAlphabet from crypto/rand.
func newSecret() (string, error) {
	var b strings.Builder
	limit := big.NewInt(int64(len(secretAlphabet)))
	for range secretLen {
		n, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return "", fmt.Errorf("botadmin: token secret: %w", err)
		}
		b.WriteByte(secretAlphabet[n.Int64()])
	}
	return b.String(), nil
}

func hashSecret(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// ParseToken splits "<bot_id>:<secret>"; ok is false for anything else.
func ParseToken(token string) (botID int64, secret string, ok bool) {
	m := tokenFormat.FindStringSubmatch(token)
	if m == nil {
		return 0, "", false
	}
	id, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || id >= 1<<53 {
		return 0, "", false
	}
	return id, m[2], true
}

// ------------------------------------------------------------------- rows

const botColumns = `b.user_id, u.username, u.name, b.owner_id, b.description, b.about, b.privacy, b.verified, b.internal,
	b.commands, b.created_at, b.token_issued_at, b.last_update_fetch_at, b.webhook_url IS NOT NULL, b.is_system, b.restricted_at,
	b.token_hash, b.inline_placeholder, coalesce((SELECT f.public_id FROM files f WHERE f.id = u.photo_file_id), ''),
	b.mini_app_url`

const botFrom = `bots b JOIN users u ON u.id = b.user_id`

func scanBot(row pgx.Row) (*Bot, error) {
	b := &Bot{}
	var commands []byte
	err := row.Scan(&b.ID, &b.Username, &b.Name, &b.OwnerID, &b.Description, &b.About, &b.Privacy, &b.Verified,
		&b.Internal, &commands, &b.CreatedAt, &b.TokenIssuedAt, &b.LastUpdateAt, &b.Webhook, &b.System, &b.RestrictedAt, &b.tokenHash,
		&b.InlinePlaceholder, &b.PhotoID, &b.MiniAppURL)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(commands, &b.Commands); err != nil {
		return nil, fmt.Errorf("botadmin: decode commands: %w", err)
	}
	return b, nil
}

// ownedBot loads a live bot of owner; NotFound otherwise.
func (s *Service) ownedBot(ctx context.Context, q interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}, owner, botID int64, lock bool) (*Bot, error) {
	sql := `SELECT ` + botColumns + ` FROM ` + botFrom + `
		WHERE b.user_id = $1 AND b.owner_id = $2 AND b.tenant_id = $3 AND b.deleted_at IS NULL AND NOT b.is_system`
	if lock {
		sql += ` FOR UPDATE OF b`
	}
	b, err := scanBot(q.QueryRow(ctx, sql, botID, owner, s.tenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound()
	}
	if err != nil {
		return nil, fmt.Errorf("botadmin: load bot: %w", err)
	}
	return b, nil
}

// Owned returns owner's live bot; NotFound when it is not theirs.
func (s *Service) Owned(ctx context.Context, owner, botID int64) (*Bot, error) {
	return s.ownedBot(ctx, s.pool, owner, botID, false)
}

// OwnedRecent is Owned for changes that hand over the bot's traffic (its
// webhook): like issuing a token, they need a recent IdP sign-in (authTime,
// ADR 0006), refused with reauth_required before anything is read.
func (s *Service) OwnedRecent(ctx context.Context, owner int64, authTime time.Time, botID int64) (*Bot, error) {
	if err := s.requireRecentSignIn(authTime); err != nil {
		return nil, err
	}
	return s.Owned(ctx, owner, botID)
}

// Live returns a live bot of the tenant; NotFound otherwise.
func (s *Service) Live(ctx context.Context, botID int64) (*Bot, error) {
	b, err := scanBot(s.pool.QueryRow(ctx, `SELECT `+botColumns+` FROM `+botFrom+`
		WHERE b.user_id = $1 AND b.tenant_id = $2 AND b.deleted_at IS NULL`, botID, s.tenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound()
	}
	if err != nil {
		return nil, fmt.Errorf("botadmin: load bot: %w", err)
	}
	return b, nil
}

// User is the bot's user as everyone sees it: name, inline mode hint and photo.
func (b *Bot) User() *appv1.User {
	u := &appv1.User{Id: b.ID, Username: b.Username, Name: b.Name, IsBot: true, BotInlinePlaceholder: b.InlinePlaceholder}
	if b.PhotoID != "" {
		u.Photo = media.PhotoRef(b.PhotoID)
	}
	return u
}

// Render returns the bot for its owner.
func (b *Bot) Render() *appv1.Bot {
	out := &appv1.Bot{
		User:        b.User(),
		Description: b.Description, About: b.About, Privacy: b.Privacy,
		Tier: appv1.BotTier_BOT_TIER_DEFAULT, HasToken: b.tokenHash != nil, CreatedAt: b.CreatedAt.Unix(),
	}
	out.Tier = TierOf(b.Tier())
	if b.TokenIssuedAt != nil && b.tokenHash != nil {
		out.TokenIssuedAt = b.TokenIssuedAt.Unix()
	}
	out.LastUpdateAt = b.lastUpdateUnix()
	out.Webhook = b.Webhook
	out.InlinePlaceholder = b.InlinePlaceholder
	out.MiniAppUrl = b.MiniAppURL
	for _, set := range b.Commands {
		out.Commands = append(out.Commands, renderSet(set))
	}
	return out
}

func renderSet(set CommandSet) *appv1.BotCommandSet {
	out := &appv1.BotCommandSet{}
	for scope, name := range scopeNames {
		if name == set.Scope {
			out.Scope = scope
		}
	}
	out.Commands = renderCommands(set.Commands)
	return out
}

func renderCommands(list []Command) []*appv1.BotCommand {
	out := make([]*appv1.BotCommand, 0, len(list))
	for _, c := range list {
		out = append(out, &appv1.BotCommand{Command: c.Command, Description: c.Description})
	}
	return out
}

// ----------------------------------------------------------------- manage

// ListMyBots returns owner's live bots, oldest first.
func (s *Service) ListMyBots(ctx context.Context, owner int64) ([]*appv1.Bot, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+botColumns+` FROM `+botFrom+`
		WHERE b.owner_id = $1 AND b.tenant_id = $2 AND b.deleted_at IS NULL AND NOT b.is_system
		ORDER BY b.created_at, b.user_id`, owner, s.tenantID)
	if err != nil {
		return nil, fmt.Errorf("botadmin: list bots: %w", err)
	}
	bots, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*Bot, error) { return scanBot(r) })
	if err != nil {
		return nil, fmt.Errorf("botadmin: list bots: %w", err)
	}
	out := make([]*appv1.Bot, 0, len(bots))
	for _, b := range bots {
		out = append(out, b.Render())
	}
	return out, nil
}

// CreateBot creates a bot of owner without a token. Anyone may add it to
// groups and write to it (privacy_settings), as bots have no contacts.
func (s *Service) CreateBot(ctx context.Context, owner int64, username, name string) (*appv1.Bot, error) {
	username = profile.NormalizeUsername(username)
	if !botUsername.MatchString(username) {
		return nil, errInvalid("username must have 5 to 32 characters of a-z, 0-9 and _ and end with \"bot\"")
	}
	name, err := profile.CleanName(name)
	if err != nil {
		return nil, errInvalid("name: %v", err)
	}
	var bot *Bot
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// The owner row lock serializes the owner's creations, so the
		// limit holds under concurrent calls.
		var isBot bool
		err := tx.QueryRow(ctx, `SELECT is_bot FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, owner, s.tenantID).Scan(&isBot)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && isBot) {
			return connect.NewError(connect.CodePermissionDenied, errors.New("only users create bots"))
		}
		if err != nil {
			return fmt.Errorf("botadmin: lock owner: %w", err)
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM bots WHERE owner_id = $1 AND deleted_at IS NULL AND NOT is_system`, owner).Scan(&n); err != nil {
			return fmt.Errorf("botadmin: count bots: %w", err)
		}
		if n >= BotsPerOwnerMax {
			return connect.NewError(connect.CodeFailedPrecondition,
				fmt.Errorf("bots_limit: an account owns at most %d bots", BotsPerOwnerMax))
		}
		if !s.limiter.Allow(limitCreate, "botcreate:"+strconv.FormatInt(owner, 10)) {
			return connect.NewError(connect.CodeResourceExhausted, errors.New("too many bots created; try again later"))
		}
		id, err := store.NextUserID(ctx, tx)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO users (id, tenant_id, idp_sub, username, name, is_bot) VALUES ($1, $2, NULL, $3, $4, true)
			ON CONFLICT DO NOTHING`, id, s.tenantID, username, name)
		if err != nil {
			return fmt.Errorf("botadmin: insert bot user: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return connect.NewError(connect.CodeAlreadyExists, errors.New("username_taken: this username is taken"))
		}
		if _, err := tx.Exec(ctx, `INSERT INTO bots (user_id, tenant_id, owner_id) VALUES ($1, $2, $3)`, id, s.tenantID, owner); err != nil {
			return fmt.Errorf("botadmin: insert bot: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO privacy_settings (user_id, add_to_groups, send_messages, last_seen) VALUES ($1, $2, $2, $3)`,
			id, int16(appv1.PrivacyAudience_PRIVACY_AUDIENCE_EVERYONE), int16(appv1.PrivacyAudience_PRIVACY_AUDIENCE_NOBODY)); err != nil {
			return fmt.Errorf("botadmin: bot privacy: %w", err)
		}
		bot, err = s.ownedBot(ctx, tx, owner, id, false)
		return err
	})
	if err != nil {
		return nil, err
	}
	s.logger.Info("bot created", "bot_id", bot.ID, "owner_id", owner)
	return bot.Render(), nil
}

// UpdateBot changes the fields set in req. A mini_app_url must pass
// miniapp.URLs.Check; "" removes the Mini App.
func (s *Service) UpdateBot(ctx context.Context, owner int64, req *appv1.UpdateBotRequest) (*appv1.Bot, error) {
	var name, description, about *string
	if req.Name != nil {
		v, err := profile.CleanName(req.GetName())
		if err != nil {
			return nil, errInvalid("name: %v", err)
		}
		name = &v
	}
	if req.Description != nil {
		v, err := cleanText(req.GetDescription(), descriptionMax, "description")
		if err != nil {
			return nil, err
		}
		description = &v
	}
	if req.About != nil {
		v, err := cleanText(req.GetAbout(), aboutMax, "about")
		if err != nil {
			return nil, err
		}
		about = &v
	}
	var inline *string
	if req.InlinePlaceholder != nil {
		v, err := cleanText(req.GetInlinePlaceholder(), inlinePlaceholderMax, "inline_placeholder")
		if err != nil {
			return nil, err
		}
		if strings.Contains(v, "\n") {
			return nil, errInvalid("inline_placeholder is one line")
		}
		inline = &v
	}
	if req.MiniAppUrl != nil && req.GetMiniAppUrl() != "" {
		if err := s.miniAppURLs.Check(ctx, s.pool, req.GetMiniAppUrl()); err != nil {
			return nil, err
		}
	}
	var commands []byte
	if req.GetCommands() != nil {
		sets, err := commandSetsOf(req.GetCommands().GetSets())
		if err != nil {
			return nil, err
		}
		if commands, err = json.Marshal(sets); err != nil {
			return nil, fmt.Errorf("botadmin: encode commands: %w", err)
		}
	}
	var bot *Bot
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := s.ownedBot(ctx, tx, owner, req.GetBotId(), true); err != nil {
			return err
		}
		if name != nil {
			if _, err := tx.Exec(ctx, `UPDATE users SET name = $2, updated_at = now() WHERE id = $1`, req.GetBotId(), *name); err != nil {
				return fmt.Errorf("botadmin: rename bot: %w", err)
			}
		}
		if req.PhotoFileId != nil {
			if err := s.setPhoto(ctx, tx, owner, req.GetBotId(), req.GetPhotoFileId()); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE bots SET description = coalesce($2, description), about = coalesce($3, about),
				privacy = coalesce($4, privacy), commands = coalesce($5::jsonb, commands),
				inline_placeholder = coalesce($6, inline_placeholder), mini_app_url = coalesce($7, mini_app_url),
				updated_at = now()
			WHERE user_id = $1`, req.GetBotId(), description, about, req.Privacy, commands, inline, req.MiniAppUrl); err != nil {
			return fmt.Errorf("botadmin: update bot: %w", err)
		}
		var err error
		bot, err = s.ownedBot(ctx, tx, owner, req.GetBotId(), false)
		return err
	})
	if err != nil {
		return nil, err
	}
	return bot.Render(), nil
}

// setPhoto makes fileID (a photo the owner uploaded) the bot's profile
// photo, or removes it when fileID is "".
func (s *Service) setPhoto(ctx context.Context, tx pgx.Tx, owner, botID int64, fileID string) error {
	var photo *int64
	if fileID != "" {
		var id int64
		err := tx.QueryRow(ctx, `SELECT id FROM files WHERE public_id = $1 AND tenant_id = $2 AND owner_id = $3 AND kind = 'photo'`,
			fileID, s.tenantID, owner).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return errInvalid("photo_file_id: not a photo you uploaded")
		}
		if err != nil {
			return fmt.Errorf("botadmin: photo: %w", err)
		}
		photo = &id
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET photo_file_id = $2, updated_at = now() WHERE id = $1`, botID, photo); err != nil {
		return fmt.Errorf("botadmin: set photo: %w", err)
	}
	return nil
}

// ResetBotToken issues a new token (the previous one stops working at
// once) and returns it with the bot. authTime is the session's IdP sign-in.
func (s *Service) ResetBotToken(ctx context.Context, owner int64, authTime time.Time, botID int64) (*appv1.Bot, string, error) {
	if err := s.requireRecentSignIn(authTime); err != nil {
		return nil, "", err
	}
	secret, err := newSecret()
	if err != nil {
		return nil, "", err
	}
	var bot *Bot
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := s.ownedBot(ctx, tx, owner, botID, true); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE bots SET token_hash = $2, token_issued_at = now(), updated_at = now() WHERE user_id = $1`,
			botID, hashSecret(secret)); err != nil {
			return fmt.Errorf("botadmin: store token: %w", err)
		}
		var err error
		bot, err = s.ownedBot(ctx, tx, owner, botID, false)
		return err
	})
	if err != nil {
		return nil, "", err
	}
	s.logger.Info("bot token reset", "bot_id", botID, "owner_id", owner)
	return bot.Render(), strconv.FormatInt(botID, 10) + ":" + secret, nil
}

// DeleteBot deletes a bot: no token, no pending updates or button presses.
// Its user row stays as the author of its messages, but its username is
// released (renamed to deleted_<id>) and its privacy settings hide it: it
// cannot be found by username or name, written to or added to groups.
func (s *Service) DeleteBot(ctx context.Context, owner int64, authTime time.Time, botID int64) error {
	if err := s.requireRecentSignIn(authTime); err != nil {
		return err
	}
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := s.ownedBot(ctx, tx, owner, botID, true); err != nil {
			return err
		}
		return s.deleteBot(ctx, tx, botID)
	})
	if err != nil {
		return err
	}
	s.logger.Info("bot deleted", "bot_id", botID, "owner_id", owner)
	return nil
}

// deleteBot deletes a bot whose row the transaction has locked.
func (s *Service) deleteBot(ctx context.Context, tx pgx.Tx, botID int64) error {
	for _, sql := range []string{
		`UPDATE bots SET deleted_at = now(), token_hash = NULL, token_issued_at = NULL, updated_at = now() WHERE user_id = $1`,
		`DELETE FROM bot_updates WHERE bot_id = $1`,
		`DELETE FROM bot_callbacks WHERE bot_id = $1`,
	} {
		if _, err := tx.Exec(ctx, sql, botID); err != nil {
			return fmt.Errorf("botadmin: delete bot: %w", err)
		}
	}
	nobody := int16(appv1.PrivacyAudience_PRIVACY_AUDIENCE_NOBODY)
	if _, err := tx.Exec(ctx, `
		UPDATE privacy_settings SET find_by_username = $2, find_by_email = $2, add_to_groups = $2, send_messages = $2,
			updated_at = now()
		WHERE user_id = $1`, botID, nobody); err != nil {
		return fmt.Errorf("botadmin: hide deleted bot: %w", err)
	}
	return s.releaseUsername(ctx, tx, botID)
}

// OwnedBots lists the live bots of owner (the tenant's assistant is never
// one), oldest first, whatever the state of the owner's account.
func (s *Service) OwnedBots(ctx context.Context, owner int64) ([]*appv1.OwnedBot, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT b.user_id, u.name, u.username FROM `+botFrom+`
		WHERE b.owner_id = $1 AND b.tenant_id = $2 AND b.deleted_at IS NULL AND NOT b.is_system
		ORDER BY b.created_at, b.user_id`, owner, s.tenantID)
	if err != nil {
		return nil, fmt.Errorf("botadmin: owned bots: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*appv1.OwnedBot, error) {
		b := &appv1.OwnedBot{}
		err := r.Scan(&b.BotId, &b.Name, &b.Username)
		return b, err
	})
	if err != nil {
		return nil, fmt.Errorf("botadmin: owned bots: %w", err)
	}
	return list, nil
}

// DeleteOwnedBots deletes every bot of owner, as DeleteBot does, when the
// owner's account is erased (no recent sign-in needed: the owner confirmed
// the account deletion with one). It returns how many.
func (s *Service) DeleteOwnedBots(ctx context.Context, owner int64) (int, error) {
	n := 0
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT user_id FROM bots WHERE owner_id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND NOT is_system
			ORDER BY user_id FOR UPDATE`, owner, s.tenantID)
		if err != nil {
			return fmt.Errorf("botadmin: bots of owner: %w", err)
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil {
			return fmt.Errorf("botadmin: bots of owner: %w", err)
		}
		for _, id := range ids {
			if err := s.deleteBot(ctx, tx, id); err != nil {
				return err
			}
		}
		n = len(ids)
		return nil
	})
	if err != nil {
		return 0, err
	}
	if n > 0 {
		s.logger.Info("bots deleted with their owner's account", "owner_id", owner, "bots", n)
	}
	return n, nil
}

// releaseUsername renames a deleted bot to deleted_<id> so its username
// can be registered again. No bot can take that name (bot usernames end in
// "bot"); if a user holds it, a random suffix is added.
func (s *Service) releaseUsername(ctx context.Context, tx pgx.Tx, botID int64) error {
	base := "deleted_" + strconv.FormatInt(botID, 10)
	for attempt := range 3 {
		name := base
		if attempt > 0 {
			n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
			if err != nil {
				return fmt.Errorf("botadmin: release username: %w", err)
			}
			name = fmt.Sprintf("%s_%06d", base, n.Int64())
		}
		tag, err := tx.Exec(ctx, `
			UPDATE users SET username = $2, updated_at = now() WHERE id = $1
				AND NOT EXISTS (SELECT 1 FROM users WHERE tenant_id = $3 AND username = $2)`, botID, name, s.tenantID)
		if err != nil {
			return fmt.Errorf("botadmin: release username: %w", err)
		}
		if tag.RowsAffected() == 1 {
			return nil
		}
	}
	return errors.New("botadmin: release username: every candidate name is taken")
}

// --------------------------------------------------------------- commands

// SetCommands replaces the command menu of one scope of the bot ("" is
// default); an empty list removes the scope.
func (s *Service) SetCommands(ctx context.Context, botID int64, scope string, list []Command) error {
	if scope == "" {
		scope = ScopeDefault
	}
	if !validScope(scope) {
		return errInvalid("scope must be default, private, group or group_admin")
	}
	clean, err := checkCommands(list)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var raw []byte
		err := tx.QueryRow(ctx, `SELECT commands FROM bots WHERE user_id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
			botID, s.tenantID).Scan(&raw)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound()
		}
		if err != nil {
			return fmt.Errorf("botadmin: load commands: %w", err)
		}
		var sets []CommandSet
		if err := json.Unmarshal(raw, &sets); err != nil {
			return fmt.Errorf("botadmin: decode commands: %w", err)
		}
		next := make([]CommandSet, 0, len(sets)+1)
		for _, set := range sets {
			if set.Scope != scope {
				next = append(next, set)
			}
		}
		if len(clean) > 0 {
			next = append(next, CommandSet{Scope: scope, Commands: clean})
		}
		encoded, err := json.Marshal(next)
		if err != nil {
			return fmt.Errorf("botadmin: encode commands: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE bots SET commands = $2, updated_at = now() WHERE user_id = $1`, botID, encoded); err != nil {
			return fmt.Errorf("botadmin: store commands: %w", err)
		}
		return nil
	})
}

func validScope(scope string) bool {
	for _, name := range scopeNames {
		if name == scope {
			return true
		}
	}
	return false
}

func commandSetsOf(sets []*appv1.BotCommandSet) ([]CommandSet, error) {
	out := []CommandSet{}
	seen := map[string]bool{}
	for _, set := range sets {
		scope, ok := scopeNames[set.GetScope()]
		if !ok {
			return nil, errInvalid("every command set needs a scope")
		}
		if seen[scope] {
			return nil, errInvalid("scope %s is listed twice", scope)
		}
		seen[scope] = true
		list := make([]Command, 0, len(set.GetCommands()))
		for _, c := range set.GetCommands() {
			list = append(list, Command{Command: c.GetCommand(), Description: c.GetDescription()})
		}
		clean, err := checkCommands(list)
		if err != nil {
			return nil, err
		}
		if len(clean) > 0 {
			out = append(out, CommandSet{Scope: scope, Commands: clean})
		}
	}
	return out, nil
}

func checkCommands(list []Command) ([]Command, error) {
	if len(list) > commandsMax {
		return nil, errInvalid("at most %d commands per scope", commandsMax)
	}
	seen := map[string]bool{}
	out := make([]Command, 0, len(list))
	for i, c := range list {
		name := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(c.Command), "/"))
		if !commandName.MatchString(name) {
			return nil, errInvalid("commands[%d]: a command has 1 to 32 characters of a-z, 0-9 and _", i)
		}
		if seen[name] {
			return nil, errInvalid("commands[%d]: /%s is listed twice", i, name)
		}
		seen[name] = true
		desc, err := cleanText(c.Description, commandDescMax, "description")
		if err != nil {
			return nil, err
		}
		if desc == "" {
			return nil, errInvalid("commands[%d]: a description is required", i)
		}
		out = append(out, Command{Command: name, Description: desc})
	}
	return out, nil
}

// cleanText trims a profile text; line breaks are the only control
// characters allowed.
func cleanText(s string, maxLen int, field string) (string, error) {
	s = strings.TrimSpace(s)
	switch {
	case !utf8.ValidString(s):
		return "", errInvalid("%s is not valid UTF-8", field)
	case utf8.RuneCountInString(s) > maxLen:
		return "", errInvalid("%s has more than %d characters", field, maxLen)
	case strings.IndexFunc(s, func(r rune) bool { return r != '\n' && unicode.IsControl(r) }) >= 0:
		return "", errInvalid("%s contains a control character", field)
	}
	return s, nil
}

// ---------------------------------------------------------- authenticate

// lastUpdateUnix is LastUpdateAt in Unix seconds; 0 when the bot never asked.
func (b *Bot) lastUpdateUnix() int64 {
	if b.LastUpdateAt == nil {
		return 0
	}
	return b.LastUpdateAt.Unix()
}

// updateFetchInterval is how stale bots.last_update_fetch_at may get while
// the bot keeps polling: one write per bot per interval at most.
const updateFetchInterval = 30 * time.Second

// notRunningAfter is how long a bot may go without asking for updates before
// its owner is told no program runs it: the write lag (updateFetchInterval)
// plus the longest long poll, with room to spare.
const notRunningAfter = 2 * time.Minute

// notRunning tells whether the bot has not asked for updates lately, by the
// server's clock. A bot with a webhook does not ask: its delivery state is
// in the Developer Console instead.
func (b *Bot) notRunning(now time.Time) bool {
	return !b.Webhook && (b.LastUpdateAt == nil || now.Sub(*b.LastUpdateAt) > notRunningAfter)
}

// RecordUpdateFetch notes that the bot asked for updates. It writes at most
// once per updateFetchInterval, and not at all while the update writer holds
// the bot's row (the next poll records it). Within the interval after this
// process wrote, it does not reach the database at all.
func (s *Service) RecordUpdateFetch(ctx context.Context, botID int64) error {
	now := s.now()
	s.fetchMu.Lock()
	written, ok := s.fetchWritten[botID]
	s.fetchMu.Unlock()
	if ok && now.Sub(written) < updateFetchInterval {
		return nil
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE bots SET last_update_fetch_at = now()
		WHERE user_id = (
			SELECT user_id FROM bots
			WHERE user_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
				AND (last_update_fetch_at IS NULL OR last_update_fetch_at < now() - make_interval(secs => $3))
			FOR UPDATE SKIP LOCKED)`,
		botID, s.tenantID, updateFetchInterval.Seconds())
	if err != nil {
		return fmt.Errorf("botadmin: record update fetch: %w", err)
	}
	// Nothing written (row locked, or recorded lately by another process):
	// the next poll asks the database again.
	if tag.RowsAffected() > 0 {
		s.fetchMu.Lock()
		s.fetchWritten[botID] = now
		s.fetchMu.Unlock()
	}
	return nil
}

// ErrBadToken is any token that does not open a live bot.
var ErrBadToken = errors.New("botadmin: invalid token")

// Authenticate returns the live bot whose token is token; ErrBadToken when
// the token is malformed, unknown, revoked, the bot is deleted or its
// owner's account waits for deletion (the bot is stopped until the owner
// cancels).
func (s *Service) Authenticate(ctx context.Context, token string) (*Bot, error) {
	botID, secret, ok := ParseToken(token)
	if !ok {
		return nil, ErrBadToken
	}
	b, err := scanBot(s.pool.QueryRow(ctx, `SELECT `+botColumns+` FROM `+botFrom+`
		WHERE b.user_id = $1 AND b.tenant_id = $2 AND b.deleted_at IS NULL AND b.token_hash IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id = b.owner_id AND o.deletion_requested_at IS NOT NULL)`,
		botID, s.tenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrBadToken
	}
	if err != nil {
		return nil, fmt.Errorf("botadmin: authenticate: %w", err)
	}
	if subtle.ConstantTimeCompare(b.tokenHash, hashSecret(secret)) != 1 {
		return nil, ErrBadToken
	}
	return b, nil
}

// ------------------------------------------------------------------ info

// ChatRole tells Info which command scope applies.
type ChatRole int

// Chat roles of the caller.
const (
	RolePrivate ChatRole = iota
	RoleGroupMember
	RoleGroupAdmin
)

// Info returns the public profile of a live bot with the command menu of
// role: GROUP_ADMIN, then GROUP (or PRIVATE), then DEFAULT. When caller owns
// the bot it also says so and when the bot last asked for updates.
func (s *Service) Info(ctx context.Context, caller, botID int64, role ChatRole) (*appv1.GetBotInfoResponse, error) {
	b, err := s.Live(ctx, botID)
	if err != nil {
		return nil, err
	}
	resp := &appv1.GetBotInfoResponse{
		User:        b.User(),
		Description: b.Description, About: b.About, MiniAppUrl: b.MiniAppURL,
	}
	if b.OwnerID == caller {
		resp.IsOwner = true
		resp.LastUpdateAt = b.lastUpdateUnix()
		resp.NotRunning = b.notRunning(s.now())
	}
	resp.Commands = b.menu(role)
	return resp, nil
}

// menu is the most specific command list the bot set for role.
func (b *Bot) menu(role ChatRole) []*appv1.BotCommand {
	var order []string
	switch role {
	case RoleGroupAdmin:
		order = []string{ScopeGroupAdmin, ScopeGroup, ScopeDefault}
	case RoleGroupMember:
		order = []string{ScopeGroup, ScopeDefault}
	default:
		order = []string{ScopePrivate, ScopeDefault}
	}
	for _, scope := range order {
		for _, set := range b.Commands {
			if set.Scope == scope {
				return renderCommands(set.Commands)
			}
		}
	}
	return nil
}

// Menus returns the command menus for role of the live bots among ids, in
// the order of ids, leaving out bots without commands.
func (s *Service) Menus(ctx context.Context, ids []int64, role ChatRole) ([]*appv1.ChatBotCommands, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT `+botColumns+` FROM `+botFrom+`
		WHERE b.user_id = ANY($1) AND b.tenant_id = $2 AND b.deleted_at IS NULL`, ids, s.tenantID)
	if err != nil {
		return nil, fmt.Errorf("botadmin: load bots: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*Bot, error) { return scanBot(r) })
	if err != nil {
		return nil, fmt.Errorf("botadmin: load bots: %w", err)
	}
	byID := make(map[int64]*Bot, len(list))
	for _, b := range list {
		byID[b.ID] = b
	}
	var out []*appv1.ChatBotCommands
	for _, id := range ids {
		b := byID[id]
		if b == nil {
			continue
		}
		if commands := b.menu(role); len(commands) > 0 {
			out = append(out, &appv1.ChatBotCommands{
				Bot: &appv1.User{Id: b.ID, Username: b.Username, Name: b.Name, IsBot: true}, Commands: commands,
			})
		}
	}
	return out, nil
}

// TierOf maps a tier name to the wire enum.
func TierOf(tier string) appv1.BotTier {
	switch tier {
	case TierInternal:
		return appv1.BotTier_BOT_TIER_INTERNAL
	case TierVerified:
		return appv1.BotTier_BOT_TIER_VERIFIED
	case TierRestricted:
		return appv1.BotTier_BOT_TIER_RESTRICTED
	case TierNew:
		return appv1.BotTier_BOT_TIER_NEW
	default:
		return appv1.BotTier_BOT_TIER_DEFAULT
	}
}
