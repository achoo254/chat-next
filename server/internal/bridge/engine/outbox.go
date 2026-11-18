package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
	"app.local/server/internal/media"
	"github.com/jackc/pgx/v5"
)

// The sender works off external_outbox for one account, in the goroutine of
// its runner: sending and handling live events never overlap, so a message
// Chat sent cannot be imported a second time as an event from the other app
// (its key is recorded before the next event is looked at). What a row sends
// is read from the message when the row is due.
//
// Per synced chat the queue is first in, first out. A row waiting for a
// retry holds back the rows behind it in the same chat; a row that failed for
// good (not allowed, too large) does not.

// sendAlbumMax is how many album items go out in one send.
const sendAlbumMax = 10

// outboxRow is a row of external_outbox.
type outboxRow struct {
	ID           int64
	ChatID       int64
	Seq          int64
	ExternalChat string
	Op           string
	RandomID     int64
	Status       string
	Attempts     int
	Due          time.Time
	// Pinned is the state wanted by a pin row.
	Pinned bool
	// Payload is the state wanted by a row of a feature whose change is more than a message number (JSON).
	Payload []byte
}

// outboxHeads returns the oldest queued row of each synced chat of the
// account, oldest first.
func (d *db) outboxHeads(ctx context.Context, accountID int64) ([]*outboxRow, error) {
	rows, err := d.pool.Query(ctx, `
		SELECT id, chat_id, seq, external_chat_id, op, random_id, status, attempts, next_attempt_at, pinned, payload FROM (
			SELECT DISTINCT ON (external_chat_id) * FROM external_outbox
			WHERE account_id = $1 AND status IN ('pending', 'sending') ORDER BY external_chat_id, id
		) h ORDER BY id`, accountID)
	if err != nil {
		return nil, fmt.Errorf("bridge: outbox heads: %w", err)
	}
	return pgx.CollectRows(rows, scanOutbox)
}

// outboxFollowing returns the queued sends of a chat after row id, oldest first.
func (d *db) outboxFollowing(ctx context.Context, accountID int64, externalChat string, afterID int64) ([]*outboxRow, error) {
	rows, err := d.pool.Query(ctx, `
		SELECT id, chat_id, seq, external_chat_id, op, random_id, status, attempts, next_attempt_at, pinned, payload FROM external_outbox
		WHERE account_id = $1 AND external_chat_id = $2 AND id > $3 AND op = 'send' AND status IN ('pending', 'sending')
		ORDER BY id LIMIT $4`, accountID, externalChat, afterID, sendAlbumMax)
	if err != nil {
		return nil, fmt.Errorf("bridge: outbox following: %w", err)
	}
	return pgx.CollectRows(rows, scanOutbox)
}

func scanOutbox(r pgx.CollectableRow) (*outboxRow, error) {
	var o outboxRow
	err := r.Scan(&o.ID, &o.ChatID, &o.Seq, &o.ExternalChat, &o.Op, &o.RandomID, &o.Status, &o.Attempts, &o.Due, &o.Pinned, &o.Payload)
	return &o, err
}

func shortError(msg string) string {
	msg = strings.ToValidUTF8(msg, "")
	if len(msg) > 400 {
		msg = msg[:400]
	}
	return msg
}

// setOutbox moves rows to status; due, when set, is when a pending row may
// be tried again.
//
// A row is only marked sent while it is the call in flight ('sending'). Chat queues a state
// (the name of a topic, closed, pin, mute) by overwriting the row of the same kind and putting
// it back to 'pending' with the newer payload; if that happens while the older payload is on
// its way, marking the row sent would drop the newer one without it ever reaching the other
// app. A row put back to pending stays so and goes out again.
func (d *db) setOutbox(ctx context.Context, ids []int64, status, lastError string, due time.Time) error {
	if due.IsZero() {
		due = time.Now()
	}
	_, err := d.pool.Exec(ctx, `
		UPDATE external_outbox SET status = $2, last_error = $3, next_attempt_at = $4, updated_at = now()
		WHERE id = ANY($1) AND NOT ($2::text = 'sent' AND status = 'pending')`,
		ids, status, shortError(lastError), due)
	if err != nil {
		return fmt.Errorf("bridge: update outbox: %w", err)
	}
	return nil
}

// startSending marks rows as in flight and counts the attempt, before the
// call: a crash during it leaves them 'sending', to be repeated with the same
// random_id.
func (d *db) startSending(ctx context.Context, ids []int64) error {
	_, err := d.pool.Exec(ctx, `UPDATE external_outbox SET status = 'sending', attempts = attempts + 1, updated_at = now() WHERE id = ANY($1)`, ids)
	if err != nil {
		return fmt.Errorf("bridge: mark sending: %w", err)
	}
	return nil
}

