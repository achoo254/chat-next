package media

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

// Lifecycle timing. Everything runs in the app: the storage identity may
// not configure bucket lifecycle rules.
const (
	sweepInterval = 10 * time.Minute
	// unreferencedGrace keeps a file nothing references for a day: an
	// upload is usually sent within seconds, and a recall may be undone by
	// a forward made just before.
	unreferencedGrace = 24 * time.Hour
	gcBatch           = 200
	// previewPhotoRetry is how long a failed og:image fetch is not retried;
	// previewPhotoTTL how long a stored one is reused.
	previewPhotoRetry = time.Hour
	previewPhotoTTL   = 7 * 24 * time.Hour
	// previewImageMax bounds an og:image download.
	previewImageMax = 5 << 20
)

// RunLifecycle aborts expired uploads and collects unreferenced files every
// ten minutes until ctx ends.
func (s *Service) RunLifecycle(ctx context.Context) {
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.Sweep(ctx)
		}
	}
}

// Sweep runs the lifecycle jobs once.
func (s *Service) Sweep(ctx context.Context) {
	if n, err := s.AbortExpiredUploads(ctx); err != nil {
		s.logger.Error("expired upload cleanup failed", "err", err)
	} else if n > 0 {
		s.logger.Info("expired uploads aborted", "uploads", n)
	}
	if n, err := s.CollectFiles(ctx); err != nil {
		s.logger.Error("unreferenced file collection failed", "err", err)
	} else if n > 0 {
		s.logger.Info("unreferenced files deleted", "files", n)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM link_preview_photos WHERE fetched_at < now() - $1::interval`, previewPhotoTTL); err != nil {
		s.logger.Error("link preview photo cleanup failed", "err", err)
	}
	if c, ok := s.objects.(interface{ CleanTemp(time.Duration) }); ok {
		c.CleanTemp(uploadTTL)
	}
	if free, low, err := s.diskLow(0); err != nil {
		s.logger.Error("media disk space unknown", "err", err)
	} else if low {
		s.logger.Error("media disk almost full; uploads refused until space is freed",
			"free_bytes", free, "min_free_bytes", s.cfg.MinFreeBytes)
	}
}

// AbortExpiredUploads aborts uploads unfinished after 24 hours (their
// staging data goes) and forgets completed ones after the same time.
func (s *Service) AbortExpiredUploads(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+uploadColumns+` FROM uploads
		WHERE (completed_at IS NULL AND expires_at < now() AND (completing_until IS NULL OR completing_until < now()))
			OR completed_at < now() - $1::interval
		ORDER BY expires_at LIMIT $2`, uploadTTL, gcBatch)
	if err != nil {
		return 0, fmt.Errorf("media: expired uploads: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*uploadRow, error) { return scanUpload(r) })
	if err != nil {
		return 0, fmt.Errorf("media: expired uploads: %w", err)
	}
	done := 0
	for _, u := range list {
		if !u.Completed {
			if err := s.objects.AbortMultipart(ctx, u.StagingKey, u.S3UploadID); err != nil && !errors.Is(err, ErrNotFound) {
				s.logger.Warn("aborting an expired upload failed", "err", err)
				continue
			}
			if err := s.objects.Delete(ctx, u.StagingKey); err != nil {
				s.logger.Warn("deleting an expired staging object failed", "err", err)
				continue
			}
		}
		if _, err := s.pool.Exec(ctx, `DELETE FROM uploads WHERE id = $1`, u.ID); err != nil {
			return done, fmt.Errorf("media: delete upload: %w", err)
		}
		done++
	}
	return done, nil
}

// CollectFiles deletes files older than the grace period that no message,
// no link preview and no profile or chat photo references. The row goes first, in a statement that
// skips rows locked by a send (LockFile) and re-checks the references; its
// objects are deleted after.
func (s *Service) CollectFiles(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx, `
		WITH doomed AS (
			SELECT f.id FROM files f
			WHERE f.tenant_id = $1 AND f.created_at < now() - $2::interval
				AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = f.id)
				AND NOT EXISTS (SELECT 1 FROM link_preview_photos p WHERE p.file_id = f.id)
				AND NOT EXISTS (SELECT 1 FROM users u WHERE u.photo_file_id = f.id)
				AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.photo_file_id = f.id)
			ORDER BY f.id LIMIT $3
			FOR UPDATE SKIP LOCKED)
		DELETE FROM files f USING doomed d
		WHERE f.id = d.id
			AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = f.id)
			AND NOT EXISTS (SELECT 1 FROM link_preview_photos p WHERE p.file_id = f.id)
			AND NOT EXISTS (SELECT 1 FROM users u WHERE u.photo_file_id = f.id)
			AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.photo_file_id = f.id)
		RETURNING f.object_key, f.sizes::text`, s.cfg.TenantID, unreferencedGrace, gcBatch)
	if err != nil {
		return 0, fmt.Errorf("media: collect files: %w", err)
	}
	type gone struct {
		key   string
		sizes string
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (gone, error) {
		var g gone
		err := r.Scan(&g.key, &g.sizes)
		return g, err
	})
	if err != nil {
		return 0, fmt.Errorf("media: collect files: %w", err)
	}
	for _, g := range list {
		f := &File{Key: g.key}
		if err := json.Unmarshal([]byte(g.sizes), &f.Sizes); err != nil {
			s.logger.Warn("collected file has unreadable sizes; renditions stay", "key", g.key, "err", err)
		}
		s.deleteObjects(ctx, f.keys())
	}
	return len(list), nil
}

// ImageFetcher downloads an image URL through the SSRF guard.
type ImageFetcher func(ctx context.Context, url string, maxBytes int64) ([]byte, error)

// CachedPreviewPhoto returns the stored photo of an og:image without
// fetching; known is false when the image was never tried or a failure is
// old enough to retry.
func (s *Service) CachedPreviewPhoto(ctx context.Context, imageURL string) (f *File, known bool, err error) {
	var fileID *int64
	var fetchedAt time.Time
	err = s.pool.QueryRow(ctx, `SELECT file_id, fetched_at FROM link_preview_photos WHERE tenant_id = $1 AND image_url = $2`,
		s.cfg.TenantID, imageURL).Scan(&fileID, &fetchedAt)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, false, nil
	case err != nil:
		return nil, false, fmt.Errorf("media: preview photo cache: %w", err)
	case fileID == nil:
		return nil, time.Since(fetchedAt) < previewPhotoRetry, nil
	}
	f, err = ScanFile(s.pool.QueryRow(ctx, `SELECT `+FileColumns+` FROM files f WHERE f.id = $1`, *fileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("media: load preview photo: %w", err)
	}
	return f, true, nil
}

// PreviewPhoto returns the stored photo of a page's og:image for this
// tenant, fetching and storing it on a miss; nil when the image cannot be
// fetched or used (not retried for an hour).
func (s *Service) PreviewPhoto(ctx context.Context, imageURL string, fetch ImageFetcher) (*File, error) {
	if f, known, err := s.CachedPreviewPhoto(ctx, imageURL); err != nil || known {
		return f, err
	}
	var stored *File
	data, ferr := fetch(ctx, imageURL, previewImageMax)
	if ferr == nil {
		stored, ferr = s.storeServerImage(ctx, data)
	}
	if ferr != nil {
		s.logger.Debug("link preview photo unavailable", "err", ferr)
	}
	var id *int64
	if stored != nil {
		id = &stored.ID
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO link_preview_photos (tenant_id, image_url, file_id, fetched_at) VALUES ($1, $2, $3, now())
		ON CONFLICT (tenant_id, image_url) DO UPDATE SET file_id = excluded.file_id, fetched_at = excluded.fetched_at`,
		s.cfg.TenantID, imageURL, id); err != nil {
		return nil, fmt.Errorf("media: preview photo cache: %w", err)
	}
	return stored, nil
}

