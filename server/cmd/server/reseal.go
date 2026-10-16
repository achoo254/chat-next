package main

import (
	"context"
	"encoding/hex"
	"log/slog"

	"app.local/server/internal/auth"
	"app.local/server/internal/botupdates"
	"app.local/server/internal/config"
	"app.local/server/internal/sealbox"
	"app.local/server/internal/store"
)

// reseal seals every value the tenant stores with SESSION_KEY again under
// SESSION_KEY, opening it with SESSION_KEY or SESSION_KEY_PREVIOUS: the step
// of a key rotation after which SESSION_KEY_PREVIOUS can go
// (docs/operations/key-rotation.md). Running it again changes nothing.
func reseal(ctx context.Context, cfg config.Config, logger *slog.Logger) (unreadable int, err error) {
	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return 0, err
	}
	defer st.Close()
	log := logger.With("tenant", cfg.TenantID, "key_id", hex.EncodeToString(sealbox.KeyID(cfg.SessionKey)))
	if cfg.SessionKeyPrevious != nil {
		log = log.With("previous_key_id", hex.EncodeToString(sealbox.KeyID(cfg.SessionKeyPrevious)))
	}
	for _, part := range []struct {
		name string
		run  func() (sealbox.Count, error)
	}{
		{"session IdP tokens", func() (sealbox.Count, error) {
			return auth.ResealSessions(ctx, st, cfg.TenantID, cfg.SessionKey, cfg.SessionKeyPrevious)
		}},
		{"bot webhook secrets", func() (sealbox.Count, error) {
			return botupdates.ResealWebhookSecrets(ctx, st.Pool(), cfg.TenantID, cfg.SessionKey, cfg.SessionKeyPrevious)
		}},
	} {
		n, err := part.run()
		if err != nil {
			return unreadable, err
		}
		log.Info("resealed "+part.name, "resealed", n.Resealed, "current", n.Current, "unreadable", n.Unreadable)
		unreadable += n.Unreadable
	}
	return unreadable, nil
}
