package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

// StreamUpload is a file sent through the server in one request (the Bot
// API's multipart sends) instead of the browser's resumable upload.
type StreamUpload struct {
	Kind     appv1.MediaKind
	FileName string
	// Body is read to its end.
	Body io.Reader
	// MaxBytes bounds the file below the server's limits (0: no extra
	// bound).
	MaxBytes int64
}

// unknownHash stands in for the hash of a streamed upload until its bytes
// are read.
var unknownHash = strings.Repeat("0", 64)

// UploadStream stores a file sent in one request with the checks of
// CreateUpload and CompleteUpload: the owner's upload rate and storage
// quota, the size limits (photos at most PhotoMaxBytes), the content
// matching the kind, metadata stripping and renditions. An upload row
// exists while the bytes arrive, so an unfinished upload is cleaned up like
// any other; the quota is checked again with the real size before the file
// is stored. A file of the owner with the same content is returned instead
// of a second copy.
func (s *Service) UploadStream(ctx context.Context, me int64, in StreamUpload) (*File, error) {
	if err := s.allow(limitUpload, "upload", me); err != nil {
		return nil, err
	}
	if _, ok := kindNames[in.Kind]; !ok {
		return nil, errInvalid("kind is required")
	}
	limit := s.cfg.UploadMaxBytes
	if in.MaxBytes > 0 {
		limit = min(limit, in.MaxBytes)
	}
	if in.Kind == appv1.MediaKind_MEDIA_KIND_PHOTO {
		limit = min(limit, PhotoMaxBytes)
	}
	if err := s.checkDisk(limit); err != nil {
		return nil, err
	}
	staging := "staging/" + strings.ReplaceAll(newPublicID(), "-", "x")
	s3ID, err := s.objects.CreateMultipart(ctx, staging)
	if err != nil {
		return nil, errUnavailable(err)
	}
	u := &uploadRow{
		ID: newPublicID(), TenantID: s.cfg.TenantID, OwnerID: me, S3UploadID: s3ID, StagingKey: staging, Kind: in.Kind,
		FileName: cleanFileName(in.FileName), Size: 1, PartSize: minPartSize, Hash: unknownHash,
		ExpiresAt: s.now().Add(uploadTTL),
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`, "media-quota:"+s.cfg.TenantID, me); err != nil {
			return fmt.Errorf("media: quota lock: %w", err)
		}
		if err := s.checkQuota(ctx, tx, me, 1); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO uploads (id, tenant_id, owner_id, s3_upload_id, staging_key, kind, file_name, mime_type, size, part_size,
				file_hash, expires_at, completing_until)
			VALUES ($1, $2, $3, $4, $5, $6, $7, '', $8, $9, $10, $11, now() + $12::interval)`,
			u.ID, u.TenantID, u.OwnerID, u.S3UploadID, u.StagingKey, kindNames[u.Kind], u.FileName, u.Size, u.PartSize,
			u.Hash, u.ExpiresAt, completeLease)
		if err != nil {
			return fmt.Errorf("media: insert upload: %w", err)
		}
		return nil
	})
	if err != nil {
		if abortErr := s.objects.AbortMultipart(context.WithoutCancel(ctx), staging, s3ID); abortErr != nil {
			s.logger.Warn("aborting a refused upload failed", "err", abortErr)
		}
		return nil, err
	}
	f, err := s.streamParts(ctx, u, in.Body, limit)
	if err != nil {
		s.discardUpload(context.WithoutCancel(ctx), u)
		var refused *contentError
		if errors.As(err, &refused) {
			return nil, errInvalid("%s", refused.reason)
		}
		return nil, err
	}
	return f, nil
}

// streamParts copies body into the staging upload part by part, then
// finishes the upload into a file (or returns the owner's identical file).
func (s *Service) streamParts(ctx context.Context, u *uploadRow, body io.Reader, limit int64) (*File, error) {
	buf := make([]byte, minPartSize)
	hash := sha256.New()
	var parts []Part
	var size int64
	for {
		n, err := io.ReadFull(body, buf)
		if n > 0 {
			if size+int64(n) > limit {
				return nil, refuse("the file is larger than %d bytes", limit)
			}
			hash.Write(buf[:n])
			p, perr := s.objects.UploadPart(ctx, u.StagingKey, u.S3UploadID, len(parts)+1, bytes.NewReader(buf[:n]), int64(n))
			if perr != nil {
				return nil, errUnavailable(perr)
			}
			parts = append(parts, Part{Number: len(parts) + 1, ETag: p.ETag, Size: int64(n)})
			size += int64(n)
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			break
		}
		if err != nil {
			return nil, errInvalid("the file could not be read: %v", err)
		}
	}
	if size == 0 {
		return nil, refuse("the file is empty")
	}
	u.Size, u.Hash = size, hex.EncodeToString(hash.Sum(nil))
	if existing, err := s.findOwn(ctx, s.pool, u.OwnerID, u.Hash, u.Size, u.Kind); err != nil || existing != nil {
		if existing != nil {
			s.discardUpload(context.WithoutCancel(ctx), u)
		}
		return existing, err
	}
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`, "media-quota:"+s.cfg.TenantID, u.OwnerID); err != nil {
			return fmt.Errorf("media: quota lock: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE uploads SET size = $2, file_hash = $3 WHERE id = $1`, u.ID, u.Size, u.Hash); err != nil {
			return fmt.Errorf("media: record upload size: %w", err)
		}
		var used int64
		if err := tx.QueryRow(ctx, `
			SELECT (SELECT coalesce(sum(size), 0) FROM files WHERE tenant_id = $1 AND owner_id = $2)
				+ (SELECT coalesce(sum(size), 0) FROM uploads
					WHERE tenant_id = $1 AND owner_id = $2 AND completed_at IS NULL AND expires_at > now())`,
			s.cfg.TenantID, u.OwnerID).Scan(&used); err != nil {
			return fmt.Errorf("media: quota: %w", err)
		}
		if used > s.cfg.UserQuotaBytes {
			return errExhausted("storage quota exceeded")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.finish(ctx, u, parts)
}
