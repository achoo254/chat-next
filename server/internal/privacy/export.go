package privacy

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
)

// Data exports: RequestExport queues one (at most one per ExportInterval,
// failed ones not counting), the builder writes the ZIP into the export
// directory in the background (export_zip.go), GetExportURL signs a
// short-lived download on the media host, and the hourly job deletes the
// file ExportRetention after it was ready.

const (
	// exportPoll is how often the builder looks for queued exports besides
	// being woken by a request.
	exportPoll = 30 * time.Second
	// exportLease is how long a builder holds an export without renewing.
	exportLease = 10 * time.Minute
	// exportAttempts bounds the builds of one export after crashes.
	exportAttempts = 3
	// urlTTL bounds a download URL.
	urlTTL = 10 * time.Minute
	// DownloadPrefix is the media host path of export downloads; under /f/,
	// which nginx already passes to the app (and redacts in its log).
	DownloadPrefix = "/f/export/"
)

var exportStatuses = map[string]appv1.DataExportStatus{
	"pending": appv1.DataExportStatus_DATA_EXPORT_STATUS_PENDING,
	"running": appv1.DataExportStatus_DATA_EXPORT_STATUS_RUNNING,
	"ready":   appv1.DataExportStatus_DATA_EXPORT_STATUS_READY,
	"failed":  appv1.DataExportStatus_DATA_EXPORT_STATUS_FAILED,
	"expired": appv1.DataExportStatus_DATA_EXPORT_STATUS_EXPIRED,
}

// exportRow is one row of data_exports.
type exportRow struct {
	ID        int64
	UserID    int64
	Status    string
	Progress  int16
	FileName  string
	Size      int64
	CreatedAt time.Time
	ReadyAt   *time.Time
	ExpiresAt *time.Time
	Username  string
}

const exportColumns = `e.id, e.user_id, e.status, e.progress, e.file_name, e.size_bytes, e.created_at, e.ready_at, e.expires_at, u.username`

const exportFrom = `data_exports e JOIN users u ON u.id = e.user_id`

func scanExport(row pgx.Row) (*exportRow, error) {
	e := &exportRow{}
	err := row.Scan(&e.ID, &e.UserID, &e.Status, &e.Progress, &e.FileName, &e.Size, &e.CreatedAt, &e.ReadyAt, &e.ExpiresAt,
		&e.Username)
	return e, err
}

// downloadName is the file name the browser saves.
func (e *exportRow) downloadName() string {
	return "chat-export-" + e.Username + "-" + e.CreatedAt.In(saigon).Format("20060102") + ".zip"
}

func (e *exportRow) render() *appv1.DataExport {
	out := &appv1.DataExport{
		Id: e.ID, Status: exportStatuses[e.Status], Progress: int32(e.Progress), CreatedAt: e.CreatedAt.Unix(),
		FileName: e.downloadName(),
	}
	if e.Status == "ready" {
		out.Size = e.Size
		if e.ReadyAt != nil {
			out.ReadyAt = e.ReadyAt.Unix()
		}
		if e.ExpiresAt != nil {
			out.ExpiresAt = e.ExpiresAt.Unix()
		}
	}
	return out
}

// saigon is the time zone of dates written into exports and their names.
var saigon = func() *time.Location {
	if loc, err := time.LoadLocation("Asia/Ho_Chi_Minh"); err == nil {
		return loc
	}
	return time.FixedZone("ICT", 7*3600)
}()

// latestExport returns me's newest export and when the next request is
// allowed (zero when now).
func (s *Service) latestExport(ctx context.Context, q interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}, me int64) (*exportRow, time.Time, error) {
	e, err := scanExport(q.QueryRow(ctx, `SELECT `+exportColumns+` FROM `+exportFrom+`
		WHERE e.user_id = $1 AND e.tenant_id = $2 ORDER BY e.id DESC LIMIT 1`, me, s.cfg.TenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		e = nil
	} else if err != nil {
		return nil, time.Time{}, fmt.Errorf("privacy: latest export: %w", err)
	}
	var last *time.Time
	if err := q.QueryRow(ctx, `
		SELECT max(created_at) FROM data_exports WHERE user_id = $1 AND tenant_id = $2 AND status <> 'failed'`,
		me, s.cfg.TenantID).Scan(&last); err != nil {
		return nil, time.Time{}, fmt.Errorf("privacy: last export: %w", err)
	}
	var next time.Time
	if last != nil && s.now().Before(last.Add(ExportInterval)) {
		next = last.Add(ExportInterval)
	}
	return e, next, nil
}

func unixOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}

