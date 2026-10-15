package chat

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"slices"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/entities"
	"app.local/server/internal/media"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// errMediaDisabled answers media calls when no storage is configured.
var errMediaDisabled = connect.NewError(connect.CodeFailedPrecondition,
	errors.New("media_disabled: media storage is not configured"))

// validateCaption checks a media caption: text rules of ADR 0004, may be
// empty, at most CaptionLengthMax code points.
func (s *Service) validateCaption(text string, ents []*appv1.MessageEntity) (string, []*appv1.MessageEntity, error) {
	text, ents, err := s.validateText(text, ents, true)
	if err != nil {
		return "", nil, err
	}
	if n := entities.CodePointLength(text); n > s.cfg.CaptionLengthMax {
		return "", nil, errInvalid("caption is longer than %d characters", s.cfg.CaptionLengthMax)
	}
	return text, ents, nil
}

// attachableFile locks a file for a message me sends: me owns it, or can
// see a message that carries it (forwarding by file_id). Anything else,
// including files of another tenant, is "not found".
func (t *txn) attachableFile(ctx context.Context, me int64, fileID string) (*media.File, error) {
	f, err := media.LockFile(ctx, t.tx, t.s.cfg.TenantID, fileID)
	if err != nil {
		return nil, err
	}
	if f.OwnerID == me {
		return f, nil
	}
	var visible bool
	if err := t.tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM message_files mf
			JOIN messages m ON m.chat_id = mf.chat_id AND m.seq = mf.seq AND m.deleted_at IS NULL
			JOIN chat_members cm ON cm.chat_id = mf.chat_id AND cm.user_id = $2 AND cm.visible_from_seq <= mf.seq
				AND (cm.left_at IS NULL OR (cm.left_seq >= mf.seq AND (m.changed_at IS NULL OR m.changed_at <= cm.left_at)))
			WHERE mf.file_id = $1 AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h
				WHERE h.user_id = $2 AND h.chat_id = mf.chat_id AND h.seq = mf.seq))`, f.ID, me).Scan(&visible); err != nil {
		return nil, fmt.Errorf("chat: file access: %w", err)
	}
	if !visible {
		return nil, media.ErrFileNotFound
	}
	return f, nil
}

// SendMedia posts a file with a caption. A retry with the same random_id
// returns the first message and its ack.
func (s *Service) SendMedia(ctx context.Context, me int64, req *appv1.SendMediaRequest) (*appv1.SendMediaResponse, error) {
	if !s.mediaEnabled() {
		return nil, errMediaDisabled
	}
	text, ents, err := s.validateCaption(req.GetText(), req.GetEntities())
	if err != nil {
		return nil, err
	}
	if req.GetRandomId() < 0 {
		return nil, errInvalid("random_id must not be negative")
	}
	if err := s.allow(ctx, limitSend, "send", me); err != nil {
		return nil, err
	}
	chatID := req.GetChatId()
	var (
		posted    *messageRow
		duplicate *sendDedupe
	)
	t, err := s.inTx(ctx, func(t *txn) error {
		posted, duplicate = nil, nil
		c, _, topicID, err := t.mediaTarget(ctx, me, chatID, req.GetTopicId(), req.GetReplyToSeq())
		if err != nil {
			return err
		}
		if duplicate, err = t.claimRandomID(ctx, me, req.GetRandomId(), chatID); err != nil || duplicate != nil {
			return err
		}
		f, err := t.attachableFile(ctx, me, req.GetFileId())
		if err != nil {
			return err
		}
		members, err := t.fanoutMembers(ctx, c)
		if err != nil {
			return err
		}
		ev := t.event(kindMessageNew, chatID, me)
		posted, err = t.postMessage(ctx, ev, c, members, newMessage{
			fromID: me, topicID: topicID, randomID: req.GetRandomId(), replyTo: req.GetReplyToSeq(), text: text,
			content: &appv1.Message{Entities: ents, Media: f.Ref()},
		})
		if err != nil {
			return err
		}
		t.recordRandomID(me, req.GetRandomId(), posted.Seq, chatID)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if duplicate != nil {
		r, err := s.replaySend(ctx, me, duplicate)
		if err != nil {
			return nil, err
		}
		return &appv1.SendMediaResponse{Message: r.GetMessage(), Ack: r.GetAck()}, nil
	}
	msg, err := posted.render(me, nil)
	if err != nil {
		return nil, err
	}
	return &appv1.SendMediaResponse{Message: msg, Ack: t.ack(me, chatID)}, nil
}

// mediaTarget locks the chat and checks me may post media there (and reply
// to replyTo); it returns the topic to post in.
func (t *txn) mediaTarget(ctx context.Context, me, chatID, topic, replyTo int64) (*chatRow, *memberRow, int64, error) {
	c, m, err := t.s.activeChatFor(ctx, t.tx, chatID, me, true)
	if err != nil {
		return nil, nil, 0, err
	}
	topicID, err := t.s.postable(ctx, t.tx, c, m, me, topic)
	if err != nil {
		return nil, nil, 0, err
	}
	if !c.can(m, permMedia) {
		return nil, nil, 0, errDenied("you cannot send media in this chat")
	}
	if err := t.s.checkReply(ctx, t.tx, chatID, replyTo); err != nil {
		return nil, nil, 0, err
	}
	return c, m, topicID, nil
}

// albumGroup classifies a kind for album mixing: photos and videos go
// together; documents only with documents, audio only with audio.
func albumGroup(k appv1.MediaKind) string {
	switch k {
	case appv1.MediaKind_MEDIA_KIND_PHOTO, appv1.MediaKind_MEDIA_KIND_VIDEO:
		return "visual"
	case appv1.MediaKind_MEDIA_KIND_DOCUMENT:
		return "document"
	case appv1.MediaKind_MEDIA_KIND_AUDIO:
		return "audio"
	default:
		return ""
	}
}

// newGroupedID returns a random album id in [1, 2^53).
func newGroupedID() int64 {
	var b [8]byte
	for {
		_, _ = rand.Read(b[:]) // crypto/rand.Read never fails
		if v := int64(binary.BigEndian.Uint64(b[:]) & (1<<53 - 1)); v != 0 {
			return v
		}
	}
}

// SendAlbum posts 2 to AlbumSizeMax files as messages sharing one
// grouped_id, in request order. Items whose random_id was already used come
// back as the messages sent then.
func (s *Service) SendAlbum(ctx context.Context, me int64, req *appv1.SendAlbumRequest) (*appv1.SendAlbumResponse, error) {
	if !s.mediaEnabled() {
		return nil, errMediaDisabled
	}
	items := req.GetItems()
	if len(items) < 2 || len(items) > s.cfg.AlbumSizeMax {
		return nil, errInvalid("an album holds 2 to %d items", s.cfg.AlbumSizeMax)
	}
	type item struct {
		text     string
		ents     []*appv1.MessageEntity
		randomID int64
	}
	parsed := make([]item, len(items))
	seenRandom := map[int64]bool{}
	for i, it := range items {
		text, ents, err := s.validateCaption(it.GetText(), it.GetEntities())
		if err != nil {
			return nil, err
		}
		r := it.GetRandomId()
		if r < 0 || (r != 0 && seenRandom[r]) {
			return nil, errInvalid("random_ids must be distinct and not negative")
		}
		seenRandom[r] = r != 0
		parsed[i] = item{text: text, ents: ents, randomID: r}
	}
	if err := s.allow(ctx, limitSend, "send", me); err != nil {
		return nil, err
	}
	chatID := req.GetChatId()
	groupedID := newGroupedID()
	var posted []*messageRow
	var dup []*sendDedupe
	t, err := s.inTx(ctx, func(t *txn) error {
		posted, dup = nil, nil
		c, _, topicID, err := t.mediaTarget(ctx, me, chatID, req.GetTopicId(), req.GetReplyToSeq())
		if err != nil {
			return err
		}
		files := make([]*media.File, len(items))
		group := ""
		for i, it := range items {
			if files[i], err = t.attachableFile(ctx, me, it.GetFileId()); err != nil {
				return err
			}
			g := albumGroup(files[i].Kind)
			if g == "" || (group != "" && g != group) {
				return errInvalid("an album mixes photos and videos, or holds only documents, or only audio files")
			}
			group = g
		}
		members, err := t.fanoutMembers(ctx, c)
		if err != nil {
			return err
		}
		for i, it := range parsed {
			d, err := t.claimRandomID(ctx, me, it.randomID, chatID)
			if err != nil {
				return err
			}
			if d != nil {
				dup = append(dup, d)
				continue
			}
			replyTo := int64(0)
			if i == 0 {
				replyTo = req.GetReplyToSeq()
			}
			ev := t.event(kindMessageNew, chatID, me)
			p, err := t.postMessage(ctx, ev, c, members, newMessage{
				fromID: me, topicID: topicID, randomID: it.randomID, replyTo: replyTo, groupedID: groupedID, text: it.text,
				content: &appv1.Message{Entities: it.ents, Media: files[i].Ref()},
			})
			if err != nil {
				return err
			}
			t.recordRandomID(me, it.randomID, p.Seq, chatID)
			posted = append(posted, p)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, d := range dup {
		m, err := loadMessages(ctx, s.pool, map[int64][]int64{d.chatID: {d.seq}})
		if err != nil {
			return nil, err
		}
		if row, ok := m[msgKey{d.chatID, d.seq}]; ok {
			posted = append(posted, row)
		}
	}
	slices.SortFunc(posted, func(a, b *messageRow) int { return int(a.Seq - b.Seq) })
	out, _, err := s.renderMessages(ctx, s.pool, me, posted)
	if err != nil {
		return nil, err
	}
	return &appv1.SendAlbumResponse{Messages: out, Ack: t.ack(me, chatID)}, nil
}

// AuthorizeFiles checks, for each request, that viewer may read the file
// through the message given as context: the message is not deleted or
// hidden for viewer, viewer's membership lets them see it, and the message
// carries the file. The result has one entry per request, nil where access
// is refused or the context is not a message.
func (s *Service) AuthorizeFiles(ctx context.Context, viewer int64, reqs []*appv1.GetFileUrlRequest) ([]*media.Access, error) {
	out := make([]*media.Access, len(reqs))
	var ids []string
	var chats, seqs, index []int64
	for i, r := range reqs {
		msg := r.GetMessage()
		if msg == nil || msg.GetChatId() <= 0 || msg.GetSeq() <= 0 || !media.ValidPublicID(r.GetFileId()) {
			continue
		}
		ids = append(ids, r.GetFileId())
		chats = append(chats, msg.GetChatId())
		seqs = append(seqs, msg.GetSeq())
		index = append(index, int64(i))
	}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT x.i, `+media.FileColumns+`
		FROM unnest($1::text[], $2::bigint[], $3::bigint[], $4::bigint[]) AS x(public_id, chat_id, seq, i)
		JOIN files f ON f.public_id = x.public_id AND f.tenant_id = $5
		JOIN message_files mf ON mf.file_id = f.id AND mf.chat_id = x.chat_id AND mf.seq = x.seq
		JOIN messages m ON m.chat_id = x.chat_id AND m.seq = x.seq AND m.deleted_at IS NULL
		JOIN chat_members cm ON cm.chat_id = x.chat_id AND cm.user_id = $6 AND cm.visible_from_seq <= x.seq
			AND (cm.left_at IS NULL OR (cm.left_seq >= x.seq AND (m.changed_at IS NULL OR m.changed_at <= cm.left_at)))
		WHERE NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $6 AND h.chat_id = x.chat_id AND h.seq = x.seq)`,
		ids, chats, seqs, index, s.cfg.TenantID, viewer)
	if err != nil {
		return nil, fmt.Errorf("chat: authorize files: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var i int64
		ff, err := scanIndexedFile(rows, &i)
		if err != nil {
			return nil, fmt.Errorf("chat: authorize files: %w", err)
		}
		if i >= 0 && int(i) < len(reqs) {
			out[i] = &media.Access{File: ff, ChatID: reqs[i].GetMessage().GetChatId(), Seq: reqs[i].GetMessage().GetSeq()}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("chat: authorize files: %w", err)
	}
	return out, nil
}

// indexedRow prefixes a row with an index column for media.ScanFile.
type indexedRow struct {
	rows pgx.Rows
	i    *int64
}

func (r indexedRow) Scan(dest ...any) error {
	return r.rows.Scan(append([]any{r.i}, dest...)...)
}

func scanIndexedFile(rows pgx.Rows, i *int64) (*media.File, error) {
	return media.ScanFile(indexedRow{rows: rows, i: i})
}

// RefreshFile rewrites the messages carrying a file as their media after
// the media worker added to it (poster, duration, waveform), as an edit
// that does not mark them edited, so clients update their copy.
func (s *Service) RefreshFile(ctx context.Context, fileID int64) error {
	keys, err := media.FileMessages(ctx, s.pool, fileID)
	if err != nil {
		return err
	}
	for _, k := range keys {
		_, err := s.inTx(ctx, func(t *txn) error {
			c, err := scanChat(t.tx.QueryRow(ctx, `SELECT `+chatColumns+` FROM `+chatFrom+` WHERE c.id = $1 FOR UPDATE OF c`, k[0]))
			if isNoRows(err) {
				return nil
			}
			if err != nil {
				return fmt.Errorf("chat: lock chat: %w", err)
			}
			m, err := scanMessage(t.tx.QueryRow(ctx, `SELECT `+messageColumns+` FROM messages m WHERE m.chat_id = $1 AND m.seq = $2`, k[0], k[1]))
			if isNoRows(err) {
				return nil
			}
			if err != nil {
				return fmt.Errorf("chat: load message: %w", err)
			}
			if m.Deleted || len(m.Content) == 0 {
				return nil
			}
			content := &appv1.Message{}
			if err := proto.Unmarshal(m.Content, content); err != nil {
				return fmt.Errorf("chat: decode message: %w", err)
			}
			f, err := scanFileByID(ctx, t.tx, fileID)
			if err != nil || f == nil || content.GetMedia().GetFileId() != f.PublicID {
				return err
			}
			ref := f.Ref()
			if proto.Equal(ref, content.GetMedia()) {
				return nil
			}
			content.Media = ref
			return t.rewriteMessage(ctx, c, m.FromID, m, m.Text, content, false, false)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func scanFileByID(ctx context.Context, q querier, id int64) (*media.File, error) {
	f, err := media.ScanFile(q.QueryRow(ctx, `SELECT `+media.FileColumns+` FROM files f WHERE f.id = $1`, id))
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("chat: load file: %w", err)
	}
	return f, nil
}

// FileAccess finds the newest message me can still see that carries the
// file (as its media or link preview photo), for a download URL of the Bot
// API: the same visibility as a download, so a file is only reachable
// through a message that still carries it.
func (s *Service) FileAccess(ctx context.Context, me int64, publicID string) (*media.Access, error) {
	if !media.ValidPublicID(publicID) {
		return nil, media.ErrFileNotFound
	}
	var chatID, seq int64
	f, err := media.ScanFile(prefixedRow{row: s.pool.QueryRow(ctx, `
		SELECT mf.chat_id, mf.seq, `+media.FileColumns+`
		FROM files f
		JOIN message_files mf ON mf.file_id = f.id
		JOIN messages m ON m.chat_id = mf.chat_id AND m.seq = mf.seq AND m.deleted_at IS NULL
		JOIN chat_members cm ON cm.chat_id = mf.chat_id AND cm.user_id = $3 AND cm.visible_from_seq <= mf.seq
			AND (cm.left_at IS NULL OR (cm.left_seq >= mf.seq AND (m.changed_at IS NULL OR m.changed_at <= cm.left_at)))
		WHERE f.public_id = $1 AND f.tenant_id = $2
			AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $3 AND h.chat_id = mf.chat_id AND h.seq = mf.seq)
		ORDER BY m.date DESC, mf.chat_id, mf.seq DESC LIMIT 1`, publicID, s.cfg.TenantID, me), head: []any{&chatID, &seq}})
	if isNoRows(err) {
		return nil, media.ErrFileNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("chat: file access: %w", err)
	}
	return &media.Access{File: f, ChatID: chatID, Seq: seq}, nil
}

// prefixedRow scans leading columns into head, the rest for media.ScanFile.
type prefixedRow struct {
	row  pgx.Row
	head []any
}

func (r prefixedRow) Scan(dest ...any) error {
	return r.row.Scan(append(r.head, dest...)...)
}
