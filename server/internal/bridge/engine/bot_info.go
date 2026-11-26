package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"app.local/server/internal/bridge"
)

const (
	// botInfosPerLook is how many bots one look reads at most: each read is a call to the
	// other app, and the first look after connecting finds every bot met so far.
	botInfosPerLook = 3
	// botInfoMaxAge is how old what a bot says about itself may get before it is read again.
	botInfoMaxAge = 24 * time.Hour
	// botInfoLookBudget bounds the time one look spends, as peoplePhotosLookBudget does.
	botInfoLookBudget = 30 * time.Second
)

// storedBotInfo is external_users.bot_info: what the other app's bot said about itself.
type storedBotInfo struct {
	Username    string             `json:"username"`
	Description string             `json:"description"`
	About       string             `json:"about"`
	Commands    []storedBotCommand `json:"commands"`
	OpensApp    bool               `json:"opens_app"`
	// PhotoID names the picture whose copy bot_photo_file_id holds.
	PhotoID string `json:"photo_id"`
}

type storedBotCommand struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

// markBots records, for the people the app's conversation list names, whether each is a
// bot there. Puppets met before external_users.is_bot existed, and bots that never write,
// are corrected here; a person the account has no puppet for yet is left to the import.
func (r *runner) markBots(ctx context.Context, list []bridge.Conversation) error {
	var ids []string
	var flags []bool
	for _, c := range list {
		if c.Peer == nil || c.Peer.IsSelf {
			continue
		}
		ids, flags = append(ids, c.Peer.ID), append(flags, c.Peer.IsBot)
	}
	if len(ids) == 0 {
		return nil
	}
	if _, err := r.e.db.pool.Exec(ctx, `
		UPDATE external_users x SET is_bot = v.is_bot
		FROM unnest($2::text[], $3::boolean[]) AS v(id, is_bot)
		WHERE x.account_id = $1 AND x.external_user_id = v.id AND x.is_bot IS DISTINCT FROM v.is_bot`,
		r.account.ID, ids, flags); err != nil {
		return fmt.Errorf("bridge: mark bots: %w", err)
	}
	return nil
}

// botToRead is a bot puppet whose info is missing or old.
type botToRead struct {
	id          int64 // external_users.id
	participant string
	photoID     string // the picture already copied
}

// pollBotInfos reads what bots say about themselves (description, commands, picture), a few
// per look, and keeps it on their puppets. A read that fails is not tried again for a while.
func (r *runner) pollBotInfos(ctx context.Context) error {
	reader, ok := r.adapter.(bridge.BotInfoReader)
	if !ok {
		return nil
	}
	held := []int64{} // not nil: a NULL array would exclude every row
	now := time.Now()
	for id, until := range r.botInfoHeld {
		if now.After(until) {
			delete(r.botInfoHeld, id)
			continue
		}
		held = append(held, id)
	}
	rows, err := r.e.db.pool.Query(ctx, `
		SELECT x.id, x.external_user_id, coalesce(x.bot_info->>'photo_id', '')
		FROM external_users x JOIN users u ON u.id = x.user_id AND u.deleted_at IS NULL
		WHERE x.account_id = $1 AND x.is_bot AND (x.bot_info_at IS NULL OR x.bot_info_at < now() - make_interval(secs => $2))
			AND x.id <> ALL($3::bigint[])
		ORDER BY x.bot_info_at NULLS FIRST, x.id LIMIT $4`,
		r.account.ID, botInfoMaxAge.Seconds(), held, botInfosPerLook)
	if err != nil {
		return fmt.Errorf("bridge: bot infos: %w", err)
	}
	var todo []botToRead
	for rows.Next() {
		var b botToRead
		if err := rows.Scan(&b.id, &b.participant, &b.photoID); err != nil {
			rows.Close()
			return fmt.Errorf("bridge: bot infos: %w", err)
		}
		todo = append(todo, b)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("bridge: bot infos: %w", err)
	}
	deadline := time.Now().Add(botInfoLookBudget)
	for _, b := range todo {
		if time.Now().After(deadline) {
			return nil // the rest waits for the next look
		}
		if err := r.takeBotInfo(ctx, reader, b); err != nil {
			return err
		}
	}
	return nil
}

// takeBotInfo reads one bot's info and stores it. An error returned here is one the caller
// must act on (a stop, or a wait the other app asked for); any other failure holds the bot.
func (r *runner) takeBotInfo(ctx context.Context, reader bridge.BotInfoReader, b botToRead) error {
	hold := func(err error) error {
		if ctx.Err() != nil || isWait(err) {
			return err
		}
		r.logger.Warn("reading what a bot says about itself failed; it is tried again later", "external_user", b.id, "reason", err.Error())
		if r.botInfoHeld == nil {
			r.botInfoHeld = map[int64]time.Time{}
		}
		r.botInfoHeld[b.id] = time.Now().Add(refusedPause)
		return nil
	}
	info, ok, err := reader.BotInfo(ctx, r.acct, b.participant)
	if err != nil {
		return hold(err)
	}
	if !ok {
		// Not a bot after all (or not known to the account): look again after the usual time.
		_, err := r.e.db.pool.Exec(ctx, `UPDATE external_users SET bot_info_at = now() WHERE id = $1`, b.id)
		return err
	}
	stored := storedBotInfo{Username: info.Username, Description: info.Description, About: info.About, OpensApp: info.OpensApp}
	for _, c := range info.Commands {
		stored.Commands = append(stored.Commands, storedBotCommand{Command: c.Command, Description: c.Description})
	}
	// The picture is copied only when it changed; a failed copy leaves the old one in place
	// and is tried again at the next read.
	var fileID *int64
	keepPhoto := true
	switch {
	case info.PhotoID == "":
		keepPhoto = false
	case info.PhotoID == b.photoID:
		stored.PhotoID = b.photoID
	case r.e.mediaSvc != nil:
		file, err := r.copyPersonPhoto(ctx, info.PhotoRef)
		switch {
		case err == nil:
			fileID, keepPhoto, stored.PhotoID = &file.ID, false, info.PhotoID
		case ctx.Err() != nil || isWait(err):
			return err
		default:
			r.logger.Warn("copying a bot's picture failed; it is tried again later", "external_user", b.id, "reason", err.Error())
			stored.PhotoID = b.photoID
		}
	default:
		stored.PhotoID = b.photoID
	}
	body, err := json.Marshal(stored)
	if err != nil {
		return fmt.Errorf("bridge: bot info: %w", err)
	}
	// keepPhoto: leave bot_photo_file_id as it is; otherwise it becomes fileID (NULL for none).
	if _, err := r.e.db.pool.Exec(ctx, `
		UPDATE external_users SET bot_info = $2, bot_info_at = now(),
			bot_photo_file_id = CASE WHEN $3 THEN bot_photo_file_id ELSE $4 END
		WHERE id = $1`, b.id, body, keepPhoto, fileID); err != nil {
		return fmt.Errorf("bridge: store bot info: %w", err)
	}
	return nil
}