// ExportState answers GetDataExport.
func (s *Service) ExportState(ctx context.Context, me int64) (*appv1.GetDataExportResponse, error) {
	e, next, err := s.latestExport(ctx, s.pool, me)
	if err != nil {
		return nil, err
	}
	resp := &appv1.GetDataExportResponse{NextRequestAt: unixOrZero(next), Available: s.ExportsEnabled()}
	if e != nil {
		resp.Export = e.render()
	}
	return resp, nil
}

// RequestExport queues an export of me's data.
func (s *Service) RequestExport(ctx context.Context, me int64) (*appv1.RequestDataExportResponse, error) {
	if !s.ExportsEnabled() {
		return nil, errPrecondition("export_unavailable: this server keeps no data exports")
	}
	var resp *appv1.RequestDataExportResponse
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// One request at a time per user: the 7-day check and the insert
		// must not interleave.
		if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, me); err != nil {
			return fmt.Errorf("privacy: lock account: %w", err)
		}
		_, next, err := s.latestExport(ctx, tx, me)
		if err != nil {
			return err
		}
		if !next.IsZero() {
			return connect.NewError(connect.CodeResourceExhausted,
				fmt.Errorf("export_rate_limited: one export per 7 days; next at %d", next.Unix()))
		}
		var id int64
		if err := tx.QueryRow(ctx, `INSERT INTO data_exports (tenant_id, user_id) VALUES ($1, $2) RETURNING id`,
			s.cfg.TenantID, me).Scan(&id); err != nil {
			return fmt.Errorf("privacy: queue export: %w", err)
		}
		e, next, err := s.latestExport(ctx, tx, me)
		if err != nil {
			return err
		}
		resp = &appv1.RequestDataExportResponse{Export: e.render(), NextRequestAt: unixOrZero(next)}
		return nil
	})
	if err != nil {
		return nil, err
	}
	select {
	case s.kick <- struct{}{}:
	default:
	}
	s.logger.Info("data export requested", "user_id", me, "export_id", resp.GetExport().GetId())
	return resp, nil
}