// startSendingState is startSending for a row that carries a state (payload, pinned) and
// hands back the state as it is now: Chat overwrites such a row in place when the owner changes
// the same thing again, possibly after the row was read and before it is claimed here, and
// the state read earlier would then be sent instead of the newer one.
func (d *db) startSendingState(ctx context.Context, h *outboxRow) error {
	err := d.pool.QueryRow(ctx, `
		UPDATE external_outbox SET status = 'sending', attempts = attempts + 1, updated_at = now()
		WHERE id = $1 RETURNING payload, pinned`, h.ID).Scan(&h.Payload, &h.Pinned)
	if err != nil {
		return fmt.Errorf("bridge: mark sending: %w", err)
	}
	return nil
}

// forgetStale turns sends that have been in flight too long to repeat on
// their own into 'unknown': they may or may not have gone out, and the user
// decides whether to send them again.
func (d *db) forgetStale(ctx context.Context, accountID int64, after time.Duration) error {
	_, err := d.pool.Exec(ctx, `
		UPDATE external_outbox SET status = 'unknown', last_error = 'unclear whether it was sent', updated_at = now()
		WHERE account_id = $1 AND op = 'send' AND status = 'sending' AND updated_at < now() - make_interval(secs => $2)`,
		accountID, after.Seconds())
	if err != nil {
		return fmt.Errorf("bridge: stale sends: %w", err)
	}
	return nil
}

// externalOf is the key the other app gives a message of Chat, if it has one.
func externalOf(ctx context.Context, q querier, chatID, seq int64) (*messageKey, error) {
	var k messageKey
	err := q.QueryRow(ctx, `SELECT account_id, external_chat_id, external_msg_id FROM external_messages WHERE chat_id = $1 AND seq = $2`, chatID, seq).
		Scan(&k.account, &k.chat, &k.msg)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("bridge: external key: %w", err)
	}
	return &k, nil
}

// participantOf maps a Chat user back to the person of the other app, for
// mentions.
func participantOf(ctx context.Context, q querier, accountID, userID int64) (string, bool) {
	var id string
	err := q.QueryRow(ctx, `SELECT external_user_id FROM external_users WHERE account_id = $1 AND user_id = $2`, accountID, userID).Scan(&id)
	return id, err == nil
}

// outEntityKinds is entityTypes the other way. A kind not listed (Chat's own
// @username mention, anything new) is dropped: the text stays, its styling
// is lost.
var outEntityKinds = func() map[appv1.EntityType]string {
	m := make(map[appv1.EntityType]string, len(entityTypes))
	for kind, t := range entityTypes {
		m[t] = kind
	}
	return m
}()

// outContent turns the text and entities of Chat into what an adapter sends.
func outContent(ctx context.Context, q querier, accountID int64, text string, ents []*appv1.MessageEntity) (string, []bridge.Entity) {
	var out []bridge.Entity
	for _, e := range ents {
		kind, ok := outEntityKinds[e.GetType()]
		if !ok {
			continue
		}
		be := bridge.Entity{Kind: kind, Offset: int(e.GetOffset()), Length: int(e.GetLength()), URL: e.GetUrl()}
		if e.GetType() == appv1.EntityType_ENTITY_TYPE_MENTION_NAME {
			id, known := participantOf(ctx, q, accountID, e.GetUserId())
			if !known {
				continue
			}
			be.Mention = id
		}
		out = append(out, be)
	}
	return text, out
}

// sendDue works through what is due in the outbox of the account.
func (r *runner) sendDue(ctx context.Context) error {
	cfg := r.e.cfg
	if err := r.e.db.forgetStale(ctx, r.account.ID, cfg.SendRetryWindow); err != nil {
		return err
	}
	if time.Now().Before(r.pause) {
		return nil
	}
	heads, err := r.e.db.outboxHeads(ctx, r.account.ID)
	if err != nil {
		return err
	}
	worked := 0
	for _, h := range heads {
		if h.Status == "pending" && h.Due.After(time.Now()) {
			continue
		}
		if worked >= cfg.SendBatch || time.Now().Before(r.pause) {
			break
		}
		if wait := time.Until(r.nextSend); wait > 0 {
			if err := sleep(ctx, wait); err != nil {
				return err
			}
		}
		if err := r.sendRow(ctx, h); err != nil {
			return err
		}
		r.nextSend = time.Now().Add(cfg.SendGap)
		worked++
	}
	return nil
}

