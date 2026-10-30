package privacy

import (
	"archive/zip"
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/media"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// Contents of an export ZIP (README.txt inside says the same to the user).
// Only the user's own data, as Nghị định 13 asks; other people's messages
// are left out, and chat partners appear only by name and username:
//
//	README.txt              what the files are
//	index.html              offline overview: profile, settings, chats
//	profile.json            the account, its settings, app language and auto-delete
//	contacts.json           the user's contact list
//	blocked.json            the users they blocked
//	sessions.json           devices signed in (user agent, IP, dates)
//	bots.json               bots they own (never a token)
//	chats.json              every chat they are or were in
//	messages/<chat>.json    the messages they sent there (saved chat:
//	                        "Cloud của tôi", everything in it)
//	chats/<chat>.html       the same messages, readable offline
//	media/<file>            files attached to those messages, up to the
//	                        size cap (the others are marked included=false)

// exportPage is how many messages one query reads.
const exportPage = 500

// progressEvery bounds how often progress (and the lease) is written.
const progressEvery = 2 * time.Second

// errExportCancelled stops a build whose export was cancelled (the
// account entered its deletion grace period).
var errExportCancelled = errors.New("privacy: export cancelled")

// errExportTooBig stops a build that would leave the disk too full.
var errExportTooBig = errors.New("privacy: not enough disk space for the export")

// buildPending builds queued exports one at a time until none is left or
// ctx ends.
func (s *Service) buildPending(ctx context.Context) {
	if !s.ExportsEnabled() {
		return
	}
	for ctx.Err() == nil {
		job, err := s.claimExport(ctx)
		if err != nil {
			s.logger.Error("claiming a data export failed", "err", err)
			return
		}
		if job == nil {
			return
		}
		s.build(ctx, job)
	}
}

// exportJob is a claimed export.
type exportJob struct {
	id       int64
	userID   int64
	attempts int16
	fileName string
}

// claimExport takes the oldest queued export (or one whose builder died)
// with a lease; nil when there is none.
func (s *Service) claimExport(ctx context.Context) (*exportJob, error) {
	suffix := make([]byte, 16)
	if _, err := rand.Read(suffix); err != nil {
		return nil, fmt.Errorf("privacy: export name: %w", err)
	}
	j := &exportJob{}
	err := s.pool.QueryRow(ctx, `
		UPDATE data_exports SET status = 'running', progress = 0, attempts = attempts + 1,
			lease_until = now() + $2::interval,
			file_name = CASE WHEN file_name = '' THEN id::text || '-' || $3 || '.zip' ELSE file_name END
		WHERE id = (SELECT id FROM data_exports
			WHERE tenant_id = $1 AND (status = 'pending' OR (status = 'running' AND lease_until < now()))
			ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING id, user_id, attempts, file_name`,
		s.cfg.TenantID, exportLease, base64.RawURLEncoding.EncodeToString(suffix)[:22]).
		Scan(&j.id, &j.userID, &j.attempts, &j.fileName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("privacy: claim export: %w", err)
	}
	return j, nil
}

// build writes the ZIP of a claimed export and marks it ready, or failed.
func (s *Service) build(ctx context.Context, j *exportJob) {
	log := s.logger.With("export_id", j.id, "user_id", j.userID)
	if j.attempts > exportAttempts {
		s.finishFailed(ctx, j, "internal")
		log.Error("data export gave up after repeated failures")
		return
	}
	start := s.now()
	size, err := s.writeExport(ctx, j)
	switch {
	case errors.Is(err, errExportCancelled):
		s.removeExportFile(j.fileName)
		log.Info("data export cancelled")
		return
	case errors.Is(err, errExportTooBig):
		s.removeExportFile(j.fileName)
		s.finishFailed(ctx, j, "disk_full")
		log.Error("data export refused: the export disk is too full")
		return
	case err != nil:
		s.removeExportFile(j.fileName)
		if ctx.Err() != nil {
			// Shutdown: the lease runs out and the next start builds it again.
			return
		}
		s.finishFailed(ctx, j, "internal")
		log.Error("data export failed", "err", err)
		return
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE data_exports SET status = 'ready', progress = 100, size_bytes = $2, lease_until = NULL,
			ready_at = now(), expires_at = now() + $3::interval
		WHERE id = $1 AND status = 'running'`, j.id, size, ExportRetention)
	if err != nil || tag.RowsAffected() == 0 {
		s.removeExportFile(j.fileName)
		if err != nil {
			log.Error("marking a data export ready failed", "err", err)
		}
		return
	}
	log.Info("data export ready", "bytes", size, "took", s.now().Sub(start).Round(time.Millisecond))
}

func (s *Service) finishFailed(ctx context.Context, j *exportJob, reason string) {
	if _, err := s.pool.Exec(context.WithoutCancel(ctx), `
		UPDATE data_exports SET status = 'failed', error = $2, lease_until = NULL WHERE id = $1 AND status = 'running'`,
		j.id, reason); err != nil {
		s.logger.Error("marking a data export failed failed", "export_id", j.id, "err", err)
	}
}

// exportWriter carries one build.
type exportWriter struct {
	s        *Service
	ctx      context.Context
	job      *exportJob
	zip      *zip.Writer
	steps    int
	done     int
	reported time.Time
	// files are the files to copy under media/, in order.
	files    []exportFile
	mediaSum int64
	// decided maps every attached file seen by the JSON pass to its path
	// under media/ ("" when left out by the size cap), for the HTML pass.
	decided map[fileKey]string
	// names already used under media/.
	names map[string]bool
}

// exportFile is a file to copy into the ZIP.
type exportFile struct {
	file *media.File
	path string
}

// fileKey is a file attached to one message.
type fileKey struct{ chatID, seq, fileID int64 }

// writeExport writes the ZIP to a temporary name and renames it into place;
// it returns the ZIP's size.
func (s *Service) writeExport(ctx context.Context, j *exportJob) (int64, error) {
	if filepath.Base(j.fileName) != j.fileName || !strings.HasSuffix(j.fileName, ".zip") {
		return 0, fmt.Errorf("privacy: bad export file name %q", j.fileName)
	}
	final := filepath.Join(s.cfg.ExportDir, j.fileName)
	part := final + ".part"
	f, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o640)
	if err != nil {
		return 0, fmt.Errorf("privacy: create export: %w", err)
	}
	ok := false
	defer func() {
		if !ok {
			_ = f.Close()
			_ = os.Remove(part)
		}
	}()
	buf := bufio.NewWriterSize(f, 256<<10)
	w := &exportWriter{s: s, ctx: ctx, job: j, zip: zip.NewWriter(buf), decided: map[fileKey]string{}, names: map[string]bool{},
		reported: s.now()}
	if err := w.write(); err != nil {
		return 0, err
	}
	if err := w.zip.Close(); err != nil {
		return 0, fmt.Errorf("privacy: finish export: %w", err)
	}
	if err := buf.Flush(); err != nil {
		return 0, fmt.Errorf("privacy: write export: %w", err)
	}
	if err := f.Sync(); err != nil {
		return 0, fmt.Errorf("privacy: sync export: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		return 0, fmt.Errorf("privacy: export size: %w", err)
	}
	if err := f.Close(); err != nil {
		return 0, fmt.Errorf("privacy: close export: %w", err)
	}
	if err := os.Rename(part, final); err != nil {
		return 0, fmt.Errorf("privacy: place export: %w", err)
	}
	ok = true
	return info.Size(), nil
}

// step counts one unit of work and, at most every progressEvery, writes
// the progress and renews the lease; errExportCancelled when the export
// is no longer running.
func (w *exportWriter) step() error {
	w.done++
	if err := w.ctx.Err(); err != nil {
		return err
	}
	now := w.s.now()
	if now.Sub(w.reported) < progressEvery {
		return nil
	}
	w.reported = now
	progress := 0
	if w.steps > 0 {
		progress = min(99, w.done*100/w.steps)
	}
	tag, err := w.s.pool.Exec(w.ctx, `
		UPDATE data_exports SET progress = $2, lease_until = now() + $3::interval WHERE id = $1 AND status = 'running'`,
		w.job.id, progress, exportLease)
	if err != nil {
		return fmt.Errorf("privacy: export progress: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errExportCancelled
	}
	return nil
}

// entry opens a compressed text entry.
func (w *exportWriter) entry(name string) (io.Writer, error) {
	ew, err := w.zip.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: w.s.now()})
	if err != nil {
		return nil, fmt.Errorf("privacy: zip entry %s: %w", name, err)
	}
	return ew, nil
}

func (w *exportWriter) writeJSON(name string, v any) error {
	ew, err := w.entry(name)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(ew)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return fmt.Errorf("privacy: write %s: %w", name, err)
	}
	return w.step()
}

// exportTime formats a time for people and machines alike.
func exportTime(t time.Time) string {
	return t.In(saigon).Format(time.RFC3339)
}

func optionalTime(t *time.Time) string {
	if t == nil {
		return ""
	}
	return exportTime(*t)
}

// exportChat is one chat of the user.
type exportChat struct {
	ID       int64  `json:"id"`
	Type     string `json:"type"`
	Title    string `json:"title"`
	Role     string `json:"role"`
	JoinedAt string `json:"joined_at"`
	LeftAt   string `json:"left_at,omitempty"`
	Messages int    `json:"messages_sent"`
	File     string `json:"messages_file"`
	// Private chats: the other person (by name only).
	Peer *exportPerson `json:"peer,omitempty"`
}

// exportPerson names another user.
type exportPerson struct {
	ID       int64  `json:"id"`
	Username string `json:"username,omitempty"`
	Name     string `json:"name"`
	Deleted  bool   `json:"deleted,omitempty"`
}

func (w *exportWriter) write() error {
	q := w.s.pool
	ctx := w.ctx
	me := w.job.userID

	var profile struct {
		ID           int64           `json:"id"`
		Username     string          `json:"username"`
		Name         string          `json:"name"`
		Bio          string          `json:"bio"`
		Email        string          `json:"email,omitempty"`
		IdPPicture   string          `json:"idp_picture,omitempty"`
		Locale       string          `json:"locale"`
		CreatedAt    string          `json:"created_at"`
		AutoDelete   int16           `json:"auto_delete_months"`
		Privacy      json.RawMessage `json:"privacy_settings"`
		Notification json.RawMessage `json:"notification_settings"`
		ExportedAt   string          `json:"exported_at"`
	}
	var created time.Time
	var privacy, notification []byte
	if err := q.QueryRow(ctx, `
		SELECT u.id, u.username, u.name, u.bio, coalesce(u.email, ''), coalesce(u.idp_picture, ''), u.locale, u.created_at, u.auto_delete_months,
			coalesce((SELECT to_jsonb(p) - 'user_id' FROM privacy_settings p WHERE p.user_id = u.id), 'null'),
			coalesce((SELECT to_jsonb(n) - 'user_id' FROM notification_settings n WHERE n.user_id = u.id), 'null')
		FROM users u WHERE u.id = $1 AND u.tenant_id = $2`, me, w.s.cfg.TenantID).Scan(
		&profile.ID, &profile.Username, &profile.Name, &profile.Bio, &profile.Email, &profile.IdPPicture, &profile.Locale, &created, &profile.AutoDelete,
		&privacy, &notification); err != nil {
		return fmt.Errorf("privacy: export profile: %w", err)
	}
	profile.CreatedAt, profile.ExportedAt = exportTime(created), exportTime(w.s.now())
	profile.Privacy, profile.Notification = privacy, notification

	chats, err := w.loadChats()
	if err != nil {
		return err
	}
	// README, profile, contacts, blocked, sessions, bots, chats, index; two
	// per chat (JSON and HTML); files are counted once known.
	w.steps = 8 + 2*len(chats)

	if err := w.writeReadme(); err != nil {
		return err
	}
	if err := w.writeJSON("profile.json", profile); err != nil {
		return err
	}
	contacts, err := w.people(`
		SELECT u.id, u.username, u.name, u.deletion_requested_at IS NOT NULL OR u.deleted_at IS NOT NULL, c.created_at
		FROM contacts c JOIN users u ON u.id = c.contact_id WHERE c.owner_id = $1 ORDER BY c.created_at, u.id`)
	if err != nil {
		return err
	}
	if err := w.writeJSON("contacts.json", contacts); err != nil {
		return err
	}
	blocked, err := w.people(`
		SELECT u.id, u.username, u.name, u.deletion_requested_at IS NOT NULL OR u.deleted_at IS NOT NULL, b.created_at
		FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY b.created_at, u.id`)
	if err != nil {
		return err
	}
	if err := w.writeJSON("blocked.json", blocked); err != nil {
		return err
	}
	sessions, err := w.sessions()
	if err != nil {
		return err
	}
	if err := w.writeJSON("sessions.json", sessions); err != nil {
		return err
	}
	bots, err := w.s.bots.OwnedBots(ctx, me)
	if err != nil {
		return err
	}
	botList := make([]map[string]any, 0, len(bots))
	for _, b := range bots {
		botList = append(botList, map[string]any{"id": b.GetBotId(), "username": b.GetUsername(), "name": b.GetName()})
	}
	if err := w.writeJSON("bots.json", botList); err != nil {
		return err
	}
	for i := range chats {
		n, err := w.writeMessagesJSON(&chats[i])
		if err != nil {
			return err
		}
		chats[i].Messages = n
	}
	if err := w.writeJSON("chats.json", chats); err != nil {
		return err
	}
	for i := range chats {
		if err := w.writeChatHTML(&chats[i]); err != nil {
			return err
		}
	}
	if err := w.copyFiles(); err != nil {
		return err
	}
	return w.writeIndex(profile.Username, profile.Name, profile.Email, profile.CreatedAt, chats, len(contacts), len(blocked))
}

func (w *exportWriter) writeReadme() error {
	ew, err := w.entry("README.txt")
	if err != nil {
		return err
	}
	_, err = io.WriteString(ew, strings.Join([]string{
		"Dữ liệu cá nhân của bạn trong ứng dụng chat",
		"",
		"Mở index.html để xem offline. Các file .json đọc được bằng máy:",
		"profile.json: tài khoản, cài đặt quyền riêng tư và thông báo, ngôn ngữ app, tự xoá.",
		"contacts.json, blocked.json: danh bạ và người bạn đã chặn.",
		"sessions.json: các thiết bị đã đăng nhập.",
		"bots.json: bot của bạn (không có token).",
		"chats.json: các chat bạn đang hoặc đã tham gia.",
		"messages/<chat>.json và chats/<chat>.html: tin bạn đã gửi trong từng chat.",
		"media/: file đính kèm tin bạn gửi (file vượt giới hạn dung lượng có included=false).",
		"",
		"Tin nhắn của người khác không có trong bản xuất. Tài khoản hoandat (đăng nhập Google, GitHub hoặc Apple)",
		"được quản lý ở trang tài khoản hoandat, không thuộc bản xuất này.",
		"",
	}, "\n"))
	if err != nil {
		return fmt.Errorf("privacy: write README: %w", err)
	}
	return w.step()
}

// people runs a query of (id, username, name, deleted, at) for the user.
func (w *exportWriter) people(sql string) ([]map[string]any, error) {
	rows, err := w.s.pool.Query(w.ctx, sql, w.job.userID)
	if err != nil {
		return nil, fmt.Errorf("privacy: export people: %w", err)
	}
	out := []map[string]any{}
	for rows.Next() {
		var p exportPerson
		var at time.Time
		if err := rows.Scan(&p.ID, &p.Username, &p.Name, &p.Deleted, &at); err != nil {
			rows.Close()
			return nil, fmt.Errorf("privacy: export people: %w", err)
		}
		person := map[string]any{"id": p.ID, "since": exportTime(at)}
		if p.Deleted {
			person["deleted"] = true
		} else {
			person["username"], person["name"] = p.Username, p.Name
		}
		out = append(out, person)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("privacy: export people: %w", err)
	}
	return out, nil
}

func (w *exportWriter) sessions() ([]map[string]any, error) {
	rows, err := w.s.pool.Query(w.ctx, `
		SELECT user_agent, coalesce(host(ip), ''), created_at, last_seen_at, revoked_at FROM user_sessions
		WHERE user_id = $1 ORDER BY created_at, id`, w.job.userID)
	if err != nil {
		return nil, fmt.Errorf("privacy: export sessions: %w", err)
	}
	out := []map[string]any{}
	for rows.Next() {
		var agent, ip string
		var created, seen time.Time
		var revoked *time.Time
		if err := rows.Scan(&agent, &ip, &created, &seen, &revoked); err != nil {
			rows.Close()
			return nil, fmt.Errorf("privacy: export sessions: %w", err)
		}
		out = append(out, map[string]any{"user_agent": agent, "ip": ip, "signed_in_at": exportTime(created),
			"last_used_at": exportTime(seen), "ended_at": optionalTime(revoked)})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("privacy: export sessions: %w", err)
	}
	return out, nil
}

// loadChats lists every chat the user is or was in (deleted chats aside).
func (w *exportWriter) loadChats() ([]exportChat, error) {
	rows, err := w.s.pool.Query(w.ctx, `
		SELECT c.id, c.type, c.title, m.role, m.joined_at, m.left_at,
			coalesce(CASE WHEN p.user_low = $1 THEN p.user_high ELSE p.user_low END, 0),
			coalesce(o.username, ''), coalesce(o.name, ''),
			coalesce(o.deletion_requested_at IS NOT NULL OR o.deleted_at IS NOT NULL, false)
		FROM chat_members m JOIN chats c ON c.id = m.chat_id
			LEFT JOIN private_chats p ON p.chat_id = c.id
			LEFT JOIN users o ON o.id = CASE WHEN p.user_low = $1 THEN p.user_high ELSE p.user_low END
		WHERE m.user_id = $1 AND c.deleted_at IS NULL AND c.tenant_id = $2
		ORDER BY c.id`, w.job.userID, w.s.cfg.TenantID)
	if err != nil {
		return nil, fmt.Errorf("privacy: export chats: %w", err)
	}
	var out []exportChat
	for rows.Next() {
		var c exportChat
		var joined time.Time
		var left *time.Time
		var peer exportPerson
		if err := rows.Scan(&c.ID, &c.Type, &c.Title, &c.Role, &joined, &left, &peer.ID, &peer.Username, &peer.Name,
			&peer.Deleted); err != nil {
			rows.Close()
			return nil, fmt.Errorf("privacy: export chats: %w", err)
		}
		c.JoinedAt, c.LeftAt = exportTime(joined), optionalTime(left)
		c.File = "messages/" + strconv.FormatInt(c.ID, 10) + ".json"
		if c.Type == "private" {
			c.Role = ""
			switch {
			case peer.ID == w.job.userID:
				c.Type, c.Title = "saved", "Cloud của tôi"
			case peer.Deleted:
				c.Peer = &exportPerson{ID: peer.ID, Deleted: true}
				c.Title = "Tài khoản đã xoá"
			default:
				c.Peer = &peer
				c.Title = peer.Name
			}
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("privacy: export chats: %w", err)
	}
	return out, nil
}

// exportMessage is one message the user sent.
type exportMessage struct {
	Seq       int64             `json:"seq"`
	Date      string            `json:"date"`
	EditedAt  string            `json:"edited_at,omitempty"`
	Text      string            `json:"text"`
	ReplyTo   int64             `json:"reply_to_seq,omitempty"`
	TopicID   int64             `json:"topic_id,omitempty"`
	Forwarded bool              `json:"forwarded,omitempty"`
	Files     []exportFileEntry `json:"files,omitempty"`
}

type exportFileEntry struct {
	Name     string `json:"name"`
	MIME     string `json:"mime_type"`
	Size     int64  `json:"size"`
	Path     string `json:"path,omitempty"`
	Included bool   `json:"included"`
}

// pageMessages calls fn with the user's messages of chat, page by page,
// each with its attached files: the first pass (JSON) decides which files
// go into the ZIP, later passes reuse that decision.
func (w *exportWriter) pageMessages(chatID int64, fn func([]exportMessage) error) error {
	after := int64(0)
	for {
		rows, err := w.s.pool.Query(w.ctx, `
			SELECT m.seq, m.date, m.edit_date, m.text, m.content, m.reply_to_seq, m.topic_id FROM messages m
			WHERE m.chat_id = $1 AND m.from_id = $2 AND m.deleted_at IS NULL AND m.seq > $3
				AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $2 AND h.chat_id = m.chat_id AND h.seq = m.seq)
			ORDER BY m.seq LIMIT $4`, chatID, w.job.userID, after, exportPage)
		if err != nil {
			return fmt.Errorf("privacy: export messages: %w", err)
		}
		var page []exportMessage
		read := 0
		for rows.Next() {
			read++
			var m exportMessage
			var date time.Time
			var edited *time.Time
			var content []byte
			if err := rows.Scan(&m.Seq, &date, &edited, &m.Text, &content, &m.ReplyTo, &m.TopicID); err != nil {
				rows.Close()
				return fmt.Errorf("privacy: export messages: %w", err)
			}
			after = m.Seq
			if len(content) > 0 {
				var msg appv1.Message
				if err := proto.Unmarshal(content, &msg); err != nil {
					rows.Close()
					return fmt.Errorf("privacy: decode message %d/%d: %w", chatID, m.Seq, err)
				}
				if msg.GetAction() != nil {
					continue // service messages are the app's, not the user's
				}
				m.Forwarded = msg.GetForwardFrom() != nil
			}
			m.Date, m.EditedAt = exportTime(date), optionalTime(edited)
			page = append(page, m)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("privacy: export messages: %w", err)
		}
		if len(page) > 0 {
			if err := w.attachFiles(chatID, page); err != nil {
				return err
			}
			if err := fn(page); err != nil {
				return err
			}
		}
		if read < exportPage {
			return nil
		}
	}
}

// attachFiles lists the files of a page of messages. A file seen for the
// first time is put into the ZIP while the size cap allows (and media
// storage is on); otherwise it is listed with included=false.
func (w *exportWriter) attachFiles(chatID int64, page []exportMessage) error {
	seqs := make([]int64, len(page))
	at := make(map[int64]int, len(page))
	for i, m := range page {
		seqs[i] = m.Seq
		at[m.Seq] = i
	}
	rows, err := w.s.pool.Query(w.ctx, `
		SELECT mf.seq, `+media.FileColumns+` FROM message_files mf JOIN files f ON f.id = mf.file_id
		WHERE mf.chat_id = $1 AND mf.seq = ANY($2) AND mf.role = 'media' ORDER BY mf.seq, f.id`, chatID, seqs)
	if err != nil {
		return fmt.Errorf("privacy: export files: %w", err)
	}
	type attached struct {
		seq  int64
		file *media.File
	}
	var found []attached
	for rows.Next() {
		var seq int64
		f, err := media.ScanFile(scanPrefixed{row: rows, first: &seq})
		if err != nil {
			rows.Close()
			return fmt.Errorf("privacy: export files: %w", err)
		}
		found = append(found, attached{seq, f})
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("privacy: export files: %w", err)
	}
	for _, a := range found {
		key := fileKey{chatID, a.seq, a.file.ID}
		path, seen := w.decided[key]
		if !seen {
			if w.s.media != nil && w.mediaSum+a.file.Size <= w.s.cfg.ExportMaxBytes {
				path = w.mediaPath(chatID, a.seq, a.file)
				w.mediaSum += a.file.Size
				w.files = append(w.files, exportFile{file: a.file, path: path})
				w.steps++
			}
			w.decided[key] = path
		}
		i := at[a.seq]
		page[i].Files = append(page[i].Files, exportFileEntry{
			Name: a.file.Name, MIME: a.file.MIME, Size: a.file.Size, Path: path, Included: path != "",
		})
	}
	return nil
}

// scanPrefixed scans a leading column into first, then the rest into the
// destinations ScanFile passes.
type scanPrefixed struct {
	row   pgx.Rows
	first *int64
}

func (p scanPrefixed) Scan(dest ...any) error {
	return p.row.Scan(append([]any{p.first}, dest...)...)
}

// mediaPath is a unique, safe path under media/ for a file.
func (w *exportWriter) mediaPath(chatID, seq int64, f *media.File) string {
	name := safeName(f.Name)
	if name == "" {
		name = strings.ToLower(strings.TrimPrefix(f.Kind.String(), "MEDIA_KIND_"))
	}
	path := fmt.Sprintf("media/%d-%d-%s", chatID, seq, name)
	for n := 2; w.names[path]; n++ {
		path = fmt.Sprintf("media/%d-%d-%d-%s", chatID, seq, n, name)
	}
	w.names[path] = true
	return path
}

// safeName keeps letters, digits, dot, dash and underscore of a file name
// (accents included; spaces become underscores), at most 80 runes, never a
// leading dot.
func safeName(name string) string {
	var b strings.Builder
	n := 0
	for _, r := range name {
		if n >= 80 {
			break
		}
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || r == '-' || r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune('_')
		default:
			continue
		}
		n++
	}
	return strings.TrimLeft(b.String(), ".")
}

func (w *exportWriter) writeMessagesJSON(c *exportChat) (int, error) {
	ew, err := w.entry(c.File)
	if err != nil {
		return 0, err
	}
	count := 0
	if _, err := io.WriteString(ew, "["); err != nil {
		return 0, fmt.Errorf("privacy: write messages: %w", err)
	}
	err = w.pageMessages(c.ID, func(page []exportMessage) error {
		for _, m := range page {
			b, err := json.Marshal(m)
			if err != nil {
				return fmt.Errorf("privacy: encode message: %w", err)
			}
			sep := ",\n"
			if count == 0 {
				sep = "\n"
			}
			if _, err := io.WriteString(ew, sep); err != nil {
				return fmt.Errorf("privacy: write messages: %w", err)
			}
			if _, err := ew.Write(b); err != nil {
				return fmt.Errorf("privacy: write messages: %w", err)
			}
			count++
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	if _, err := io.WriteString(ew, "\n]\n"); err != nil {
		return 0, fmt.Errorf("privacy: write messages: %w", err)
	}
	return count, w.step()
}

// pageWriter writes an HTML page. bufio.Writer keeps the first write error
// and Flush returns it, so the page's writes are checked once, at Flush.
type pageWriter struct{ *bufio.Writer }

func (p pageWriter) printf(format string, args ...any) { _, _ = fmt.Fprintf(p.Writer, format, args...) }

func (p pageWriter) text(s string) { _, _ = p.WriteString(s) }

const htmlHead = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>%s</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:760px;padding:16px;color:#1b2430;background:#fff}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:24px}
.msg{border:1px solid #dde3ea;border-radius:10px;padding:8px 12px;margin:8px 0;overflow-wrap:anywhere}
.meta{color:#5b6b7c;font-size:.8rem}pre{white-space:pre-wrap;margin:4px 0;font:inherit}
table{border-collapse:collapse;width:100%%}td,th{text-align:left;padding:4px 8px;border-bottom:1px solid #dde3ea;vertical-align:top}
a{color:#1d5fd1}
</style></head><body>
`

func (w *exportWriter) writeChatHTML(c *exportChat) error {
	ew, err := w.entry("chats/" + strconv.FormatInt(c.ID, 10) + ".html")
	if err != nil {
		return err
	}
	bw := pageWriter{bufio.NewWriter(ew)}
	bw.printf(htmlHead, html.EscapeString(c.Title))
	bw.printf("<p><a href=\"../index.html\">← Tổng quan</a></p><h1>%s</h1><p class=\"meta\">%d tin bạn đã gửi</p>\n",
		html.EscapeString(c.Title), c.Messages)
	err = w.pageMessages(c.ID, func(page []exportMessage) error {
		for _, m := range page {
			bw.printf("<div class=\"msg\"><div class=\"meta\">#%d · %s", m.Seq, html.EscapeString(m.Date))
			if m.EditedAt != "" {
				bw.text(" · đã sửa")
			}
			if m.Forwarded {
				bw.text(" · chuyển tiếp")
			}
			if m.ReplyTo != 0 {
				bw.printf(" · trả lời #%d", m.ReplyTo)
			}
			bw.text("</div>")
			if m.Text != "" {
				bw.printf("<pre>%s</pre>", html.EscapeString(m.Text))
			}
			for _, f := range m.Files {
				htmlFile(bw, f)
			}
			bw.text("</div>\n")
		}
		return nil
	})
	if err != nil {
		return err
	}
	bw.text("</body></html>\n")
	if err := bw.Flush(); err != nil {
		return fmt.Errorf("privacy: write chat page: %w", err)
	}
	return w.step()
}

func htmlFile(bw pageWriter, f exportFileEntry) {
	label := html.EscapeString(f.Name)
	if label == "" {
		label = html.EscapeString(f.MIME)
	}
	if f.Included {
		bw.printf("<div>📎 <a href=\"../%s\">%s</a> <span class=\"meta\">(%s)</span></div>",
			html.EscapeString(f.Path), label, humanSize(f.Size))
		return
	}
	bw.printf("<div>📎 %s <span class=\"meta\">(%s, không kèm trong bản xuất)</span></div>", label, humanSize(f.Size))
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%d KB", n>>10)
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// copyFiles stores the included files under media/ (already compressed
// formats are stored as they are), after checking the export disk keeps
// MinFreeBytes free.
func (w *exportWriter) copyFiles() error {
	if len(w.files) == 0 {
		return nil
	}
	if free, err := freeBytes(w.s.cfg.ExportDir); err == nil && free-w.mediaSum < w.s.cfg.MinFreeBytes {
		return errExportTooBig
	}
	for _, f := range w.files {
		if err := w.copyFile(f); err != nil {
			return err
		}
		if err := w.step(); err != nil {
			return err
		}
	}
	return nil
}

func (w *exportWriter) copyFile(f exportFile) error {
	r, err := w.s.media.ReadOriginal(w.ctx, f.file)
	if err != nil {
		return fmt.Errorf("privacy: read file %d: %w", f.file.ID, err)
	}
	defer func() { _ = r.Close() }()
	ew, err := w.zip.CreateHeader(&zip.FileHeader{Name: f.path, Method: zip.Store, Modified: w.s.now()})
	if err != nil {
		return fmt.Errorf("privacy: zip entry %s: %w", f.path, err)
	}
	if _, err := io.Copy(ew, r); err != nil {
		return fmt.Errorf("privacy: copy file %d: %w", f.file.ID, err)
	}
	return nil
}

func freeBytes(dir string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

func (w *exportWriter) writeIndex(username, name, email, created string, chats []exportChat, contacts, blocked int) error {
	ew, err := w.entry("index.html")
	if err != nil {
		return err
	}
	bw := pageWriter{bufio.NewWriter(ew)}
	bw.printf(htmlHead, "Dữ liệu của @"+html.EscapeString(username))
	bw.printf("<h1>Dữ liệu cá nhân của %s</h1>\n", html.EscapeString(name))
	bw.text("<table>")
	row := func(k, v string) { bw.printf("<tr><th>%s</th><td>%s</td></tr>", k, html.EscapeString(v)) }
	row("Username", "@"+username)
	if email != "" {
		row("Email", email)
	}
	row("Tạo tài khoản", created)
	row("Xuất lúc", exportTime(w.s.now()))
	row("Danh bạ", strconv.Itoa(contacts)+" người (contacts.json)")
	row("Đã chặn", strconv.Itoa(blocked)+" người (blocked.json)")
	bw.text("</table>\n<h2>Chat</h2>\n<table><tr><th>Chat</th><th>Loại</th><th>Tin bạn gửi</th></tr>\n")
	kinds := map[string]string{"saved": "Cloud của tôi", "private": "Cá nhân", "group": "Nhóm", "channel": "Kênh", "secret": "Bí mật"}
	for _, c := range chats {
		bw.printf("<tr><td><a href=\"chats/%d.html\">%s</a></td><td>%s</td><td>%d</td></tr>\n",
			c.ID, html.EscapeString(c.Title), kinds[c.Type], c.Messages)
	}
	bw.text("</table>\n<p class=\"meta\">Cài đặt, phiên đăng nhập và bot: profile.json, sessions.json, bots.json.</p></body></html>\n")
	if err := bw.Flush(); err != nil {
		return fmt.Errorf("privacy: write index: %w", err)
	}
	return w.step()
}