// ExportURL signs a download URL of me's ready export id.
func (s *Service) ExportURL(ctx context.Context, me, id int64) (*appv1.GetDataExportUrlResponse, error) {
	if !s.ExportsEnabled() {
		return nil, errPrecondition("export_unavailable: this server keeps no data exports")
	}
	e, err := scanExport(s.pool.QueryRow(ctx, `SELECT `+exportColumns+` FROM `+exportFrom+`
		WHERE e.id = $1 AND e.user_id = $2 AND e.tenant_id = $3`, id, me, s.cfg.TenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound("export")
	}
	if err != nil {
		return nil, fmt.Errorf("privacy: load export: %w", err)
	}
	if e.Status != "ready" || e.ExpiresAt == nil || !s.now().Before(*e.ExpiresAt) {
		return nil, errPrecondition("export_not_ready: the export is not ready or has expired")
	}
	expires := s.now().Add(urlTTL)
	token := s.sign.token(downloadGrant{tenant: s.cfg.TenantID, exportID: e.ID, userID: me, expires: expires})
	return &appv1.GetDataExportUrlResponse{Url: s.cfg.MediaOrigin + DownloadPrefix + token, ExpiresAt: expires.Unix()}, nil
}

// ServeDownload serves GET and HEAD of DownloadPrefix + token on the media
// host: the token is the only credential (no cookie), and the export must
// still be ready, unexpired and its account not erased. 403 for an expired
// or forged token, 404 once the export is gone.
func (s *Service) ServeDownload(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cache-Control", "private, no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		h.Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	g, err := s.sign.open(strings.TrimPrefix(r.URL.Path, DownloadPrefix), s.now())
	if err != nil || g.tenant != s.cfg.TenantID || !s.ExportsEnabled() {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	e, err := scanExport(s.pool.QueryRow(r.Context(), `SELECT `+exportColumns+` FROM `+exportFrom+`
		WHERE e.id = $1 AND e.user_id = $2 AND e.tenant_id = $3 AND e.status = 'ready' AND e.expires_at > now()
			AND u.deleted_at IS NULL`, g.exportID, g.userID, s.cfg.TenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		s.logger.Error("export download lookup failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	f, err := os.Open(filepath.Join(s.cfg.ExportDir, e.FileName))
	if err != nil {
		s.logger.Error("export file missing", "export_id", e.ID, "err", err)
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer func() { _ = f.Close() }()
	h.Set("Content-Type", "application/zip")
	h.Set("Content-Disposition", `attachment; filename="`+e.downloadName()+`"`)
	modified := e.CreatedAt
	if e.ReadyAt != nil {
		modified = *e.ReadyAt
	}
	http.ServeContent(w, r, "", modified, f)
}

// expireExports deletes the files of exports past ExportRetention.
func (s *Service) expireExports(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE data_exports SET status = 'expired'
		WHERE id IN (SELECT id FROM data_exports WHERE tenant_id = $1 AND status = 'ready' AND expires_at <= $2 LIMIT 500)
		RETURNING file_name`, s.cfg.TenantID, s.now())
	if err != nil {
		return 0, fmt.Errorf("privacy: expire exports: %w", err)
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return 0, fmt.Errorf("privacy: expire exports: %w", err)
	}
	for _, name := range names {
		s.removeExportFile(name)
	}
	return len(names), nil
}

// ------------------------------------------------------------ tokens

// downloadGrant is what a download token proves: the user may fetch the
// export of tenant until expires.
type downloadGrant struct {
	tenant   string
	exportID int64
	userID   int64
	expires  time.Time
}

const (
	tokenVersion = 1
	macLen       = 16
)

var errBadToken = errors.New("privacy: invalid download token")

// signer signs download tokens with a key derived from SESSION_KEY (its
// own label, so a media token never opens an export and the reverse).
type signer struct{ key []byte }

func newSigner(sessionKey []byte) signer {
	mac := hmac.New(sha256.New, sessionKey)
	mac.Write([]byte("chat data export tokens v1"))
	return signer{key: mac.Sum(nil)}
}

func (s signer) mac(payload []byte) []byte {
	m := hmac.New(sha256.New, s.key)
	m.Write(payload)
	return m.Sum(nil)[:macLen]
}

func (s signer) token(g downloadGrant) string {
	b := []byte{tokenVersion}
	b = binary.BigEndian.AppendUint32(b, uint32(g.expires.Unix()))
	b = binary.AppendUvarint(b, uint64(g.exportID))
	b = binary.AppendUvarint(b, uint64(g.userID))
	b = append(b, g.tenant...)
	return base64.RawURLEncoding.EncodeToString(append(b, s.mac(b)...))
}

func (s signer) open(token string, now time.Time) (downloadGrant, error) {
	if len(token) > 256 {
		return downloadGrant{}, errBadToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) < 1+4+macLen || raw[0] != tokenVersion {
		return downloadGrant{}, errBadToken
	}
	payload, sum := raw[:len(raw)-macLen], raw[len(raw)-macLen:]
	if !hmac.Equal(sum, s.mac(payload)) {
		return downloadGrant{}, errBadToken
	}
	g := downloadGrant{expires: time.Unix(int64(binary.BigEndian.Uint32(payload[1:5])), 0)}
	rest := payload[5:]
	id, n := binary.Uvarint(rest)
	if n <= 0 {
		return downloadGrant{}, errBadToken
	}
	rest = rest[n:]
	user, n := binary.Uvarint(rest)
	if n <= 0 || id >= 1<<53 || user >= 1<<53 {
		return downloadGrant{}, errBadToken
	}
	g.exportID, g.userID, g.tenant = int64(id), int64(user), string(rest[n:])
	if !now.Before(g.expires) {
		return downloadGrant{}, errBadToken
	}
	return g, nil
}
