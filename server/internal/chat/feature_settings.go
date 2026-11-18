package chat

import (
	"context"
	"fmt"

	"app.local/server/internal/bridge/feature"
)

// FeatureDirection is the direction of feat for a chat whose messages go in
// direction messages (external_chats.direction): the one the owner set
// (override, nil when none), else the default for the feature. Messages always
// follow the direction of the chat. The bridge engine uses it too, so both sides
// read the same rule.
func FeatureDirection(feat feature.Feature, messages string, override *string) feature.Direction {
	m := feature.Direction(messages)
	if feat == feature.Messages {
		return m
	}
	if override != nil {
		return feature.Direction(*override)
	}
	return feature.Default(feat, m)
}

// FeatureState is the direction of one feature of a synced chat.
type FeatureState struct {
	Direction feature.Direction
	// Default is true when the owner never set it, so it follows the messages.
	Default bool
}

// ImportedFeatures lists the direction of every feature of a chat the bridge
// filled, as the owner set it or by default. An error when
// the chat is not linked to an account of owner.
func (s *Service) ImportedFeatures(ctx context.Context, owner, chatID int64) (map[feature.Feature]FeatureState, error) {
	var messages string
	var accountID int64
	var external string
	err := s.pool.QueryRow(ctx, `
		SELECT x.direction, x.account_id, x.external_chat_id FROM external_chats x JOIN external_accounts a ON a.id = x.account_id
		WHERE x.chat_id = $1 AND a.owner_id = $2`, chatID, owner).Scan(&messages, &accountID, &external)
	if isNoRows(err) {
		return nil, errNotFound("chat")
	}
	if err != nil {
		return nil, fmt.Errorf("chat: imported chat: %w", err)
	}
	rows, err := s.pool.Query(ctx, `SELECT feature, direction FROM external_chat_features WHERE account_id = $1 AND external_chat_id = $2`, accountID, external)
	if err != nil {
		return nil, fmt.Errorf("chat: chat features: %w", err)
	}
	defer rows.Close()
	set := map[feature.Feature]string{}
	for rows.Next() {
		var f, d string
		if err := rows.Scan(&f, &d); err != nil {
			return nil, fmt.Errorf("chat: chat features: %w", err)
		}
		set[feature.Feature(f)] = d
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: chat features: %w", err)
	}
	out := map[feature.Feature]FeatureState{}
	for _, f := range feature.All() {
		override, isSet := set[f]
		var o *string
		if isSet && f != feature.Messages {
			o = &override
		}
		out[f] = FeatureState{Direction: FeatureDirection(f, messages, o), Default: o == nil}
	}
	return out, nil
}

// SetImportedFeature sets the direction of a feature of a chat the bridge
// filled. Only the owner of the account may. Messages take only DirectionIn or
// DirectionBoth (what SetImportedDirection says). Turning a feature so that it no
// longer sends cancels what it has queued and not yet sent. Whether the other app
// supports the direction is for the caller to check (the bridge engine does).
func (s *Service) SetImportedFeature(ctx context.Context, owner, chatID int64, feat feature.Feature, dir feature.Direction) error {
	if !feature.Valid(feat) {
		return errInvalid("unknown feature %q", feat)
	}
	if !dir.Valid() {
		return errInvalid("direction must be off, in, out or both")
	}
	if feat == feature.Messages {
		if dir != feature.In && dir != feature.Both {
			return errInvalid("messages take only the directions %q or %q", DirectionIn, DirectionBoth)
		}
		return s.SetImportedDirection(ctx, owner, chatID, string(dir))
	}
	_, err := s.inTx(ctx, func(t *txn) error {
		var accountID int64
		var external string
		err := t.tx.QueryRow(ctx, `
			SELECT x.account_id, x.external_chat_id FROM external_chats x JOIN external_accounts a ON a.id = x.account_id
			WHERE x.chat_id = $1 AND a.owner_id = $2 FOR UPDATE OF x`, chatID, owner).Scan(&accountID, &external)
		if isNoRows(err) {
			return errNotFound("chat")
		}
		if err != nil {
			return fmt.Errorf("chat: imported chat: %w", err)
		}
		if _, err := t.tx.Exec(ctx, `
			INSERT INTO external_chat_features (account_id, external_chat_id, feature, direction) VALUES ($1, $2, $3, $4)
			ON CONFLICT (account_id, external_chat_id, feature) DO UPDATE SET direction = EXCLUDED.direction, updated_at = now()`,
			accountID, external, string(feat), string(dir)); err != nil {
			return fmt.Errorf("chat: set feature: %w", err)
		}
		if !dir.Sends() {
			if _, err := t.tx.Exec(ctx, `
				UPDATE external_outbox SET status = 'cancelled', updated_at = now()
				WHERE chat_id = $1 AND feature = $2 AND status IN ('pending', 'failed', 'unknown')`, chatID, string(feat)); err != nil {
				return fmt.Errorf("chat: cancel queued: %w", err)
			}
		}
		s.logger.Info("imported chat feature changed", "chat_id", chatID, "owner_id", owner, "feature", string(feat), "direction", string(dir))
		return nil
	})
	return err
}
