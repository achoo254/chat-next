package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/media"
)

// peoplePhotosPerLook is how many profile photos one look copies at most: the first
// look after connecting finds every person met so far, and copying them all at once
// would spend the other app's rate limit that messages need.
const peoplePhotosPerLook = 10

// photoWantOf is what external_users.photo_want records for a participant: nil when the
// adapter did not read the photo.
func photoWantOf(p bridge.Participant) *string {
	if !p.PhotoKnown {
		return nil
	}
	return &p.PhotoID
}

// wantPhoto records the photo the other app now shows for a person; the runner copies it.
func (d *db) wantPhoto(ctx context.Context, accountID int64, p bridge.Participant) error {
	if _, err := d.pool.Exec(ctx, `
		UPDATE external_users SET photo_want = $3, photo_ref = $4 WHERE account_id = $1 AND external_user_id = $2`,
		accountID, p.ID, p.PhotoID, p.PhotoRef); err != nil {
		return fmt.Errorf("bridge: record wanted photo: %w", err)
	}
	return nil
}

// peoplePhotosLookBudget bounds the time one look spends copying photos: the look runs in
// the runner's only loop, so live events and sends from Chat wait while it copies.
const peoplePhotosLookBudget = 30 * time.Second

// personPhoto is a person whose puppet does not have the photo the other app shows.
type personPhoto struct {
	id     int64 // external_users.id
	userID int64
	want   string
	ref    string
}

// heldPhoto is a photo whose copy failed: it is not tried again until then. A new photo
// of the same person is not held.
type heldPhoto struct {
	want  string
	until time.Time
}

// heldPhotos lists the photos still held after a failed copy, as the ids and wanted
// photos the query leaves out; held photos past their time are forgotten.
func (r *runner) heldPhotos() (ids []int64, wants []string) {
	now := time.Now()
	for id, h := range r.photoHeld {
		if now.After(h.until) {
			delete(r.photoHeld, id)
			continue
		}
		ids, wants = append(ids, id), append(wants, h.want)
	}
	return ids, wants
}

// pollPeoplePhotos gives puppets the profile photo the other app shows for their person,
// a few per look. A copy that fails is not tried again for a while; the person keeps the
// photo they had.
func (r *runner) pollPeoplePhotos(ctx context.Context) error {
	if r.e.mediaSvc == nil {
		return nil
	}
	heldIDs, heldWants := r.heldPhotos()
	rows, err := r.e.db.pool.Query(ctx, `
		SELECT x.id, x.user_id, x.photo_want, coalesce(x.photo_ref, '')
		FROM external_users x JOIN users u ON u.id = x.user_id AND u.deleted_at IS NULL
		WHERE x.account_id = $1 AND x.photo_want IS NOT NULL AND x.photo_want IS DISTINCT FROM x.photo_id
			AND (x.id, x.photo_want) NOT IN (SELECT * FROM unnest($3::bigint[], $4::text[]))
		ORDER BY x.id LIMIT $2`, r.account.ID, peoplePhotosPerLook, heldIDs, heldWants)
	if err != nil {
		return fmt.Errorf("bridge: people photos: %w", err)
	}
	var todo []personPhoto
	for rows.Next() {
		var p personPhoto
		if err := rows.Scan(&p.id, &p.userID, &p.want, &p.ref); err != nil {
			rows.Close()
			return fmt.Errorf("bridge: people photos: %w", err)
		}
		todo = append(todo, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("bridge: people photos: %w", err)
	}
	deadline := time.Now().Add(peoplePhotosLookBudget)
	for _, p := range todo {
		if time.Now().After(deadline) {
			return nil // the rest waits for the next look
		}
		if err := r.takePersonPhoto(ctx, p); err != nil {
			return err
		}
	}
	return nil
}

// takePersonPhoto copies one person's photo (none removes it) and records which it is.
func (r *runner) takePersonPhoto(ctx context.Context, p personPhoto) error {
	var fileID *int64
	if p.want != "" {
		file, err := r.copyPersonPhoto(ctx, p.ref)
		if err != nil {
			if ctx.Err() != nil || isWait(err) {
				return err // a wait the other app asked for holds the periodic reads (skipBusy)
			}
			r.logger.Warn("copying a profile photo failed; it is tried again later", "user_id", p.userID, "reason", err.Error())
			if r.photoHeld == nil {
				r.photoHeld = map[int64]heldPhoto{}
			}
			r.photoHeld[p.id] = heldPhoto{want: p.want, until: time.Now().Add(refusedPause)}
			return nil
		}
		fileID = &file.ID
	}
	if _, err := r.e.db.pool.Exec(ctx, `
		WITH x AS (UPDATE external_users SET photo_id = $3 WHERE id = $1)
		UPDATE users SET photo_file_id = $4, updated_at = now() WHERE id = $2 AND deleted_at IS NULL`,
		p.id, p.userID, p.want, fileID); err != nil {
		return fmt.Errorf("bridge: set puppet photo: %w", err)
	}
	return nil
}

// copyPersonPhoto stores the bytes behind a photo ref in the owner's media. An adapter
// may stream the download, so a wait the other app asks for can come only while the
// bytes are read; it is given back as the wait, not as a failed upload.
func (r *runner) copyPersonPhoto(ctx context.Context, ref string) (*media.File, error) {
	if ref == "" {
		return nil, fmt.Errorf("bridge: the photo has no ref")
	}
	stream, err := retryRateLimit(ctx, func() (bridge.MediaStream, error) { return r.adapter.FetchMedia(ctx, r.acct, ref) })
	if err != nil {
		return nil, err
	}
	defer func() { _ = stream.Close() }()
	body, unwatch := watched(ctx, stream)
	defer unwatch()
	read := &firstReadError{r: body}
	file, err := r.uploadPaced(ctx, media.StreamUpload{Kind: appv1.MediaKind_MEDIA_KIND_PHOTO, FileName: "photo.jpg",
		Body: io.LimitReader(read, photoLimit+1), MaxBytes: photoLimit})
	if err != nil && isWait(read.err) {
		return nil, read.err
	}
	return file, err
}

// firstReadError keeps the first error a read gave other than io.EOF.
type firstReadError struct {
	r   io.Reader
	err error
}

func (f *firstReadError) Read(p []byte) (int, error) {
	n, err := f.r.Read(p)
	if err != nil && !errors.Is(err, io.EOF) && f.err == nil {
		f.err = err
	}
	return n, err
}
