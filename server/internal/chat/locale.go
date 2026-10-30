package chat

import (
	"context"
	"fmt"

	"app.local/server/internal/locale"
)

// SetUserLocale records the language me's app shows (locale.Valid), which
// the assistant bot writes to them in. The web app sends it at every start,
// so writing the same value again is a no-op. updated_at is left alone: it
// tracks the profile others see, and the locale is private.
func (s *Service) SetUserLocale(ctx context.Context, me int64, lang string) error {
	if !locale.Valid(lang) {
		return errInvalid("locale must be vi, en or zh-CN")
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE users SET locale = $3
		WHERE tenant_id = $1 AND id = $2 AND locale IS DISTINCT FROM $3`,
		s.cfg.TenantID, me, lang); err != nil {
		return fmt.Errorf("chat: set locale: %w", err)
	}
	return nil
}

// UserLocale returns the language userID's app last reported, or
// locale.Default for a user who never reported one or is unknown.
func (s *Service) UserLocale(ctx context.Context, userID int64) (string, error) {
	var lang string
	err := s.pool.QueryRow(ctx, `SELECT locale FROM users WHERE tenant_id = $1 AND id = $2`, s.cfg.TenantID, userID).Scan(&lang)
	switch {
	case isNoRows(err):
		return locale.Default, nil
	case err != nil:
		return "", fmt.Errorf("chat: user locale: %w", err)
	case !locale.Valid(lang):
		return locale.Default, nil
	}
	return lang, nil
}

// attachLocales sets the Locales of updates with one query for the people
// among their users, so a bot can answer in the sender's language.
func (s *Service) attachLocales(ctx context.Context, updates []BotUpdate) error {
	var ids []int64
	for _, u := range updates {
		for _, user := range u.Users {
			if !user.GetIsBot() && !user.GetDeleted() {
				ids = append(ids, user.GetId())
			}
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.pool.Query(ctx, `SELECT id, locale FROM users WHERE tenant_id = $1 AND id = ANY($2)`,
		s.cfg.TenantID, uniqueSorted(ids))
	if err != nil {
		return fmt.Errorf("chat: user locales: %w", err)
	}
	defer rows.Close()
	locales := map[int64]string{}
	for rows.Next() {
		var id int64
		var lang string
		if err := rows.Scan(&id, &lang); err != nil {
			return fmt.Errorf("chat: user locales: %w", err)
		}
		if locale.Valid(lang) {
			locales[id] = lang
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("chat: user locales: %w", err)
	}
	for i := range updates {
		updates[i].Locales = locales
	}
	return nil
}
