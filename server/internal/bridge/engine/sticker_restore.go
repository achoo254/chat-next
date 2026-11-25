package engine

import (
	"context"
	"errors"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
)

// stickerLabel is the text of a sticker imported before stickers were copied.
const stickerLabel = "[Nhãn dán]"

// stickersPerTick bounds the files restored in one turn of the run loop, so
// live messages and the outbox are not held up behind a long restore.
const stickersPerTick = 5

// telegramAdapter is the adapter whose media ref is "<conversation>/<message id>",
// which is all the restore needs to fetch a sticker again.
const telegramAdapter = "telegram"

// queueStickerRestore lists the chats already imported, so their stickers that
// were imported as a label get their picture. Only an adapter whose media ref
// can be built from the message key takes part.
func (r *runner) queueStickerRestore(caughtUp []*chatLink) {
	if r.adapter.Name() != telegramAdapter || r.e.mediaSvc == nil {
		return
	}
	r.stickerQueue = append(r.stickerQueue[:0], caughtUp...)
	r.stickerTried = map[string]bool{}
}

// restoreStickersNext gives up to stickersPerTick label-only stickers of the
// first queued chat their picture, and drops the chat from the queue when none
// is left. A sticker Chat cannot show (animated Lottie) or one that failed is
// tried once per run and keeps its label.
func (r *runner) restoreStickersNext(ctx context.Context) error {
	for len(r.stickerQueue) > 0 {
		l := r.stickerQueue[0]
		if r.links[l.ExternalChat] != l {
			r.stickerQueue = r.stickerQueue[1:]
			continue
		}
		ids, err := r.labelOnlyStickers(ctx, l)
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			r.stickerQueue = r.stickerQueue[1:]
			continue
		}
		for _, id := range ids {
			r.stickerTried[stickerKey(l, id.msg)] = true
			if err := r.restoreSticker(ctx, l, id); err != nil {
				return err
			}
		}
		return nil
	}
	return nil
}

type stickerRow struct {
	msg string
	seq int64
}

func stickerKey(l *chatLink, msg string) string { return l.ExternalChat + "/" + msg }

// labelOnlyStickers reads the newest messages of l that are only the sticker
// label and were not tried in this run.
func (r *runner) labelOnlyStickers(ctx context.Context, l *chatLink) ([]stickerRow, error) {
	tried := make([]string, 0, len(r.stickerTried))
	prefix := stickerKey(l, "")
	for k := range r.stickerTried {
		if len(k) > len(prefix) && k[:len(prefix)] == prefix {
			tried = append(tried, k[len(prefix):])
		}
	}
	rows, err := r.e.db.pool.Query(ctx, `
		SELECT em.external_msg_id, em.seq
		FROM external_messages em
		JOIN messages m ON m.chat_id = em.chat_id AND m.seq = em.seq
		WHERE em.account_id = $1 AND em.external_chat_id = $2
			AND m.deleted_at IS NULL AND m.media_kind = 0 AND m.text = $3
			AND NOT (em.external_msg_id = ANY($4))
		ORDER BY em.seq DESC LIMIT $5`,
		r.account.ID, l.ExternalChat, stickerLabel, tried, stickersPerTick)
	if err != nil {
		return nil, fmt.Errorf("bridge: label-only stickers: %w", err)
	}
	defer rows.Close()
	var out []stickerRow
	for rows.Next() {
		var s stickerRow
		if err := rows.Scan(&s.msg, &s.seq); err != nil {
			return nil, fmt.Errorf("bridge: label-only stickers: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// restoreSticker fetches the sticker again, stores it and replaces the label
// with it. A sticker that cannot be shown or fetched is left as it is.
func (r *runner) restoreSticker(ctx context.Context, l *chatLink, s stickerRow) error {
	stream, err := retryRateLimit(ctx, func() (bridge.MediaStream, error) {
		return r.adapter.FetchMedia(ctx, r.acct, l.ExternalChat+"/"+s.msg)
	})
	var wait *bridge.RateLimitError
	if errors.As(err, &wait) {
		return err
	}
	if err != nil {
		r.logger.Warn("restoring a sticker failed; it keeps its label", "reason", err.Error())
		return nil
	}
	med := bridge.Media{Kind: "sticker", MimeType: stream.MimeType()}
	kind, ok := uploadKind(med)
	if !ok {
		_ = stream.Close()
		return nil
	}
	content, err := r.storeStream(ctx, med, kind, stream)
	if err != nil || content == nil {
		return err
	}
	return r.withLink(ctx, l, func(it *chat.ImportTx) error {
		_, err := it.Edit(ctx, s.seq, chat.ImportMessage{Content: &appv1.Message{Media: content.Media}})
		return err
	})
}
