// Package media stores and serves the files of messages (release R3) on
// S3-compatible object storage.
//
// Upload: CreateUpload opens a multipart upload on a random staging key and
// hands out part URLs (presigned to S3, or through the media host in proxy
// mode); CompleteUpload completes it, detects the type from the bytes,
// strips metadata (EXIF/GPS, XMP, MP4 udta/meta) without re-encoding,
// checks image dimensions before decoding (bomb guard), makes renditions
// and the inline thumb of photos, writes the result under the file's own
// key and drops the staging object. Photos are processed synchronously, so
// a message never carries an unstripped original; video posters and voice
// waveforms come later from the in-process worker when ffmpeg is
// configured.
//
// Download: GetFileUrl signs a short-lived token bound to the tenant, the
// file, the viewer and the message giving access; the media host checks it
// and that the message still carries the file (deleting the message for
// everyone revokes every URL at once), then streams the object with Range.
package media

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/ratelimit"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Upload and download tuning.
const (
	// PhotoMaxBytes bounds a photo; larger images go as documents.
	PhotoMaxBytes = 20 << 20
	minPartSize   = 8 << 20
	maxParts      = 10000
	// partURLTTL is how long part URLs work; CreateUpload with upload_id
	// gives fresh ones.
	partURLTTL = 6 * time.Hour
	// uploadTTL is how long an unfinished upload is kept.
	uploadTTL = 24 * time.Hour
	// pendingUploadsMax bounds the unfinished uploads of one user.
	pendingUploadsMax = 50
	// completeLease bounds one CompleteUpload; a crashed one is retried
	// after it.
	completeLease = 10 * time.Minute
	// URLTTL is the lifetime of a download URL; expiries are rounded up to
	// urlBucket so URLs stay identical (cacheable) for a while.
	URLTTL    = time.Hour
	urlBucket = 15 * time.Minute
	// fileNameMax bounds a file name in bytes.
	fileNameMax  = 255
	waveformMax  = 256
	durationMax  = 24 * 3600 * 1000
	dimensionMax = 16384
	// FileURLsMax bounds one GetFileUrls call.
	FileURLsMax = 100
)

// Rate limits per user.
var (
	limitUpload = ratelimit.Rule{Rate: 2, Burst: 30}
	limitURLs   = ratelimit.Rule{Rate: 20, Burst: 100}
)

// Upload modes (config.UploadDirect, config.UploadProxy).
const (
	UploadDirect = "direct"
	UploadProxy  = "proxy"
)

// Config configures the Service.
type Config struct {
	TenantID string
	// PublicOrigin is the media host, e.g. https://media-chat.hoandat.com.
	PublicOrigin   string
	UploadMaxBytes int64
	UserQuotaBytes int64
	UploadMode     string
	// FFmpegPath enables the worker; empty disables it.
	FFmpegPath string
	// MinFreeBytes: with storage on a local disk, uploads are refused (and
	// an error logged) while less than this would stay free.
	MinFreeBytes int64
	// SessionKey derives the token key.
	SessionKey []byte
	// SessionKeyPrevious still verifies tokens signed before a key rotation.
	SessionKeyPrevious []byte
}

// Refresher rewrites the messages carrying a file after the worker
// enriched it (poster, duration, waveform); the chat core implements it.
type Refresher interface {
	RefreshFile(ctx context.Context, fileID int64) error
}

// Service implements uploads, downloads and file lifecycle.
type Service struct {
	cfg     Config
	pool    *pgxpool.Pool
	objects Objects
	limiter ratelimit.Limiter
	logger  *slog.Logger
	sign    signer
	decode  *decoder
	now     func() time.Time

	mu        sync.RWMutex
	refresher Refresher
	// access caches download authorizations briefly (Range bursts).
	access *accessCache
}