// sendRow sends one queued row (an album takes the rows of its items along).
// It returns an error only when the whole run must stop; a failure of one
// message is recorded on its row.
func (r *runner) sendRow(ctx context.Context, h *outboxRow) error {
	owner, run := opHandler(h.Op)
	if owner == nil {
		return r.e.db.setOutbox(ctx, []int64{h.ID}, "failed", "unknown operation", time.Time{})
	}
	// A feature switched off for the chat after the row was queued: nothing goes.
	dir, err := r.e.db.featureDirection(ctx, r.account.ID, h.ExternalChat, owner.feature)
	if err != nil {
		return err
	}
	if !dir.Sends() {
		return r.e.db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
	}
	return run(r, ctx, h)
}

// settleCall records the outcome of a call to the other app on rows and
// returns nil when the run goes on.
func (r *runner) settleCall(ctx context.Context, rows []*outboxRow, err error) error {
	ids := make([]int64, len(rows))
	attempts := 0
	for i, row := range rows {
		ids[i] = row.ID
		attempts = max(attempts, row.Attempts)
	}
	attempts++ // startSending counted this call after the rows were read
	var limit *bridge.RateLimitError
	switch {
	case ctx.Err() != nil:
		return ctx.Err()
	case errors.Is(err, bridge.ErrSessionRevoked):
		_ = r.e.db.setOutbox(ctx, ids, "pending", "", time.Time{})
		return err
	case errors.As(err, &limit):
		r.pause = time.Now().Add(limit.RetryAfter)
		return r.e.db.setOutbox(ctx, ids, "pending", err.Error(), r.pause)
	case errors.Is(err, bridge.ErrNotAllowed), errors.Is(err, bridge.ErrEditExpired), errors.Is(err, bridge.ErrTooLarge):
		return r.e.db.setOutbox(ctx, ids, "failed", err.Error(), time.Time{})
	case attempts >= r.e.cfg.SendAttempts:
		return r.e.db.setOutbox(ctx, ids, "failed", fmt.Sprintf("gave up after %d attempts: %v", attempts, err), time.Time{})
	}
	wait := min(r.e.cfg.BackoffMin<<min(attempts, 16), r.e.cfg.BackoffMax)
	r.logger.Warn("sending to the other app failed; trying again", "attempt", attempts, "wait", wait, "err", err)
	return r.e.db.setOutbox(ctx, ids, "pending", err.Error(), time.Now().Add(wait))
}

// doSend sends the message of h, or the album it starts.
func (r *runner) doSend(ctx context.Context, sender bridge.Sender, h *outboxRow) error {
	db := r.e.db
	first, err := r.e.chat.OutboundMessage(ctx, h.ChatID, h.Seq)
	if err != nil {
		return err
	}
	if first == nil || first.Deleted {
		return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
	}
	rows, outs := []*outboxRow{h}, []*chat.Outbound{first}
	if first.GroupedID != 0 {
		next, err := db.outboxFollowing(ctx, r.account.ID, h.ExternalChat, h.ID)
		if err != nil {
			return err
		}
		for _, n := range next {
			o, err := r.e.chat.OutboundMessage(ctx, n.ChatID, n.Seq)
			if err != nil {
				return err
			}
			if o == nil || o.Deleted || o.GroupedID != first.GroupedID || n.ChatID != h.ChatID {
				break
			}
			rows, outs = append(rows, n), append(outs, o)
		}
	}
	ids := make([]int64, len(rows))
	for i, row := range rows {
		ids[i] = row.ID
	}
	msg, err := r.buildOut(ctx, h, outs)
	if err != nil {
		return db.setOutbox(ctx, ids, "failed", err.Error(), time.Time{})
	}
	if err := db.startSending(ctx, ids); err != nil {
		return err
	}
	ref, err := sender.SendMessage(ctx, r.acct, msg)
	if err != nil {
		return r.settleCall(ctx, rows, err)
	}
	if len(ref.IDs) != len(rows) {
		r.logger.Warn("the other app answered with another number of messages than were sent", "sent", len(rows), "answered", len(ref.IDs))
	}
	return pgx.BeginFunc(ctx, db.pool, func(tx pgx.Tx) error {
		for i, row := range rows {
			if i < len(ref.IDs) {
				if err := insertMessage(ctx, tx, messageKey{r.account.ID, h.ExternalChat, ref.IDs[i]}, row.ChatID, row.Seq, 0, ""); err != nil {
					return err
				}
			}
		}
		_, err := tx.Exec(ctx, `UPDATE external_outbox SET status = 'sent', last_error = '', updated_at = now() WHERE id = ANY($1)`, ids)
		return err
	})
}

