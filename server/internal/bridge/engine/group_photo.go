package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
	"app.local/server/internal/media"
	"github.com/jackc/pgx/v5"
)

// photoLimit is the largest group photo copied into Chat.
const photoLimit = 10 << 20

// syncedPhoto is the other app's id of the photo Chat last took or sent for a chat.
func syncedPhoto(ctx context.Context, q querier, linkID int64) (string, error) {
	var id *string
	if err := q.QueryRow(ctx, `SELECT photo_id FROM external_chats WHERE id = $1`, linkID).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", fmt.Errorf("bridge: synced photo: %w", err)
	}
	if id == nil {
		return "\x00", nil // never synced: differs from any photo, none included
	}
	return *id, nil
}

func setSyncedPhoto(ctx context.Context, q querier, linkID int64, id string) error {
	if _, err := q.Exec(ctx, `UPDATE external_chats SET photo_id = $2 WHERE id = $1`, linkID, id); err != nil {
		return fmt.Errorf("bridge: record synced photo: %w", err)
	}
	return nil
}

// takePhoto makes the chat's photo the one the other app has, when it is not the one
// Chat last took or sent, and Chat has no photo change waiting to go out.
func (r *runner) takePhoto(ctx context.Context, l *chatLink, info bridge.GroupInfo) error {
	have, err := syncedPhoto(ctx, r.e.db.pool, l.ID)
	if err != nil || have == info.PhotoID {
		return err
	}
	if pending, err := pendingOp(ctx, r.e.db.pool, l.ChatID, "set_photo"); err != nil || pending {
		return err
	}
	fileID := ""
	if info.PhotoID != "" {
		if r.e.mediaSvc == nil {
			return nil
		}
		stream, err := retryRateLimit(ctx, func() (bridge.MediaStream, error) { return r.adapter.FetchMedia(ctx, r.acct, info.PhotoRef) })
		var limit *bridge.RateLimitError
		if errors.As(err, &limit) {
			return err // a periodic look: held (skipBusy) and the photo taken at a later look
		}
		if err != nil {
			r.logger.Warn("copying a group photo failed", "chat_id", l.ChatID, "reason", err.Error())
			return nil
		}
		body, unwatch := watched(ctx, stream)
		file, err := r.uploadPaced(ctx, media.StreamUpload{Kind: appv1.MediaKind_MEDIA_KIND_PHOTO, FileName: "photo.jpg", Body: io.LimitReader(body, photoLimit+1), MaxBytes: photoLimit})
		unwatch()
		_ = stream.Close()
		if err != nil {
			r.logger.Warn("storing a group photo failed", "chat_id", l.ChatID, "reason", err.Error())
			return nil
		}
		fileID = file.PublicID
	}
	return r.withLink(ctx, l, func(it *chat.ImportTx) error {
		// Checked again under the lock of the chat: a change Chat queued meanwhile wins.
		if pending, err := pendingOp(ctx, it.Tx(), l.ChatID, "set_photo"); err != nil || pending {
			return err
		}
		if _, err := it.SetPhoto(ctx, fileID); err != nil {
			if isSkippable(err) {
				r.logger.Warn("group photo skipped", "chat_id", l.ChatID, "reason", err.Error())
				return nil
			}
			return err
		}
		return setSyncedPhoto(ctx, it.Tx(), l.ID, info.PhotoID)
	})
}

// doPhoto sends the photo Chat has for a group (none removes it), and records the id
// the other app gave it so the next look does not copy it back.
func (r *runner) doPhoto(ctx context.Context, h *outboxRow) error {
	db := r.e.db
	writer, ok := r.adapter.(bridge.PhotoWriter)
	if !ok {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "photo_unsupported: this app cannot take a group photo from Chat", time.Time{})
	}
	if err := db.startSendingState(ctx, h); err != nil {
		return err
	}
	var p struct {
		FileID string `json:"file_id"`
	}
	if err := json.Unmarshal(h.Payload, &p); err != nil {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "bad payload", time.Time{})
	}
	var photo *bridge.OutMedia
	if p.FileID != "" {
		if r.e.mediaSvc == nil {
			return db.setOutbox(ctx, []int64{h.ID}, "failed", "files_unavailable: this server does not store files", time.Time{})
		}
		files, err := media.LoadFiles(ctx, db.pool, r.e.cfg.TenantID, []string{p.FileID})
		if err != nil {
			return err
		}
		f := files[p.FileID]
		if f == nil {
			return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
		}
		photo = &bridge.OutMedia{Kind: "photo", MimeType: f.MIME, Name: f.Name, Size: f.Size,
			Open: func() (io.ReadCloser, error) { return r.e.mediaSvc.ReadOriginal(ctx, f) }}
	}
	id, err := writer.SetGroupPhoto(ctx, r.acct, h.ExternalChat, photo)
	if err != nil {
		if serr := r.settleCall(ctx, []*outboxRow{h}, err); serr != nil {
			return serr
		}
		return r.putBackAfterFailure(ctx, h)
	}
	if l := r.links[h.ExternalChat]; l != nil {
		if err := setSyncedPhoto(ctx, db.pool, l.ID, id); err != nil {
			return err
		}
	}
	return db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{})
}
