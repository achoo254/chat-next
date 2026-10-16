package store

import (
	"context"
	"fmt"
)

// SealedSession is a session's stored IdP tokens (sealbox values; nil when
// absent), as the key rotation reseal reads and replaces them.
type SealedSession struct {
	ID              int64
	TokenHash       []byte
	RefreshTokenEnc []byte
	IDTokenEnc      []byte
}

// SealedSessions returns up to limit sessions of tenant with a stored IdP
// token and an id above afterID, by id.
func (s *Store) SealedSessions(ctx context.Context, tenantID string, afterID int64, limit int) ([]SealedSession, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, token_hash, refresh_token_enc, id_token_enc FROM user_sessions
		WHERE tenant_id = $1 AND id > $2 AND (refresh_token_enc IS NOT NULL OR id_token_enc IS NOT NULL)
		ORDER BY id LIMIT $3`, tenantID, afterID, limit)
	if err != nil {
		return nil, fmt.Errorf("store: sealed sessions: %w", err)
	}
	defer rows.Close()
	var out []SealedSession
	for rows.Next() {
		var r SealedSession
		if err := rows.Scan(&r.ID, &r.TokenHash, &r.RefreshTokenEnc, &r.IDTokenEnc); err != nil {
			return nil, fmt.Errorf("store: sealed sessions: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: sealed sessions: %w", err)
	}
	return out, nil
}

// ReplaceSealedTokens stores next's tokens when the session still holds
// old's: a grant check or a logout that changed them in between wins. It
// reports whether the row was updated.
func (s *Store) ReplaceSealedTokens(ctx context.Context, old, next SealedSession) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE user_sessions SET refresh_token_enc = $4, id_token_enc = $5
		WHERE id = $1 AND refresh_token_enc IS NOT DISTINCT FROM $2 AND id_token_enc IS NOT DISTINCT FROM $3`,
		old.ID, old.RefreshTokenEnc, old.IDTokenEnc, next.RefreshTokenEnc, next.IDTokenEnc)
	if err != nil {
		return false, fmt.Errorf("store: replace sealed tokens: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}
