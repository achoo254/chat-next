package engine

import (
	"context"
	"fmt"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
)

// FeatureDefault is what a new synced chat of an account starts with for one feature.
type FeatureDefault struct {
	Feature   feature.Feature
	Risk      feature.Risk
	Direction feature.Direction
	// Set is true when the owner chose it; otherwise Direction is the built-in default.
	Set       bool
	Supported feature.Support
}

// defaultable is whether the owner may choose the default of a feature: messages are chosen
// when a chat is synced, and acting on people and groups is switched on chat by chat.
func defaultable(f feature.Feature) bool {
	return f != feature.Messages && feature.RiskOf(f) != feature.R3
}

// FeatureDefaults lists the features the app of the account supports that have a default.
func (e *Engine) FeatureDefaults(ctx context.Context, owner, accountID int64) ([]FeatureDefault, error) {
	a, err := e.ownedAccount(ctx, owner, accountID)
	if err != nil {
		return nil, err
	}
	adapter := e.adapters[a.Source]
	if adapter == nil {
		return nil, ErrNotFound
	}
	rows, err := e.db.pool.Query(ctx, `SELECT feature, direction FROM external_feature_defaults WHERE account_id = $1`, accountID)
	if err != nil {
		return nil, fmt.Errorf("bridge: feature defaults: %w", err)
	}
	defer rows.Close()
	chosen := map[feature.Feature]feature.Direction{}
	for rows.Next() {
		var f, d string
		if err := rows.Scan(&f, &d); err != nil {
			return nil, fmt.Errorf("bridge: feature defaults: %w", err)
		}
		chosen[feature.Feature(f)] = feature.Direction(d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("bridge: feature defaults: %w", err)
	}
	support := bridge.FeaturesOf(adapter)
	var out []FeatureDefault
	for _, f := range feature.All() {
		s, ok := support[f]
		if !ok || (!s.In && !s.Out) || !defaultable(f) {
			continue
		}
		d, set := chosen[f]
		if !set {
			d = feature.Default(f, feature.In)
		}
		out = append(out, FeatureDefault{Feature: f, Risk: feature.RiskOf(f), Direction: d, Set: set, Supported: s})
	}
	return out, nil
}

// SetFeatureDefault sets what new synced chats of the account start with for a feature. With
// applyAll it is also written to every chat already synced, and the number of chats written
// is returned. A default that sends needs a connected account.
func (e *Engine) SetFeatureDefault(ctx context.Context, owner, accountID int64, feat feature.Feature, dir feature.Direction, applyAll bool) (int, error) {
	a, err := e.ownedAccount(ctx, owner, accountID)
	if err != nil {
		return 0, err
	}
	adapter := e.adapters[a.Source]
	if adapter == nil {
		return 0, ErrNotFound
	}
	if !feature.Valid(feat) || !dir.Valid() || !defaultable(feat) {
		return 0, ErrFeatureUnsupported
	}
	if !bridge.FeaturesOf(adapter)[feat].Allows(dir) {
		return 0, ErrFeatureUnsupported
	}
	if dir.Sends() && a.Status == "stopped" {
		return 0, ErrSendUnsupported
	}
	tx, err := e.db.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("bridge: set feature default: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO external_feature_defaults (account_id, feature, direction) VALUES ($1, $2, $3)
		ON CONFLICT (account_id, feature) DO UPDATE SET direction = EXCLUDED.direction, updated_at = now()`,
		accountID, string(feat), string(dir)); err != nil {
		return 0, fmt.Errorf("bridge: set feature default: %w", err)
	}
	applied := 0
	if applyAll {
		tag, err := tx.Exec(ctx, `
			INSERT INTO external_chat_features (account_id, external_chat_id, feature, direction)
			SELECT account_id, external_chat_id, $2, $3 FROM external_chats WHERE account_id = $1
			ON CONFLICT (account_id, external_chat_id, feature) DO UPDATE SET direction = EXCLUDED.direction, updated_at = now()`,
			accountID, string(feat), string(dir))
		if err != nil {
			return 0, fmt.Errorf("bridge: apply feature default: %w", err)
		}
		applied = int(tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("bridge: set feature default: %w", err)
	}
	return applied, nil
}
