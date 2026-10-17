package media

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Querier is a pool or a transaction.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Rendition is a stored downscaled copy of a file.
type Rendition struct {
	Type   appv1.MediaSizeType `json:"t"`
	Width  int32               `json:"w"`
	Height int32               `json:"h"`
	Size   int64               `json:"s"`
	Key    string              `json:"k"`
}

// File is a stored file.
type File struct {
	ID          int64
	PublicID    string
	TenantID    string
	OwnerID     int64
	Kind        appv1.MediaKind
	MIME        string
	Size        int64
	Name        string
	Hash        string
	Width       int32
	Height      int32
	DurationMS  int32
	InlineThumb []byte
	Waveform    []byte
	Key         string
	Sizes       []Rendition
}

var kindNames = map[appv1.MediaKind]string{
	appv1.MediaKind_MEDIA_KIND_PHOTO:    "photo",
	appv1.MediaKind_MEDIA_KIND_VIDEO:    "video",
	appv1.MediaKind_MEDIA_KIND_AUDIO:    "audio",
	appv1.MediaKind_MEDIA_KIND_VOICE:    "voice",
	appv1.MediaKind_MEDIA_KIND_DOCUMENT: "document",
}

func kindOf(name string) appv1.MediaKind {
	for k, n := range kindNames {
		if n == name {
			return k
		}
	}
	return appv1.MediaKind_MEDIA_KIND_UNSPECIFIED
}

// FileColumns selects a File from "files f".
const FileColumns = `f.id, f.public_id, f.tenant_id, f.owner_id, f.kind, f.mime_type, f.size, f.file_name, f.file_hash,
	f.width, f.height, f.duration_ms, f.inline_thumb, f.waveform, f.object_key, f.sizes`

// ScanFile reads FileColumns.
func ScanFile(row pgx.Row) (*File, error) {
	f := &File{}
	var kind string
	var sizes []byte
	if err := row.Scan(&f.ID, &f.PublicID, &f.TenantID, &f.OwnerID, &kind, &f.MIME, &f.Size, &f.Name, &f.Hash,
		&f.Width, &f.Height, &f.DurationMS, &f.InlineThumb, &f.Waveform, &f.Key, &sizes); err != nil {
		return nil, err
	}
	f.Kind = kindOf(kind)
	if len(sizes) > 0 {
		if err := json.Unmarshal(sizes, &f.Sizes); err != nil {
			return nil, fmt.Errorf("media: decode sizes of file %d: %w", f.ID, err)
		}
	}
	return f, nil
}

// Ref is the MediaRef clients see.
func (f *File) Ref() *appv1.MediaRef {
	ref := &appv1.MediaRef{
		FileId: f.PublicID, FileHash: f.Hash, Kind: f.Kind, MimeType: f.MIME, Size: f.Size, FileName: f.Name,
		Width: f.Width, Height: f.Height, Duration: f.DurationMS, InlineThumb: f.InlineThumb, Waveform: f.Waveform,
	}
	for _, r := range f.Sizes {
		ref.Sizes = append(ref.Sizes, &appv1.MediaSize{Type: r.Type, Width: r.Width, Height: r.Height, Size: r.Size})
	}
	return ref
}

// rendition returns the stored rendition of type t, if any.
func (f *File) rendition(t appv1.MediaSizeType) (Rendition, bool) {
	for _, r := range f.Sizes {
		if r.Type == t {
			return r, true
		}
	}
	return Rendition{}, false
}

// keys lists every object of the file.
func (f *File) keys() []string {
	keys := []string{f.Key}
	for _, r := range f.Sizes {
		keys = append(keys, r.Key)
	}
	return keys
}

// ValidPublicID reports the shape of a file_id or upload_id.
func ValidPublicID(id string) bool {
	if len(id) != 22 {
		return false
	}
	for _, c := range id {
		alnum := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
		if !alnum && c != '-' && c != '_' {
			return false
		}
	}
	return true
}

// newPublicID returns 128 random bits, base64url (22 characters).
func newPublicID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b) // crypto/rand.Read never fails
	return base64.RawURLEncoding.EncodeToString(b)
}

// ErrFileNotFound reports an unknown file_id (or one of another tenant).
var ErrFileNotFound = connect.NewError(connect.CodeNotFound, errors.New("file not found"))