// New returns the Service.
func New(cfg Config, pool *pgxpool.Pool, objects Objects, limiter ratelimit.Limiter, logger *slog.Logger) (*Service, error) {
	if cfg.TenantID == "" || cfg.PublicOrigin == "" || len(cfg.SessionKey) == 0 || pool == nil || objects == nil ||
		limiter == nil || logger == nil {
		return nil, errors.New("media: incomplete configuration")
	}
	if cfg.UploadMaxBytes <= 0 || cfg.UserQuotaBytes <= 0 {
		return nil, errors.New("media: upload and quota limits are required")
	}
	if cfg.UploadMode == "" {
		cfg.UploadMode = UploadDirect
	}
	if _, local := objects.(*Filesystem); local {
		cfg.UploadMode = UploadProxy // nothing to presign
	}
	if cfg.UploadMode != UploadDirect && cfg.UploadMode != UploadProxy {
		return nil, fmt.Errorf("media: unknown upload mode %q", cfg.UploadMode)
	}
	cfg.PublicOrigin = strings.TrimSuffix(cfg.PublicOrigin, "/")
	return &Service{
		cfg: cfg, pool: pool, objects: objects, limiter: limiter, logger: logger,
		sign: newSigner(cfg.SessionKey, cfg.SessionKeyPrevious), decode: newDecoder(), now: time.Now, access: newAccessCache(),
	}, nil
}

// Config returns the effective configuration.
func (s *Service) Config() Config { return s.cfg }

// SetRefresher connects the chat core.
func (s *Service) SetRefresher(r Refresher) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refresher = r
}

func (s *Service) refresherOf() Refresher {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.refresher
}

// ------------------------------------------------------------------ errors

func errInvalid(format string, args ...any) error {
	return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf(format, args...))
}

func errNotFound(what string) error {
	return connect.NewError(connect.CodeNotFound, fmt.Errorf("%s not found", what))
}

func errExhausted(format string, args ...any) error {
	return connect.NewError(connect.CodeResourceExhausted, fmt.Errorf(format, args...))
}

func errUnavailable(err error) error {
	return connect.NewError(connect.CodeUnavailable, fmt.Errorf("media storage is busy, try again: %w", err))
}

func (s *Service) allow(rule ratelimit.Rule, bucket string, userID int64) error {
	if !s.limiter.Allow(rule, fmt.Sprintf("media-%s:%d", bucket, userID)) {
		return errExhausted("too many requests; slow down")
	}
	return nil
}

// --------------------------------------------------------------- uploads

var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// cleanFileName keeps the last path element, drops control and format
// characters (bidi overrides), and bounds the length at a rune boundary.
func cleanFileName(name string) string {
	name = strings.ToValidUTF8(name, "")
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Base(strings.TrimSpace(name))
	if name == "." || name == "/" || name == ".." {
		return ""
	}
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, name)
	for len(name) > fileNameMax {
		_, n := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-n]
	}
	return name
}

// partSizeFor keeps the part count under the S3 limit; whole MiB.
func partSizeFor(size int64) int64 {
	p := int64(minPartSize)
	if need := (size + maxParts - 1) / maxParts; need > p {
		p = (need + (1<<20 - 1)) &^ (1<<20 - 1)
	}
	return p
}

func partCount(size, partSize int64) int {
	return int((size + partSize - 1) / partSize)
}

// partLength is the byte count of part n (1-based).
func partLength(size, partSize int64, n int) int64 {
	start := int64(n-1) * partSize
	return min(partSize, size-start)
}

// uploadRow is a row of uploads.
type uploadRow struct {
	ID, TenantID     string
	OwnerID          int64
	S3UploadID       string
	StagingKey       string
	Kind             appv1.MediaKind
	FileName, MIME   string
	Size, PartSize   int64
	Hash             string
	Width, Height    int32
	DurationMS       int32
	InlineThumb      []byte
	Waveform         []byte
	FileID           *int64
	Completed        bool
	ExpiresAt        time.Time
	CompletingActive bool
}

const uploadColumns = `id, tenant_id, owner_id, s3_upload_id, staging_key, kind, file_name, mime_type, size, part_size, file_hash,
	width, height, duration_ms, inline_thumb, waveform, file_id, completed_at IS NOT NULL, expires_at,
	coalesce(completing_until > now(), false)`

func scanUpload(row pgx.Row) (*uploadRow, error) {
	u := &uploadRow{}
	var kind string
	err := row.Scan(&u.ID, &u.TenantID, &u.OwnerID, &u.S3UploadID, &u.StagingKey, &kind, &u.FileName, &u.MIME, &u.Size,
		&u.PartSize, &u.Hash, &u.Width, &u.Height, &u.DurationMS, &u.InlineThumb, &u.Waveform, &u.FileID, &u.Completed,
		&u.ExpiresAt, &u.CompletingActive)
	u.Kind = kindOf(kind)
	return u, err
}