// buildOut makes the OutMessage of one message or the items of an album.
func (r *runner) buildOut(ctx context.Context, h *outboxRow, outs []*chat.Outbound) (bridge.OutMessage, error) {
	first := outs[0]
	text, ents := outContent(ctx, r.e.db.pool, r.account.ID, first.Text, first.Entities)
	msg := bridge.OutMessage{Conversation: h.ExternalChat, Text: text, Entities: ents, RandomID: h.RandomID}
	if first.ReplyToSeq > 0 {
		k, err := externalOf(ctx, r.e.db.pool, h.ChatID, first.ReplyToSeq)
		if err != nil {
			return msg, err
		}
		// A message answered that never reached the other app is sent as a
		// plain message rather than not at all.
		if k != nil && k.chat == h.ExternalChat {
			msg.ReplyTo = k.msg
		}
	}
	// In a forum the message goes into the topic it was written in.
	if first.TopicID != 0 {
		ext, ok, err := externalTopic(ctx, r.e.db.pool, r.account.ID, h.ExternalChat, first.TopicID)
		if err != nil {
			return msg, err
		}
		if !ok {
			return msg, errors.New("topic_unmapped: the topic of this message is not known in the other app")
		}
		msg.Topic = ext
	}
	var fileIDs []string
	for _, o := range outs {
		if o.FileID != "" {
			fileIDs = append(fileIDs, o.FileID)
		}
	}
	if len(fileIDs) == 0 {
		return msg, nil
	}
	if r.e.mediaSvc == nil {
		return msg, errors.New("files_unavailable: this server does not store files")
	}
	files, err := media.LoadFiles(ctx, r.e.db.pool, r.e.cfg.TenantID, fileIDs)
	if err != nil {
		return msg, fmt.Errorf("files_unavailable: %w", err)
	}
	for _, id := range fileIDs {
		f := files[id]
		if f == nil {
			return msg, errors.New("files_unavailable: a file of the message is gone")
		}
		msg.Media = append(msg.Media, bridge.OutMedia{
			Kind: outMediaKind(f.Kind), MimeType: f.MIME, Name: f.Name, Size: f.Size, Width: int(f.Width), Height: int(f.Height),
			Duration: time.Duration(f.DurationMS) * time.Millisecond,
			Open:     func() (io.ReadCloser, error) { return r.e.mediaSvc.ReadOriginal(ctx, f) },
		})
	}
	return msg, nil
}

// outMediaKind names a stored file's kind the way an adapter's Media does.
func outMediaKind(k appv1.MediaKind) string {
	switch k {
	case appv1.MediaKind_MEDIA_KIND_PHOTO:
		return "photo"
	case appv1.MediaKind_MEDIA_KIND_VIDEO:
		return "video"
	case appv1.MediaKind_MEDIA_KIND_AUDIO:
		return "audio"
	case appv1.MediaKind_MEDIA_KIND_VOICE:
		return "voice"
	default:
		return "document"
	}
}

// doEdit sends the current text of a message that has already gone out.
func (r *runner) doEdit(ctx context.Context, sender bridge.Sender, h *outboxRow) error {
	db := r.e.db
	o, err := r.e.chat.OutboundMessage(ctx, h.ChatID, h.Seq)
	if err != nil {
		return err
	}
	k, err := externalOf(ctx, db.pool, h.ChatID, h.Seq)
	if err != nil {
		return err
	}
	if o == nil || o.Deleted || k == nil {
		return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
	}
	text, ents := outContent(ctx, db.pool, r.account.ID, o.Text, o.Entities)
	if err := db.startSending(ctx, []int64{h.ID}); err != nil {
		return err
	}
	if err := sender.EditMessage(ctx, r.acct, bridge.EditRequest{Conversation: k.chat, ID: k.msg, Text: text, Entities: ents}); err != nil {
		return r.settleCall(ctx, []*outboxRow{h}, err)
	}
	return db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{})
}

// doDelete deletes, in the other app, a message deleted in Chat.
func (r *runner) doDelete(ctx context.Context, sender bridge.Sender, h *outboxRow) error {
	db := r.e.db
	k, err := externalOf(ctx, db.pool, h.ChatID, h.Seq)
	if err != nil {
		return err
	}
	if k == nil {
		return db.setOutbox(ctx, []int64{h.ID}, "cancelled", "", time.Time{})
	}
	if err := db.startSending(ctx, []int64{h.ID}); err != nil {
		return err
	}
	if err := sender.DeleteMessages(ctx, r.acct, bridge.Delete{Conversation: k.chat, IDs: []string{k.msg}}); err != nil {
		return r.settleCall(ctx, []*outboxRow{h}, err)
	}
	return db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{})
}
