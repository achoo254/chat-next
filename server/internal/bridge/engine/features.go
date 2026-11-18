package engine

import (
	"context"
	"errors"
	"fmt"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/chat"
	"github.com/jackc/pgx/v5"
)

// ErrFeatureUnsupported is returned when a feature or direction is not one the
// app of the account can do.
var ErrFeatureUnsupported = errors.New("bridge: this app cannot do that")

// featureDirection reads the direction of a feature of a synced chat now: what the
// owner set, else the default that follows the messages of the chat.
func (d *db) featureDirection(ctx context.Context, accountID int64, externalChat string, feat feature.Feature) (feature.Direction, error) {
	var messages string
	var override *string
	err := d.pool.QueryRow(ctx, `
		SELECT x.direction, f.direction FROM external_chats x
		LEFT JOIN external_chat_features f ON f.account_id = x.account_id AND f.external_chat_id = x.external_chat_id AND f.feature = $3
		WHERE x.account_id = $1 AND x.external_chat_id = $2`, accountID, externalChat, string(feat)).Scan(&messages, &override)
	if errors.Is(err, pgx.ErrNoRows) {
		return feature.Off, nil
	}
	if err != nil {
		return feature.Off, fmt.Errorf("bridge: feature direction: %w", err)
	}
	return chat.FeatureDirection(feat, messages, override), nil
}

// FeatureView is one feature of a synced chat as the owner sees it: how it is
// set, and what the app can do for it.
type FeatureView struct {
	Feature   feature.Feature
	Risk      feature.Risk
	Direction feature.Direction
	// Default is true when the owner never set the feature, so it follows the messages.
	Default   bool
	Supported feature.Support
}

// Features lists, for a synced chat of the account of owner, every feature the
// app supports with its direction. A feature the app does not know is not listed.
func (e *Engine) Features(ctx context.Context, owner, accountID int64, conversationID string) ([]FeatureView, error) {
	a, err := e.ownedAccount(ctx, owner, accountID)
	if err != nil {
		return nil, err
	}
	l, err := e.db.link(ctx, accountID, conversationID)
	if err != nil {
		return nil, err
	}
	if l == nil {
		return nil, ErrNotFound
	}
	adapter := e.adapters[a.Source]
	if adapter == nil {
		return nil, ErrNotFound
	}
	state, err := e.chat.ImportedFeatures(ctx, owner, l.ChatID)
	if err != nil {
		return nil, err
	}
	support := bridge.FeaturesOf(adapter)
	var out []FeatureView
	for _, f := range feature.All() {
		s, ok := support[f]
		if !ok || (!s.In && !s.Out) {
			continue
		}
		out = append(out, FeatureView{Feature: f, Risk: feature.RiskOf(f), Direction: state[f].Direction, Default: state[f].Default, Supported: s})
	}
	return out, nil
}

// SetFeature sets the direction of a feature of a synced chat of the account of
// owner. ErrFeatureUnsupported when the app cannot do the direction; a messages
// direction of 'both' also needs an app that can be written to (ErrSendUnsupported)
// and a connected account.
func (e *Engine) SetFeature(ctx context.Context, owner, accountID int64, conversationID string, feat feature.Feature, dir feature.Direction) error {
	a, err := e.ownedAccount(ctx, owner, accountID)
	if err != nil {
		return err
	}
	l, err := e.db.link(ctx, accountID, conversationID)
	if err != nil {
		return err
	}
	if l == nil {
		return ErrNotFound
	}
	if !feature.Valid(feat) || !dir.Valid() {
		return fmt.Errorf("%w: unknown feature or direction", ErrFeatureUnsupported)
	}
	adapter := e.adapters[a.Source]
	if adapter == nil {
		return ErrNotFound
	}
	if feat == feature.Messages {
		return e.SetDirection(ctx, owner, accountID, conversationID, string(dir))
	}
	if !bridge.FeaturesOf(adapter)[feat].Allows(dir) {
		return ErrFeatureUnsupported
	}
	if dir.Sends() && a.Status == "stopped" {
		return ErrSendUnsupported
	}
	return e.chat.SetImportedFeature(ctx, owner, l.ChatID, feat, dir)
}
