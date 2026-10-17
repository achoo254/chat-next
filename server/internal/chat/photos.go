package chat

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ownPhoto returns the id of the photo fileID that me uploaded, nil for ""
// (no photo).
func ownPhoto(ctx context.Context, q querier, tenant string, me int64, fileID string) (*int64, error) {
	if fileID == "" {
		return nil, nil
	}
	var id int64
	err := q.QueryRow(ctx, `SELECT id FROM files WHERE public_id = $1 AND tenant_id = $2 AND owner_id = $3 AND kind = 'photo'`,
		fileID, tenant, me).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errInvalid("photo_file_id: not a photo you uploaded")
	}
	if err != nil {
		return nil, fmt.Errorf("chat: photo: %w", err)
	}
	return &id, nil
}

// SetProfilePhoto makes fileID, a photo me uploaded, me's profile photo; ""
// removes it.
func (s *Service) SetProfilePhoto(ctx context.Context, me int64, fileID string) error {
	photo, err := ownPhoto(ctx, s.pool, s.cfg.TenantID, me, fileID)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET photo_file_id = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
		me, s.cfg.TenantID, photo); err != nil {
		return fmt.Errorf("chat: set profile photo: %w", err)
	}
	return nil
}

// photoPair is a person's profile photo (owner) as one viewer would see it.
type photoPair struct{ owner, viewer int64 }

// photoSeen returns which of pairs the owner's privacy lets the viewer see
// the photo of: the "who sees my profile photo" audience (everyone by
// default, contacts: people in the owner's contact list), never someone the
// owner blocked.
func photoSeen(ctx context.Context, q querier, pairs []photoPair) (map[photoPair]bool, error) {
	out := map[photoPair]bool{}
	if len(pairs) == 0 {
		return out, nil
	}
	owners := make([]int64, len(pairs))
	viewers := make([]int64, len(pairs))
	for i, p := range pairs {
		owners[i], viewers[i] = p.owner, p.viewer
	}
	rows, err := q.Query(ctx, `
		SELECT x.owner, x.viewer
		FROM unnest($1::bigint[], $2::bigint[]) AS x(owner, viewer)
		LEFT JOIN privacy_settings ps ON ps.user_id = x.owner
		WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = x.owner AND b.blocked_id = x.viewer)
			AND (coalesce(ps.profile_photo, $3) = $4
				OR (ps.profile_photo = $5 AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.owner_id = x.owner AND ct.contact_id = x.viewer)))`,
		owners, viewers, defaultPrivacy().ProfilePhoto, audEveryone, audContacts)
	if err != nil {
		return nil, fmt.Errorf("chat: photo privacy: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p photoPair
		if err := rows.Scan(&p.owner, &p.viewer); err != nil {
			return nil, fmt.Errorf("chat: photo privacy: %w", err)
		}
		out[p] = true
	}
	return out, rows.Err()
}
