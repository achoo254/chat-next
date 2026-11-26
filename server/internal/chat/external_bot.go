package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/media"
	"github.com/jackc/pgx/v5"
)

// openAppURLs is where a bot of another app is opened, by the app's name: the bot's own page
// there, which is what its "open app" button leads to (Chat cannot run that web app).
var openAppURLs = map[string]string{"telegram": "https://t.me/"}

// externalBotInfo is external_users.bot_info as the Chat Bridge writes it.
type externalBotInfo struct {
	Username    string `json:"username"`
	Description string `json:"description"`
	About       string `json:"about"`
	Commands    []struct {
		Command     string `json:"command"`
		Description string `json:"description"`
	} `json:"commands"`
	OpensApp bool `json:"opens_app"`
}

// ExternalBotInfo is GetBotInfo for a bot of another app that the Chat Bridge brought in: the
// puppet standing for the bot, in an account of me. It returns ok false when botID is not
// such a bot of me (the caller then answers as for any unknown bot). What the bot says about
// itself is read by the bridge now and then; until the first read the answer has the
// bot's name only.
func (s *Service) ExternalBotInfo(ctx context.Context, me, botID int64) (*appv1.GetBotInfoResponse, bool, error) {
	var (
		source string
		raw    []byte
		pic    string
	)
	err := s.pool.QueryRow(ctx, `
		SELECT a.source, x.bot_info, coalesce(f.public_id, '')
		FROM external_users x
		JOIN external_accounts a ON a.id = x.account_id AND a.owner_id = $1
		JOIN users u ON u.id = x.user_id AND u.tenant_id = $3 AND `+liveUser+`
		LEFT JOIN files f ON f.id = x.bot_photo_file_id
		WHERE x.user_id = $2 AND x.is_bot`, me, botID, s.cfg.TenantID).Scan(&source, &raw, &pic)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("chat: external bot: %w", err)
	}
	users, err := loadUsers(ctx, s.pool, s.cfg.TenantID, []int64{botID})
	if err != nil {
		return nil, false, err
	}
	row := users[botID]
	if row == nil {
		return nil, false, nil
	}
	resp := &appv1.GetBotInfoResponse{User: row.render(me, false), ExternalApp: source}
	if len(raw) == 0 {
		return resp, true, nil
	}
	var info externalBotInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return nil, false, fmt.Errorf("chat: external bot info: %w", err)
	}
	resp.Description, resp.About = info.Description, info.About
	if info.Username != "" {
		resp.User.Username = info.Username
		if base := openAppURLs[source]; base != "" && info.OpensApp {
			resp.OpenUrl = base + info.Username
		}
	}
	for _, c := range info.Commands {
		resp.Commands = append(resp.Commands, &appv1.BotCommand{Command: c.Command, Description: c.Description})
	}
	if pic != "" {
		resp.DescriptionPhoto = media.PhotoRef(pic)
	}
	return resp, true, nil
}

// botDescriptionAccess grants the picture a bot of another app shows in an empty chat
// (bot_description_of), to the owner of the account that met the bot.
func (s *Service) botDescriptionAccess(ctx context.Context, viewer int64, reqs []*appv1.GetFileUrlRequest, out []*media.Access) error {
	for i, r := range reqs {
		bot := r.GetBotDescriptionOf()
		if bot <= 0 || !media.ValidPublicID(r.GetFileId()) {
			continue
		}
		row := s.pool.QueryRow(ctx, `
			SELECT `+media.FileColumns+`
			FROM external_users x
			JOIN external_accounts a ON a.id = x.account_id AND a.owner_id = $1
			JOIN users u ON u.id = x.user_id AND u.tenant_id = $3 AND `+liveUser+`
			JOIN files f ON f.id = x.bot_photo_file_id AND f.public_id = $4
			WHERE x.user_id = $2 AND x.is_bot`, viewer, bot, s.cfg.TenantID, r.GetFileId())
		f, err := media.ScanFile(row)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return fmt.Errorf("chat: authorize bot picture: %w", err)
		}
		out[i] = &media.Access{File: f, ChatID: media.BotDescriptionChat, Seq: bot}
	}
	return nil
}