// LockFile loads a file of tenant by file_id and locks it against garbage
// collection until the transaction ends (FOR SHARE); a message that
// references it must be written in the same transaction.
func LockFile(ctx context.Context, tx Querier, tenant, publicID string) (*File, error) {
	if !ValidPublicID(publicID) {
		return nil, ErrFileNotFound
	}
	f, err := ScanFile(tx.QueryRow(ctx, `SELECT `+FileColumns+` FROM files f WHERE f.public_id = $1 AND f.tenant_id = $2 FOR SHARE`,
		publicID, tenant))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrFileNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("media: load file: %w", err)
	}
	return f, nil
}

// PhotoChat is the chat id of download grants for a profile photo (their
// seq is the photo's user): the largest id a token holds, which no chat
// reaches (it would be the last local id of the last shard).
const PhotoChat = 1<<53 - 1

// PhotoRef is a profile photo as clients see it: they fetch it with
// GetFileUrl's user_photo_of context, in the size they show.
func PhotoRef(fileID string) *appv1.MediaRef {
	return &appv1.MediaRef{FileId: fileID, Kind: appv1.MediaKind_MEDIA_KIND_PHOTO}
}

// LoadFiles loads files of tenant by file_id.
func LoadFiles(ctx context.Context, q Querier, tenant string, publicIDs []string) (map[string]*File, error) {
	out := map[string]*File{}
	if len(publicIDs) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT `+FileColumns+` FROM files f WHERE f.public_id = ANY($1) AND f.tenant_id = $2`,
		publicIDs, tenant)
	if err != nil {
		return nil, fmt.Errorf("media: load files: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		f, err := ScanFile(rows)
		if err != nil {
			return nil, fmt.Errorf("media: load files: %w", err)
		}
		out[f.PublicID] = f
	}
	return out, rows.Err()
}

// File roles in message_files.
const (
	RoleMedia   = "media"
	RolePreview = "preview"
)

// MessageFiles lists the files a message content references, by role.
func MessageFiles(content *appv1.Message) map[string]string {
	out := map[string]string{}
	if id := content.GetMedia().GetFileId(); id != "" {
		out[id] = RoleMedia
	}
	if id := content.GetLinkPreview().GetPhoto().GetFileId(); id != "" {
		if _, ok := out[id]; !ok {
			out[id] = RolePreview
		}
	}
	return out
}

// IndexMessage records which files the message (chat_id, seq) carries,
// replacing what an earlier version recorded. Files of other tenants or
// unknown ids are skipped (the content was validated when written).
func IndexMessage(ctx context.Context, tx Querier, tenant string, chatID, seq int64, content *appv1.Message, replace bool) error {
	if replace {
		if _, err := tx.Exec(ctx, `DELETE FROM message_files WHERE chat_id = $1 AND seq = $2`, chatID, seq); err != nil {
			return fmt.Errorf("media: unindex message: %w", err)
		}
	}
	refs := MessageFiles(content)
	if len(refs) == 0 {
		return nil
	}
	ids := make([]string, 0, len(refs))
	roles := make([]string, 0, len(refs))
	for id, role := range refs {
		ids = append(ids, id)
		roles = append(roles, role)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_files (chat_id, seq, file_id, role)
		SELECT $1, $2, f.id, x.role FROM unnest($3::text[], $4::text[]) AS x(public_id, role)
		JOIN files f ON f.public_id = x.public_id AND f.tenant_id = $5
		ON CONFLICT DO NOTHING`, chatID, seq, ids, roles, tenant); err != nil {
		return fmt.Errorf("media: index message: %w", err)
	}
	return nil
}

// UnindexMessages forgets the files of messages deleted for everyone: their
// download URLs stop working at once.
func UnindexMessages(ctx context.Context, tx Querier, chatID int64, seqs []int64) error {
	if _, err := tx.Exec(ctx, `DELETE FROM message_files WHERE chat_id = $1 AND seq = ANY($2)`, chatID, seqs); err != nil {
		return fmt.Errorf("media: unindex messages: %w", err)
	}
	return nil
}

// FileMessages lists the messages carrying a file as their media.
func FileMessages(ctx context.Context, q Querier, fileID int64) ([][2]int64, error) {
	rows, err := q.Query(ctx, `SELECT chat_id, seq FROM message_files WHERE file_id = $1 AND role = 'media' ORDER BY chat_id, seq`, fileID)
	if err != nil {
		return nil, fmt.Errorf("media: file messages: %w", err)
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) ([2]int64, error) {
		var k [2]int64
		err := r.Scan(&k[0], &k[1])
		return k, err
	})
}