func (s *Service) loadUpload(ctx context.Context, q Querier, me int64, id string) (*uploadRow, error) {
	if !ValidPublicID(id) {
		return nil, errNotFound("upload")
	}
	u, err := scanUpload(q.QueryRow(ctx, `SELECT `+uploadColumns+` FROM uploads WHERE id = $1 AND tenant_id = $2 AND owner_id = $3`,
		id, s.cfg.TenantID, me))
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !u.Completed && !s.now().Before(u.ExpiresAt)) {
		return nil, errNotFound("upload")
	}
	if err != nil {
		return nil, fmt.Errorf("media: load upload: %w", err)
	}
	return u, nil
}

// CreateUpload starts (or, with upload_id, resumes) a multipart upload, or
// returns the caller's own file with the same content.
func (s *Service) CreateUpload(ctx context.Context, me int64, req *appv1.CreateUploadRequest) (*appv1.CreateUploadResponse, error) {
	if err := s.allow(limitUpload, "upload", me); err != nil {
		return nil, err
	}
	if req.GetUploadId() != "" {
		return s.resume(ctx, me, req.GetUploadId())
	}
	kind := req.GetKind()
	if _, ok := kindNames[kind]; !ok {
		return nil, errInvalid("kind is required")
	}
	size := req.GetSize()
	if size <= 0 || size > s.cfg.UploadMaxBytes {
		return nil, errInvalid("size must be 1 to %d bytes", s.cfg.UploadMaxBytes)
	}
	if kind == appv1.MediaKind_MEDIA_KIND_PHOTO && size > PhotoMaxBytes {
		return nil, errInvalid("photos are limited to %d bytes; send the image as a file", PhotoMaxBytes)
	}
	hash := strings.ToLower(req.GetFileHash())
	if !hashPattern.MatchString(hash) {
		return nil, errInvalid("file_hash must be the hex SHA-256 of the file")
	}
	if req.GetWidth() < 0 || req.GetWidth() > dimensionMax || req.GetHeight() < 0 || req.GetHeight() > dimensionMax {
		return nil, errInvalid("width and height must be 0 to %d", dimensionMax)
	}
	if req.GetDuration() < 0 || req.GetDuration() > durationMax {
		return nil, errInvalid("duration must be 0 to %d ms", durationMax)
	}
	if len(req.GetWaveform()) > waveformMax {
		return nil, errInvalid("waveform holds at most %d samples", waveformMax)
	}
	if len(req.GetInlineThumb()) > inlineThumbMax {
		return nil, errInvalid("inline_thumb holds at most %d bytes", inlineThumbMax)
	}
	if existing, err := s.findOwn(ctx, s.pool, me, hash, size, kind); err != nil || existing != nil {
		if err != nil {
			return nil, err
		}
		return &appv1.CreateUploadResponse{Result: &appv1.CreateUploadResponse_Existing{Existing: existing.Ref()}}, nil
	}
	if err := s.checkQuota(ctx, s.pool, me, size); err != nil {
		return nil, err
	}
	if err := s.checkDisk(size); err != nil {
		return nil, err
	}
	staging := "staging/" + strings.ReplaceAll(newPublicID(), "-", "x")
	s3ID, err := s.objects.CreateMultipart(ctx, staging)
	if err != nil {
		return nil, errUnavailable(err)
	}
	u := &uploadRow{
		ID: newPublicID(), TenantID: s.cfg.TenantID, OwnerID: me, S3UploadID: s3ID, StagingKey: staging, Kind: kind,
		FileName: cleanFileName(req.GetFileName()), MIME: truncate(req.GetMimeType(), 127), Size: size,
		PartSize: partSizeFor(size), Hash: hash, Width: req.GetWidth(), Height: req.GetHeight(), DurationMS: req.GetDuration(),
		InlineThumb: normalizeClientThumb(req.GetInlineThumb()), Waveform: req.GetWaveform(),
		ExpiresAt: s.now().Add(uploadTTL),
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// One owner's quota checks and inserts run one at a time.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`, "media-quota:"+s.cfg.TenantID, me); err != nil {
			return fmt.Errorf("media: quota lock: %w", err)
		}
		if err := s.checkQuota(ctx, tx, me, size); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO uploads (id, tenant_id, owner_id, s3_upload_id, staging_key, kind, file_name, mime_type, size, part_size,
				file_hash, width, height, duration_ms, inline_thumb, waveform, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
			u.ID, u.TenantID, u.OwnerID, u.S3UploadID, u.StagingKey, kindNames[u.Kind], u.FileName, u.MIME, u.Size, u.PartSize,
			u.Hash, u.Width, u.Height, u.DurationMS, u.InlineThumb, u.Waveform, u.ExpiresAt)
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
	session, err := s.session(ctx, u, nil)
	if err != nil {
		return nil, err
	}
	return &appv1.CreateUploadResponse{Result: &appv1.CreateUploadResponse_Upload{Upload: session}}, nil
}