// storeServerImage stores a fetched image as a server-owned photo (owner
// 0), stripped, with S and M renditions; the same bytes are stored once
// per tenant.
func (s *Service) storeServerImage(ctx context.Context, data []byte) (*File, error) {
	sum := sha256.Sum256(data)
	source := hex.EncodeToString(sum[:])
	if existing, err := ScanFile(s.pool.QueryRow(ctx, `SELECT `+FileColumns+` FROM files f
		WHERE f.tenant_id = $1 AND f.owner_id = 0 AND f.source_hash = $2 LIMIT 1`, s.cfg.TenantID, source)); err == nil {
		return existing, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("media: dedupe preview photo: %w", err)
	}
	mime := Sniff(data)
	if !isRasterImage(mime) {
		return nil, fmt.Errorf("media: og:image is %s, not a raster image", mime)
	}
	stripped, orientation, err := stripImage(mime, data)
	if err != nil {
		return nil, err
	}
	img, err := s.decode.decode(ctx, mime, stripped)
	if err != nil {
		return nil, err
	}
	d, err := derive(img, orientation, appv1.MediaSizeType_MEDIA_SIZE_TYPE_M)
	if err != nil {
		return nil, err
	}
	f := &File{PublicID: newPublicID(), TenantID: s.cfg.TenantID, OwnerID: 0, Kind: appv1.MediaKind_MEDIA_KIND_PHOTO,
		MIME: mime, Width: int32(d.width), Height: int32(d.height), InlineThumb: d.inlineThumb, Key: "f/" + newUUID()}
	for _, r := range d.renditions {
		key := f.Key + sizeSuffix[r.typ]
		if err := s.objects.Put(ctx, key, r.data, mimeJPEG); err != nil {
			s.deleteObjects(context.WithoutCancel(ctx), f.keys())
			return nil, err
		}
		f.Sizes = append(f.Sizes, Rendition{Type: r.typ, Width: int32(r.w), Height: int32(r.h), Size: int64(len(r.data)), Key: key})
	}
	if err := s.store(ctx, f, stripped); err != nil {
		s.deleteObjects(context.WithoutCancel(ctx), f.keys())
		return nil, err
	}
	if err := insertFile(ctx, s.pool, f, source); err != nil {
		s.deleteObjects(context.WithoutCancel(ctx), f.keys())
		return nil, err
	}
	return f, nil
}