func truncate(s string, n int) string {
	s = strings.ToValidUTF8(s, "")
	for len(s) > n {
		_, k := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-k]
	}
	return s
}

// findOwn returns me's ready file with this declared content, if any.
func (s *Service) findOwn(ctx context.Context, q Querier, me int64, hash string, size int64, kind appv1.MediaKind) (*File, error) {
	f, err := ScanFile(q.QueryRow(ctx, `SELECT `+FileColumns+` FROM files f
		WHERE f.tenant_id = $1 AND f.owner_id = $2 AND f.source_hash = $3 AND f.kind = $4
			AND (f.size = $5 OR f.file_hash <> f.source_hash)
		ORDER BY f.id DESC LIMIT 1`, s.cfg.TenantID, me, hash, kindNames[kind], size))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("media: dedupe: %w", err)
	}
	return f, nil
}

// checkQuota refuses an upload of size that would take me over the quota
// (stored files plus unfinished uploads) or the pending upload count.
func (s *Service) checkQuota(ctx context.Context, q Querier, me, size int64) error {
	var used, pendingBytes, pending int64
	if err := q.QueryRow(ctx, `
		SELECT (SELECT coalesce(sum(size), 0) FROM files WHERE tenant_id = $1 AND owner_id = $2),
			coalesce(sum(size), 0), count(*)
		FROM uploads WHERE tenant_id = $1 AND owner_id = $2 AND completed_at IS NULL AND expires_at > now()`,
		s.cfg.TenantID, me).Scan(&used, &pendingBytes, &pending); err != nil {
		return fmt.Errorf("media: quota: %w", err)
	}
	if pending >= pendingUploadsMax {
		return errExhausted("too many unfinished uploads; finish or cancel some first")
	}
	if used+pendingBytes+size > s.cfg.UserQuotaBytes {
		return errExhausted("storage quota exceeded")
	}
	return nil
}

func (s *Service) resume(ctx context.Context, me int64, id string) (*appv1.CreateUploadResponse, error) {
	u, err := s.loadUpload(ctx, s.pool, me, id)
	if err != nil {
		return nil, err
	}
	if u.Completed {
		f, err := s.uploadedFile(ctx, u)
		if err != nil {
			return nil, err
		}
		return &appv1.CreateUploadResponse{Result: &appv1.CreateUploadResponse_Existing{Existing: f.Ref()}}, nil
	}
	// Listing parts may be denied to the storage identity; then every part
	// gets a URL and the client skips the ones it knows are stored.
	stored, err := s.objects.ListParts(ctx, u.StagingKey, u.S3UploadID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, errNotFound("upload")
		}
		s.logger.Debug("listing upload parts failed; the client resumes from its own list", "err", err)
		stored = nil
	}
	session, err := s.session(ctx, u, stored)
	if err != nil {
		return nil, err
	}
	return &appv1.CreateUploadResponse{Result: &appv1.CreateUploadResponse_Upload{Upload: session}}, nil
}

func (s *Service) uploadedFile(ctx context.Context, u *uploadRow) (*File, error) {
	if u.FileID == nil {
		return nil, errNotFound("upload")
	}
	f, err := ScanFile(s.pool.QueryRow(ctx, `SELECT `+FileColumns+` FROM files f WHERE f.id = $1`, *u.FileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound("upload")
	}
	if err != nil {
		return nil, fmt.Errorf("media: load file: %w", err)
	}
	return f, nil
}

// session lists URLs for every part not among stored.
func (s *Service) session(ctx context.Context, u *uploadRow, stored []Part) (*appv1.UploadSession, error) {
	expires := s.now().Add(partURLTTL)
	out := &appv1.UploadSession{UploadId: u.ID, PartSize: u.PartSize, UrlsExpireAt: expires.Unix()}
	n := partCount(u.Size, u.PartSize)
	done := map[int]bool{}
	for _, p := range stored {
		if p.Number >= 1 && p.Number <= n && p.Size == partLength(u.Size, u.PartSize, p.Number) {
			done[p.Number] = true
			out.CompletedParts = append(out.CompletedParts, &appv1.CompletedPart{PartNumber: int32(p.Number), Etag: p.ETag})
		}
	}
	for part := 1; part <= n; part++ {
		if done[part] {
			continue
		}
		var url string
		if s.cfg.UploadMode == UploadProxy {
			url = s.cfg.PublicOrigin + "/u/" + s.sign.part(partGrant{uploadID: u.ID, part: part, expires: expires})
		} else {
			var err error
			if url, err = s.objects.PresignPart(ctx, u.StagingKey, u.S3UploadID, part, partURLTTL); err != nil {
				return nil, errUnavailable(err)
			}
		}
		out.Parts = append(out.Parts, &appv1.UploadPartUrl{PartNumber: int32(part), Url: url})
	}
	return out, nil
}

// AbortUpload cancels an unfinished upload.
func (s *Service) AbortUpload(ctx context.Context, me int64, id string) error {
	u, err := s.loadUpload(ctx, s.pool, me, id)
	if err != nil {
		return err
	}
	if u.Completed {
		return nil
	}
	if err := s.objects.AbortMultipart(ctx, u.StagingKey, u.S3UploadID); err != nil && !errors.Is(err, ErrNotFound) {
		return errUnavailable(err)
	}
	if err := s.objects.Delete(ctx, u.StagingKey); err != nil {
		s.logger.Warn("deleting an aborted staging object failed", "err", err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM uploads WHERE id = $1 AND completed_at IS NULL`, u.ID); err != nil {
		return fmt.Errorf("media: delete upload: %w", err)
	}
	return nil
}

// CompleteUpload finalizes an upload into a file. A retry after success
// returns the same file.
func (s *Service) CompleteUpload(ctx context.Context, me int64, req *appv1.CompleteUploadRequest) (*appv1.CompleteUploadResponse, error) {
	if err := s.allow(limitUpload, "upload", me); err != nil {
		return nil, err
	}
	u, err := s.loadUpload(ctx, s.pool, me, req.GetUploadId())
	if err != nil {
		return nil, err
	}
	if u.Completed {
		f, err := s.uploadedFile(ctx, u)
		if err != nil {
			return nil, err
		}
		return &appv1.CompleteUploadResponse{Media: f.Ref()}, nil
	}
	parts, err := s.completeParts(ctx, u, req.GetParts())
	if err != nil {
		return nil, err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE uploads SET completing_until = now() + $2::interval
		WHERE id = $1 AND completed_at IS NULL AND (completing_until IS NULL OR completing_until < now())`, u.ID, completeLease)
	if err != nil {
		return nil, fmt.Errorf("media: lease upload: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil, connect.NewError(connect.CodeAborted, errors.New("this upload is being completed; try again shortly"))
	}
	f, err := s.finish(ctx, u, parts)
	if err != nil {
		var refused *contentError
		release := context.WithoutCancel(ctx)
		if errors.As(err, &refused) {
			s.discardUpload(release, u)
			return nil, errInvalid("%s", refused.reason)
		}
		if _, rerr := s.pool.Exec(release, `UPDATE uploads SET completing_until = NULL WHERE id = $1`, u.ID); rerr != nil {
			s.logger.Warn("releasing an upload lease failed", "err", rerr)
		}
		return nil, err
	}
	return &appv1.CompleteUploadResponse{Media: f.Ref()}, nil
}

// completeParts builds the part list from the client's etags (the storage
// identity may not list parts); the list must name every part once.
func (s *Service) completeParts(ctx context.Context, u *uploadRow, given []*appv1.CompletedPart) ([]Part, error) {
	n := partCount(u.Size, u.PartSize)
	byNumber := map[int]string{}
	for _, p := range given {
		num := int(p.GetPartNumber())
		etag := strings.TrimSpace(p.GetEtag())
		if num >= 1 && num <= n && etag != "" && len(etag) <= 128 {
			byNumber[num] = etag
		}
	}
	if len(byNumber) < n {
		if stored, err := s.objects.ListParts(ctx, u.StagingKey, u.S3UploadID); err == nil {
			for _, p := range stored {
				if p.Number >= 1 && p.Number <= n && byNumber[p.Number] == "" {
					byNumber[p.Number] = p.ETag
				}
			}
		}
	}
	parts := make([]Part, 0, n)
	for num := 1; num <= n; num++ {
		etag, ok := byNumber[num]
		if !ok {
			return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("upload_incomplete: part %d is missing", num))
		}
		parts = append(parts, Part{Number: num, ETag: etag})
	}
	return parts, nil
}

// contentError reports an upload whose content is refused for good.
type contentError struct{ reason string }

func (e *contentError) Error() string { return "media: " + e.reason }

func refuse(format string, args ...any) error {
	return &contentError{reason: fmt.Sprintf(format, args...)}
}

// discardUpload drops a refused upload and its staging data.
func (s *Service) discardUpload(ctx context.Context, u *uploadRow) {
	if err := s.objects.AbortMultipart(ctx, u.StagingKey, u.S3UploadID); err != nil && !errors.Is(err, ErrNotFound) {
		s.logger.Warn("aborting a refused upload failed", "err", err)
	}
	if err := s.objects.Delete(ctx, u.StagingKey); err != nil {
		s.logger.Warn("deleting a refused staging object failed", "err", err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM uploads WHERE id = $1`, u.ID); err != nil {
		s.logger.Warn("deleting a refused upload failed", "err", err)
	}
}

// finish completes the multipart upload, processes the content and stores
// the file row.
func (s *Service) finish(ctx context.Context, u *uploadRow, parts []Part) (*File, error) {
	if err := s.objects.CompleteMultipart(ctx, u.StagingKey, u.S3UploadID, parts); err != nil {
		if !errors.Is(err, ErrNotFound) {
			if strings.Contains(err.Error(), "InvalidPart") || strings.Contains(err.Error(), "EntityTooSmall") {
				return nil, connect.NewError(connect.CodeFailedPrecondition,
					errors.New("upload_incomplete: a part is missing or does not match its etag"))
			}
			return nil, errUnavailable(err)
		}
		// Completed by an earlier attempt that stopped before storing the
		// file: the staging object is there.
	}
	size, err := s.objects.Size(ctx, u.StagingKey)
	if errors.Is(err, ErrNotFound) {
		return nil, errNotFound("upload")
	}
	if err != nil {
		return nil, errUnavailable(err)
	}
	if size != u.Size {
		return nil, refuse("the uploaded file has %d bytes, not the declared %d", size, u.Size)
	}
	f := &File{
		PublicID: newPublicID(), TenantID: u.TenantID, OwnerID: u.OwnerID, Kind: u.Kind, Name: u.FileName,
		Width: u.Width, Height: u.Height, DurationMS: u.DurationMS, InlineThumb: u.InlineThumb, Waveform: u.Waveform,
		Hash: u.Hash, Key: "f/" + newUUID(),
	}
	job, err := s.process(ctx, u.StagingKey, u.Size, f)
	if err != nil {
		return nil, err
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := insertFile(ctx, tx, f, u.Hash); err != nil {
			return err
		}
		if job {
			if _, err := tx.Exec(ctx, `INSERT INTO media_jobs (file_id) VALUES ($1) ON CONFLICT DO NOTHING`, f.ID); err != nil {
				return fmt.Errorf("media: queue job: %w", err)
			}
		}
		_, err := tx.Exec(ctx, `UPDATE uploads SET file_id = $2, completed_at = now(), completing_until = NULL WHERE id = $1`, u.ID, f.ID)
		if err != nil {
			return fmt.Errorf("media: complete upload: %w", err)
		}
		return nil
	})
	if err != nil {
		s.deleteObjects(context.WithoutCancel(ctx), f.keys())
		return nil, err
	}
	if err := s.objects.Delete(ctx, u.StagingKey); err != nil {
		s.logger.Warn("deleting a staging object failed", "err", err)
	}
	return f, nil
}

func insertFile(ctx context.Context, tx Querier, f *File, sourceHash string) error {
	sizes, err := marshalSizes(f.Sizes)
	if err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO files (public_id, tenant_id, owner_id, kind, mime_type, size, file_name, file_hash, source_hash,
			width, height, duration_ms, inline_thumb, waveform, object_key, sizes)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
		f.PublicID, f.TenantID, f.OwnerID, kindNames[f.Kind], f.MIME, f.Size, f.Name, f.Hash, sourceHash,
		f.Width, f.Height, f.DurationMS, nilIfEmpty(f.InlineThumb), nilIfEmpty(f.Waveform), f.Key, sizes).Scan(&f.ID); err != nil {
		return fmt.Errorf("media: insert file: %w", err)
	}
	return nil
}

func nilIfEmpty(b []byte) []byte {
	if len(b) == 0 {
		return nil
	}
	return b
}

func (s *Service) deleteObjects(ctx context.Context, keys []string) {
	for _, k := range keys {
		if err := s.objects.Delete(ctx, k); err != nil {
			s.logger.Warn("deleting a media object failed", "key", k, "err", err)
		}
	}
}

// newUUID returns a random (version 4) uuid for an object key.
func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b) // crypto/rand.Read never fails
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// spaceReporter is storage on a local disk.
type spaceReporter interface {
	FreeBytes() (int64, error)
}

// checkDisk refuses an upload that would leave less than MinFreeBytes on
// a local storage disk; it needs about twice the file while completing.
func (s *Service) checkDisk(size int64) error {
	free, low, err := s.diskLow(2 * size)
	if err != nil {
		s.logger.Error("media disk space unknown", "err", err)
		return errUnavailable(err)
	}
	if low {
		s.logger.Error("media disk almost full; uploads refused", "free_bytes", free, "min_free_bytes", s.cfg.MinFreeBytes)
		return errExhausted("server storage is full; try again later")
	}
	return nil
}

// diskLow reports whether writing extra bytes would go under the free
// space threshold (never for remote storage).
func (s *Service) diskLow(extra int64) (free int64, low bool, err error) {
	r, ok := s.objects.(spaceReporter)
	if !ok || s.cfg.MinFreeBytes <= 0 {
		return 0, false, nil
	}
	free, err = r.FreeBytes()
	if err != nil {
		return 0, false, err
	}
	return free, free-extra < s.cfg.MinFreeBytes, nil
}

// ------------------------------------------------------------------ URLs

// Access is a file a viewer may read through a message (chat_id, seq).
type Access struct {
	File   *File
	ChatID int64
	Seq    int64
}

// AllowURLs applies the URL rate limit to n requested URLs.
func (s *Service) AllowURLs(me int64) error {
	return s.allow(limitURLs, "urls", me)
}

// SignURL returns a download URL of the requested rendition (or of the
// original when the file has no such rendition) for viewer.
func (s *Service) SignURL(viewer int64, a Access, want appv1.MediaSizeType) *appv1.FileUrlResult {
	size := appv1.MediaSizeType_MEDIA_SIZE_TYPE_UNSPECIFIED
	if _, ok := a.File.rendition(want); ok {
		size = want
	}
	expires := s.now().Add(URLTTL).Truncate(urlBucket).Add(urlBucket)
	token := s.sign.download(downloadGrant{
		tenant: s.cfg.TenantID, fileID: a.File.ID, size: size, viewer: viewer, chatID: a.ChatID, seq: a.Seq, expires: expires,
	})
	return &appv1.FileUrlResult{Url: s.cfg.PublicOrigin + "/f/" + token, ExpiresAt: expires.Unix(), Size: size}
}
