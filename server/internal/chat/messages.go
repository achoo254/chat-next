package chat

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/entities"
	"app.local/server/internal/linkpreview"
	"app.local/server/internal/media"
	"app.local/server/internal/search"
	"github.com/jackc/pgx/v5"
	"github.com/rivo/uniseg"
	"google.golang.org/protobuf/proto"
)

// Limits of message operations.
const (
	entitiesMax      = 100
	seqsPerCallMax   = 100
	historyPageMax   = 200
	historyPageDef   = 50
	pinnedPageDef    = 50
	pinnedPageMax    = 100
	preLanguageMax   = 32
	reactionBytesMax = 32
	previewWorkers   = 8
)

// newMessage is a message to post; content holds the rich parts.
type newMessage struct {
	fromID    int64
	topicID   int64
	randomID  int64
	replyTo   int64
	groupedID int64
	text      string
	content   *appv1.Message
}

// postMessage issues the next seq of a locked chat, stores the message and
// writes message_new to the chat. members are the current members (only
// used for small chats).
func (t *txn) postMessage(ctx context.Context, ev *Event, c *chatRow, members []int64, nm newMessage) (*messageRow, error) {
	if c.Forum && nm.topicID == 0 {
		nm.topicID = generalTopicID
	}
	id, err := t.s.ids.Next()
	if err != nil {
		return nil, fmt.Errorf("chat: message id: %w", err)
	}
	var content []byte
	if nm.content != nil && proto.Size(nm.content) > 0 {
		if content, err = proto.Marshal(nm.content); err != nil {
			return nil, fmt.Errorf("chat: encode message: %w", err)
		}
	}
	m := &messageRow{ChatID: c.ID, TopicID: nm.topicID, FromID: nm.fromID, RandomID: nm.randomID, Text: nm.text,
		Content: content, ReplyToSeq: nm.replyTo, GroupedID: nm.groupedID}
	if err := t.tx.QueryRow(ctx, `
		UPDATE chats SET last_seq = last_seq + 1, last_message_at = now(), updated_at = now() WHERE id = $1
		RETURNING last_seq, now()`, c.ID).Scan(&m.Seq, &m.Date); err != nil {
		return nil, fmt.Errorf("chat: next seq: %w", err)
	}
	sf := search.FieldsOf(c.Type, m.Text, nm.content)
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO messages (chat_id, seq, id, topic_id, from_id, random_id, date, text, content, reply_to_seq, grouped_id,
			search_tsv, search_text, media_kind, has_link)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, `+search.TSVector("$12")+`, $13, $14, $15)`,
		m.ChatID, m.Seq, id, m.TopicID, m.FromID, m.RandomID, m.Date, m.Text, content, m.ReplyToSeq, m.GroupedID,
		sf.Lexemes, sf.Text, sf.MediaKind, sf.HasLink); err != nil {
		return nil, fmt.Errorf("chat: insert message: %w", err)
	}
	if c.Forum {
		if _, err := t.tx.Exec(ctx, `UPDATE forum_topics SET top_seq = $3, message_count = message_count + 1 WHERE chat_id = $1 AND id = $2`,
			c.ID, m.TopicID, m.Seq); err != nil {
			return nil, fmt.Errorf("chat: topic top: %w", err)
		}
	}
	if err := t.recordMentions(ctx, c, m, nm.content, false); err != nil {
		return nil, err
	}
	if len(media.MessageFiles(nm.content)) > 0 {
		if err := media.IndexMessage(ctx, t.tx, t.s.cfg.TenantID, m.ChatID, m.Seq, nm.content, false); err != nil {
			return nil, err
		}
	}
	c.LastSeq = m.Seq
	ev.TopSeq = m.Seq
	update := &appv1.Update{Kind: &appv1.Update_MessageNew{MessageNew: &appv1.UpdateMessageNew{
		Message: &appv1.Message{ChatId: c.ID, Seq: m.Seq},
	}}}
	if err := t.toChat(ctx, ev, c, members, update); err != nil {
		return nil, err
	}
	return m, nil
}

// recordMentions stores who a message mentions or replies to (current
// members other than the author), the source of unread_mentions_count.
// replace drops what an earlier version of the message recorded. Private
// chats, service messages and forwards record nothing.
func (t *txn) recordMentions(ctx context.Context, c *chatRow, m *messageRow, content *appv1.Message, replace bool) error {
	if c.Type == typePrivate || content.GetAction() != nil || content.GetForwardFrom() != nil {
		return nil
	}
	if replace {
		if _, err := t.tx.Exec(ctx, `DELETE FROM message_mentions WHERE chat_id = $1 AND seq = $2`, m.ChatID, m.Seq); err != nil {
			return fmt.Errorf("chat: clear mentions: %w", err)
		}
	}
	var ids []int64
	var names []string
	for _, e := range content.GetEntities() {
		switch e.GetType() {
		case appv1.EntityType_ENTITY_TYPE_MENTION_NAME:
			ids = append(ids, e.GetUserId())
		case appv1.EntityType_ENTITY_TYPE_MENTION:
			name := strings.ToLower(strings.TrimPrefix(utf16Slice(m.Text, int(e.GetOffset()), int(e.GetLength())), "@"))
			if name != "" {
				names = append(names, name)
			}
		default:
		}
	}
	if len(ids) == 0 && len(names) == 0 && m.ReplyToSeq == 0 {
		return nil
	}
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO message_mentions (user_id, chat_id, seq)
		SELECT DISTINCT mem.user_id, $1::bigint, $2::bigint FROM chat_members mem JOIN users u ON u.id = mem.user_id
		WHERE mem.chat_id = $1 AND mem.left_at IS NULL AND mem.user_id <> $3
			AND (mem.user_id = ANY($4) OR u.username = ANY($5)
				OR mem.user_id = (SELECT from_id FROM messages WHERE chat_id = $1 AND seq = $6 AND $6 <> 0))
		ON CONFLICT DO NOTHING`, m.ChatID, m.Seq, m.FromID, ids, names, m.ReplyToSeq); err != nil {
		return fmt.Errorf("chat: record mentions: %w", err)
	}
	return nil
}

// --------------------------------------------------------------- validation

var wireEntityTypes = map[appv1.EntityType]bool{}

func init() {
	for v := range appv1.EntityType_name {
		if v != 0 {
			wireEntityTypes[appv1.EntityType(v)] = true
		}
	}
}

// utf16Slice returns text[offset:offset+length] in UTF-16 code units.
func utf16Slice(text string, offset, length int) string {
	units := utf16.Encode([]rune(text))
	if offset < 0 || length < 0 || offset+length > len(units) {
		return ""
	}
	return string(utf16.Decode(units[offset : offset+length]))
}

// validateText checks a message text and its entities (ADR 0004).
func (s *Service) validateText(text string, ents []*appv1.MessageEntity, allowEmpty bool) (string, []*appv1.MessageEntity, error) {
	if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return "", nil, errInvalid("text is not valid UTF-8")
	}
	if strings.TrimSpace(text) == "" && !allowEmpty {
		return "", nil, errInvalid("message text is empty")
	}
	if n := entities.CodePointLength(text); n > s.cfg.MessageLengthMax {
		return "", nil, errInvalid("message is longer than %d characters", s.cfg.MessageLengthMax)
	}
	if len(ents) > entitiesMax {
		return "", nil, errInvalid("at most %d entities", entitiesMax)
	}
	spans := make([]entities.Span, len(ents))
	out := make([]*appv1.MessageEntity, len(ents))
	for i, e := range ents {
		if !wireEntityTypes[e.GetType()] {
			return "", nil, errInvalid("entity %d has an unknown type", i)
		}
		spans[i] = entities.Span{Offset: int(e.GetOffset()), Length: int(e.GetLength())}
		clean := &appv1.MessageEntity{Type: e.GetType(), Offset: e.GetOffset(), Length: e.GetLength()}
		switch e.GetType() {
		case appv1.EntityType_ENTITY_TYPE_TEXT_LINK:
			if !entities.IsAllowedURL(e.GetUrl(), s.cfg.AppScheme) {
				return "", nil, errInvalid("entity %d links to a URL that is not allowed", i)
			}
			clean.Url = e.GetUrl()
		case appv1.EntityType_ENTITY_TYPE_MENTION_NAME:
			if e.GetUserId() <= 0 {
				return "", nil, errInvalid("entity %d needs a user_id", i)
			}
			clean.UserId = e.GetUserId()
		case appv1.EntityType_ENTITY_TYPE_PRE:
			if utf8.RuneCountInString(e.GetLanguage()) > preLanguageMax {
				return "", nil, errInvalid("entity %d language is too long", i)
			}
			clean.Language = e.GetLanguage()
		default:
		}
		out[i] = clean
	}
	if errs := entities.Validate(text, spans); len(errs) > 0 {
		return "", nil, errInvalid("entity %d is invalid: %s", errs[0].Index, errs[0].Code)
	}
	for i, e := range out {
		if e.GetType() == appv1.EntityType_ENTITY_TYPE_URL {
			if _, ok := entities.NormalizeLinkURL(utf16Slice(text, int(e.GetOffset()), int(e.GetLength())), s.cfg.AppScheme); !ok {
				return "", nil, errInvalid("entity %d links to a URL that is not allowed", i)
			}
		}
	}
	return text, out, nil
}

var bareURL = regexp.MustCompile(`https?://[^\s<>"'` + "`" + `]+`)

// previewURL returns the normalized first web link of a message, or "".
func (s *Service) previewURL(text string, ents []*appv1.MessageEntity) string {
	sorted := slices.Clone(ents)
	slices.SortStableFunc(sorted, func(a, b *appv1.MessageEntity) int { return int(a.GetOffset() - b.GetOffset()) })
	for _, e := range sorted {
		var raw string
		switch e.GetType() {
		case appv1.EntityType_ENTITY_TYPE_URL:
			raw, _ = entities.NormalizeLinkURL(utf16Slice(text, int(e.GetOffset()), int(e.GetLength())), s.cfg.AppScheme)
		case appv1.EntityType_ENTITY_TYPE_TEXT_LINK:
			raw = e.GetUrl()
		default:
			continue
		}
		if u, err := linkpreview.NormalizeURL(raw); err == nil {
			return u
		}
	}
	if m := bareURL.FindString(text); m != "" {
		m = strings.TrimRight(m, ".,;:!?)]}")
		if u, err := linkpreview.NormalizeURL(m); err == nil {
			return u
		}
	}
	return ""
}

// cachedPreview returns the cached preview of url, and whether the server
// should still fetch it after the message is stored.
func (s *Service) cachedPreview(ctx context.Context, url string) (*appv1.LinkPreview, bool) {
	if url == "" {
		return nil, false
	}
	p, found, err := s.previews.Cached(ctx, url)
	if err != nil {
		s.logger.Warn("link preview cache read failed", "err", err)
		return nil, false
	}
	if !found {
		return nil, true
	}
	if p.Empty() {
		return nil, false
	}
	lp := &appv1.LinkPreview{Url: p.URL, SiteName: p.SiteName, Title: p.Title, Description: p.Description}
	if p.ImageURL == "" || s.media == nil {
		return lp, false
	}
	photo, known, err := s.media.CachedPreviewPhoto(ctx, p.ImageURL)
	if err != nil {
		s.logger.Warn("link preview photo cache read failed", "err", err)
		return lp, false
	}
	if photo != nil {
		lp.Photo = photo.Ref()
	}
	// Text now; the photo is fetched after the message is stored.
	return lp, !known
}

// ------------------------------------------------------------------- send

// peerBlockedMe reports whether the other participant of a private chat
// blocked me (false for other chats).
func peerBlockedMe(ctx context.Context, q querier, c *chatRow, me int64) (bool, error) {
	if c.Type != typePrivate {
		return false, nil
	}
	var blocked bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2)`,
		c.peerOf(me), me).Scan(&blocked); err != nil {
		return false, fmt.Errorf("chat: check block: %w", err)
	}
	return blocked, nil
}

// postable checks that me may post in the chat (and topic).
func (s *Service) postable(ctx context.Context, q querier, c *chatRow, m *memberRow, me, topicID int64) (int64, error) {
	if !c.can(m, permSend) {
		return 0, errDenied("you cannot send messages in this chat")
	}
	if err := s.checkUnrestricted(ctx, q, me); err != nil {
		return 0, err
	}
	blocked, err := peerBlockedMe(ctx, q, c, me)
	if err != nil {
		return 0, err
	}
	if blocked {
		return 0, errDenied("this user does not accept your messages")
	}
	if !c.Forum {
		if topicID != 0 {
			return 0, errInvalid("this chat has no topics")
		}
		return 0, nil
	}
	if topicID == 0 {
		topicID = generalTopicID
	}
	var closed bool
	err = q.QueryRow(ctx, `SELECT closed FROM forum_topics WHERE chat_id = $1 AND id = $2`, c.ID, topicID).Scan(&closed)
	if isNoRows(err) {
		return 0, errNotFound("topic")
	}
	if err != nil {
		return 0, fmt.Errorf("chat: load topic: %w", err)
	}
	if closed && !m.isAdmin() {
		return 0, errDenied("this topic is closed")
	}
	return topicID, nil
}

// SendMessage posts a text message. A retry with the same random_id returns
// the first message and its ack instead of posting again.
func (s *Service) SendMessage(ctx context.Context, me int64, req *appv1.SendMessageRequest) (*appv1.SendMessageResponse, error) {
	text, ents, err := s.validateText(req.GetText(), req.GetEntities(), false)
	if err != nil {
		return nil, err
	}
	if req.GetRandomId() < 0 {
		return nil, errInvalid("random_id must not be negative")
	}
	if err := s.allow(limitSend, "send", me); err != nil {
		return nil, err
	}
	url := ""
	if !req.GetNoLinkPreview() {
		url = s.previewURL(text, ents)
	}
	preview, fetchLater := s.cachedPreview(ctx, url)
	chatID := req.GetChatId()
	var (
		posted    *messageRow
		duplicate *sendDedupe
	)
	t, err := s.inTx(ctx, func(t *txn) error {
		posted, duplicate = nil, nil
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if duplicate, err = t.claimRandomID(ctx, me, req.GetRandomId(), chatID); err != nil || duplicate != nil {
			return err
		}
		topicID, err := s.postable(ctx, t.tx, c, m, me, req.GetTopicId())
		if err != nil {
			return err
		}
		if err := s.checkReply(ctx, t.tx, chatID, req.GetReplyToSeq()); err != nil {
			return err
		}
		members, err := t.fanoutMembers(ctx, c)
		if err != nil {
			return err
		}
		ev := t.event(kindMessageNew, chatID, me)
		posted, err = t.postMessage(ctx, ev, c, members, newMessage{
			fromID: me, topicID: topicID, randomID: req.GetRandomId(), replyTo: req.GetReplyToSeq(), text: text,
			content: &appv1.Message{Entities: ents, LinkPreview: preview},
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
		return s.replaySend(ctx, me, duplicate)
	}
	if fetchLater {
		s.attachPreviewLater(chatID, posted.Seq, posted.EditVersion, url)
	}
	msg, err := posted.render(me, nil)
	if err != nil {
		return nil, err
	}
	return &appv1.SendMessageResponse{Message: msg, Ack: t.ack(me, chatID)}, nil
}

// fanoutMembers returns the members a small chat writes to; large chats
// write to their own log and need no list.
func (t *txn) fanoutMembers(ctx context.Context, c *chatRow) ([]int64, error) {
	if c.SyncMode == syncLarge {
		return nil, nil
	}
	return activeMembers(ctx, t.tx, c.ID)
}

// fanoutSeeing is fanoutMembers for an update about message seq: only the
// members whose history visibility includes it.
func (t *txn) fanoutSeeing(ctx context.Context, c *chatRow, seq int64) ([]int64, error) {
	if c.SyncMode == syncLarge {
		return nil, nil
	}
	rows, err := t.tx.Query(ctx, `
		SELECT user_id FROM chat_members WHERE chat_id = $1 AND left_at IS NULL AND visible_from_seq <= $2
		ORDER BY user_id`, c.ID, seq)
	if err != nil {
		return nil, fmt.Errorf("chat: list members: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: list members: %w", err)
	}
	return ids, nil
}

func (s *Service) checkReply(ctx context.Context, q querier, chatID, replyTo int64) error {
	if replyTo == 0 {
		return nil
	}
	var ok bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messages WHERE chat_id = $1 AND seq = $2 AND deleted_at IS NULL)`,
		chatID, replyTo).Scan(&ok); err != nil {
		return fmt.Errorf("chat: check reply: %w", err)
	}
	if !ok {
		return errInvalid("the message to reply to does not exist")
	}
	return nil
}

// sendDedupe is a send already done under a random_id.
type sendDedupe struct {
	chatID, seq, pts, chatPts int64
}

// claimRandomID reserves (me, randomID) for this send, or returns the send
// that already holds it. A concurrent send with the same id waits for this
// transaction and then sees its row.
func (t *txn) claimRandomID(ctx context.Context, me, randomID, chatID int64) (*sendDedupe, error) {
	if randomID == 0 {
		return nil, nil
	}
	tag, err := t.tx.Exec(ctx, `
		INSERT INTO send_dedupe (sender_id, random_id, chat_id, seq) VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`,
		me, randomID, chatID)
	if err != nil {
		return nil, fmt.Errorf("chat: claim random_id: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return nil, nil
	}
	d := &sendDedupe{}
	if err := t.tx.QueryRow(ctx, `SELECT chat_id, seq, pts, chat_pts FROM send_dedupe WHERE sender_id = $1 AND random_id = $2`,
		me, randomID).Scan(&d.chatID, &d.seq, &d.pts, &d.chatPts); err != nil {
		return nil, fmt.Errorf("chat: read random_id: %w", err)
	}
	if d.chatID != chatID {
		return nil, errInvalid("random_id was already used in another chat")
	}
	return d, nil
}

// recordRandomID stores the seq and the sender's log positions once they
// are known (after pts allocation).
func (t *txn) recordRandomID(me, randomID, seq, chatID int64) {
	if randomID == 0 {
		return
	}
	t.beforeWrite = append(t.beforeWrite, func(ctx context.Context) error {
		a := t.ack(me, chatID)
		_, err := t.tx.Exec(ctx, `UPDATE send_dedupe SET seq = $3, pts = $4, chat_pts = $5 WHERE sender_id = $1 AND random_id = $2`,
			me, randomID, seq, a.GetPts(), a.GetChatPts())
		if err != nil {
			return fmt.Errorf("chat: record random_id: %w", err)
		}
		return nil
	})
}

// replaySend answers a repeated send with the first message and its ack.
func (s *Service) replaySend(ctx context.Context, me int64, d *sendDedupe) (*appv1.SendMessageResponse, error) {
	msgs, err := loadMessages(ctx, s.pool, map[int64][]int64{d.chatID: {d.seq}})
	if err != nil {
		return nil, err
	}
	resp := &appv1.SendMessageResponse{Ack: &appv1.SyncAck{ServerEpoch: s.Epoch(), Pts: d.pts, ChatPts: d.chatPts}}
	if d.pts > 0 {
		resp.Ack.PtsCount = 1
	}
	if d.chatPts > 0 {
		resp.Ack.ChatPtsCount = 1
	}
	if m, ok := msgs[msgKey{d.chatID, d.seq}]; ok && !m.Deleted {
		rendered, _, err := s.renderMessages(ctx, s.pool, me, []*messageRow{m})
		if err != nil {
			return nil, err
		}
		resp.Message = rendered[0]
	} else {
		resp.Message = &appv1.Message{ChatId: d.chatID, Seq: d.seq, FromId: me}
	}
	return resp, nil
}

// attachPreviewLater fetches a link preview after the message is stored and
// attaches it as an edit that does not mark the message edited.
func (s *Service) attachPreviewLater(chatID, seq int64, version int32, url string) {
	s.mu.Lock()
	if s.previewSlots == nil {
		s.previewSlots = make(chan struct{}, previewWorkers)
	}
	slots := s.previewSlots
	s.mu.Unlock()
	select {
	case slots <- struct{}{}:
	default:
		return // busy: the message simply has no preview
	}
	s.background.Add(1)
	go func() {
		defer s.background.Done()
		defer func() { <-slots }()
		ctx, cancel := context.WithTimeout(s.stopCtx, linkpreview.DefaultTimeout+5*time.Second)
		defer cancel()
		p, err := s.previews.Get(ctx, url)
		if err != nil {
			s.logger.Warn("link preview failed", "err", err)
			return
		}
		if p.Empty() {
			return
		}
		lp := &appv1.LinkPreview{Url: p.URL, SiteName: p.SiteName, Title: p.Title, Description: p.Description}
		if p.ImageURL != "" && s.media != nil {
			photo, err := s.media.PreviewPhoto(ctx, p.ImageURL, s.previews.FetchImage)
			if err != nil {
				s.logger.Warn("link preview photo failed", "err", err)
			} else if photo != nil {
				lp.Photo = photo.Ref()
			}
		}
		if err := s.setPreview(ctx, chatID, seq, version, lp); err != nil {
			s.logger.Warn("attaching link preview failed", "chat_id", chatID, "seq", seq, "err", err)
		}
	}()
}

func (s *Service) setPreview(ctx context.Context, chatID, seq int64, version int32, lp *appv1.LinkPreview) error {
	_, err := s.inTx(ctx, func(t *txn) error {
		c, err := scanChat(t.tx.QueryRow(ctx, `SELECT `+chatColumns+` FROM `+chatFrom+` WHERE c.id = $1 FOR UPDATE OF c`, chatID))
		if err != nil {
			return fmt.Errorf("chat: lock chat: %w", err)
		}
		m, err := scanMessage(t.tx.QueryRow(ctx, `SELECT `+messageColumns+` FROM messages m WHERE m.chat_id = $1 AND m.seq = $2`, chatID, seq))
		if err != nil {
			return fmt.Errorf("chat: load message: %w", err)
		}
		if m.Deleted || m.EditVersion != version {
			return nil // edited or deleted meanwhile; the edit decides
		}
		content := &appv1.Message{}
		if len(m.Content) > 0 {
			if err := proto.Unmarshal(m.Content, content); err != nil {
				return fmt.Errorf("chat: decode message: %w", err)
			}
		}
		if proto.Equal(content.GetLinkPreview(), lp) {
			return nil
		}
		content.LinkPreview = lp
		return t.rewriteMessage(ctx, c, m.FromID, m, m.Text, content, false, false)
	})
	return err
}

// rewriteMessage stores new content for a message and writes message_edit.
// markEdited sets edit_date; a server-side change (link preview) does not.
// notify asks clients to notify as for a new message (an integration alert
// changed state).
func (t *txn) rewriteMessage(ctx context.Context, c *chatRow, actor int64, m *messageRow, text string, content *appv1.Message, markEdited, notify bool) error {
	var raw []byte
	if proto.Size(content) > 0 {
		var err error
		if raw, err = proto.Marshal(content); err != nil {
			return fmt.Errorf("chat: encode message: %w", err)
		}
	}
	sf := search.FieldsOf(c.Type, text, content)
	if err := t.tx.QueryRow(ctx, `
		UPDATE messages SET text = $3, content = $4, edit_version = edit_version + 1,
			edit_date = CASE WHEN $5 THEN now() ELSE edit_date END, changed_at = now(),
			search_tsv = `+search.TSVector("$6")+`, search_text = $7, media_kind = $8, has_link = $9
		WHERE chat_id = $1 AND seq = $2 RETURNING edit_version, edit_date, changed_at`,
		m.ChatID, m.Seq, text, raw, markEdited, sf.Lexemes, sf.Text, sf.MediaKind, sf.HasLink).Scan(&m.EditVersion, &m.EditDate, &m.ChangedAt); err != nil {
		return fmt.Errorf("chat: edit message: %w", err)
	}
	m.Text, m.Content = text, raw
	// The files the message carries may change (a link preview photo).
	if err := media.IndexMessage(ctx, t.tx, t.s.cfg.TenantID, m.ChatID, m.Seq, content, true); err != nil {
		return err
	}
	if markEdited {
		if err := t.recordMentions(ctx, c, m, content, true); err != nil {
			return err
		}
	}
	members, err := t.fanoutSeeing(ctx, c, m.Seq)
	if err != nil {
		return err
	}
	ev := t.event(kindMessageEdit, c.ID, actor)
	return t.toChat(ctx, ev, c, members, &appv1.Update{Kind: &appv1.Update_MessageEdit{MessageEdit: &appv1.UpdateMessageEdit{
		Message: &appv1.Message{ChatId: m.ChatID, Seq: m.Seq}, Notify: notify,
	}}})
}

// ------------------------------------------------------------------- edit

// EditMessage changes the text of one of my messages within the edit
// window.
func (s *Service) EditMessage(ctx context.Context, me int64, req *appv1.EditMessageRequest) (*appv1.EditMessageResponse, error) {
	// May be empty: a media message's caption can be removed (checked
	// below once the message is loaded).
	text, ents, err := s.validateText(req.GetText(), req.GetEntities(), true)
	if err != nil {
		return nil, err
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	if err := s.checkUnrestricted(ctx, s.pool, me); err != nil {
		return nil, err
	}
	url := ""
	if !req.GetNoLinkPreview() {
		url = s.previewURL(text, ents)
	}
	preview, fetchLater := s.cachedPreview(ctx, url)
	chatID, seq := req.GetChatId(), req.GetSeq()
	var edited *messageRow
	t, err := s.inTx(ctx, func(t *txn) error {
		c, mem, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		m, err := s.liveMessage(ctx, t.tx, chatID, seq)
		if err != nil {
			return err
		}
		if m.FromID != me {
			return errDenied("you can only edit your own messages")
		}
		if !c.can(mem, permSend) {
			return errDenied("you cannot send messages in this chat")
		}
		if time.Since(m.Date) > s.cfg.EditTimeLimit {
			return errPrecondition("this message is too old to edit")
		}
		content := &appv1.Message{}
		if len(m.Content) > 0 {
			if err := proto.Unmarshal(m.Content, content); err != nil {
				return fmt.Errorf("chat: decode message: %w", err)
			}
		}
		if content.GetAction() != nil {
			return errInvalid("service messages cannot be edited")
		}
		if content.GetMedia() != nil {
			// Captions have their own limit and never get a link preview.
			if _, _, err := s.validateCaption(text, ents); err != nil {
				return err
			}
			preview, fetchLater = nil, false
		} else if strings.TrimSpace(text) == "" {
			return errInvalid("message text is empty")
		}
		if m.Text == text && proto.Equal(&appv1.Message{Entities: content.GetEntities()}, &appv1.Message{Entities: ents}) &&
			(content.GetMedia() != nil || req.GetNoLinkPreview() == (content.GetLinkPreview() == nil)) {
			edited = m
			return nil
		}
		content.Entities, content.LinkPreview = ents, preview
		if err := t.rewriteMessage(ctx, c, me, m, text, content, true, false); err != nil {
			return err
		}
		edited = m
		return nil
	})
	if err != nil {
		return nil, err
	}
	if fetchLater {
		s.attachPreviewLater(chatID, seq, edited.EditVersion, url)
	}
	rendered, _, err := s.renderMessages(ctx, s.pool, me, []*messageRow{edited})
	if err != nil {
		return nil, err
	}
	return &appv1.EditMessageResponse{Message: rendered[0], Ack: t.ack(me, chatID)}, nil
}

// liveMessage loads a message that is not deleted.
func (s *Service) liveMessage(ctx context.Context, q querier, chatID, seq int64) (*messageRow, error) {
	m, err := scanMessage(q.QueryRow(ctx, `SELECT `+messageColumns+` FROM messages m WHERE m.chat_id = $1 AND m.seq = $2`, chatID, seq))
	if isNoRows(err) || (err == nil && m.Deleted) {
		return nil, errNotFound("message")
	}
	if err != nil {
		return nil, fmt.Errorf("chat: load message: %w", err)
	}
	return m, nil
}

// ----------------------------------------------------------------- delete

// DeleteMessages deletes messages for everyone (authors; admins in groups
// and channels; either side of a private chat) or hides them for me.
func (s *Service) DeleteMessages(ctx context.Context, me, chatID int64, seqs []int64, forEveryone bool) (*appv1.SyncAck, error) {
	seqs = uniqueSorted(seqs)
	if len(seqs) == 0 || len(seqs) > seqsPerCallMax {
		return nil, errInvalid("seqs must hold 1 to %d messages", seqsPerCallMax)
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, forEveryone)
		if err != nil {
			return err
		}
		if !forEveryone {
			return t.hideMessages(ctx, c, m, me, seqs)
		}
		return t.deleteMessages(ctx, c, c.Type == typePrivate || m.isAdmin(), me, seqs)
	})
	if err != nil {
		return nil, err
	}
	return t.ack(me, chatID), nil
}

func (t *txn) hideMessages(ctx context.Context, c *chatRow, m *memberRow, me int64, seqs []int64) error {
	rows, err := t.tx.Query(ctx, `
		INSERT INTO user_hidden_messages (user_id, chat_id, seq)
		SELECT $1, $2, s FROM unnest($3::bigint[]) s
		WHERE EXISTS (SELECT 1 FROM messages WHERE chat_id = $2 AND seq = s AND deleted_at IS NULL AND seq >= $4)
		ON CONFLICT DO NOTHING RETURNING seq`, me, c.ID, seqs, m.VisibleFrom)
	if err != nil {
		return fmt.Errorf("chat: hide messages: %w", err)
	}
	hidden, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return fmt.Errorf("chat: hide messages: %w", err)
	}
	if len(hidden) == 0 {
		return nil
	}
	slices.Sort(hidden)
	ev := t.event(kindMessageHidden, c.ID, me)
	t.toUsers(ev, []int64{me}, &appv1.Update{Kind: &appv1.Update_MessageHidden{MessageHidden: &appv1.UpdateMessageHidden{
		ChatId: c.ID, Seqs: hidden,
	}}})
	return nil
}

// deleteMessages deletes (recalls) messages of a locked chat for everyone:
// any author's when anyone, else only me's. Their content goes; the rows
// stay as recalled placeholders in everyone's history.
func (t *txn) deleteMessages(ctx context.Context, c *chatRow, anyone bool, me int64, seqs []int64) error {
	rows, err := t.tx.Query(ctx, `
		UPDATE messages SET deleted_at = now(), text = '', content = NULL, search_tsv = ''::tsvector, search_text = '', media_kind = 0, has_link = false
		WHERE chat_id = $1 AND seq = ANY($2) AND deleted_at IS NULL AND ($3 OR from_id = $4)
		RETURNING seq, topic_id`, c.ID, seqs, anyone, me)
	if err != nil {
		return fmt.Errorf("chat: delete messages: %w", err)
	}
	type gone struct{ seq, topic int64 }
	deleted, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (gone, error) {
		var g gone
		err := r.Scan(&g.seq, &g.topic)
		return g, err
	})
	if err != nil {
		return fmt.Errorf("chat: delete messages: %w", err)
	}
	if len(deleted) == 0 {
		var exists bool
		if err := t.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messages WHERE chat_id = $1 AND seq = ANY($2) AND deleted_at IS NULL)`,
			c.ID, seqs).Scan(&exists); err != nil {
			return fmt.Errorf("chat: delete messages: %w", err)
		}
		if exists {
			return errDenied("you can only delete your own messages here")
		}
		return nil
	}
	var done, deletedTopics []int64
	topics := map[int64]bool{}
	for _, g := range deleted {
		done = append(done, g.seq)
		topics[g.topic] = true
		deletedTopics = append(deletedTopics, g.topic)
	}
	slices.Sort(done)
	// Download URLs of the messages' files stop working with this commit.
	if err := media.UnindexMessages(ctx, t.tx, c.ID, done); err != nil {
		return err
	}
	if _, err := t.tx.Exec(ctx, `DELETE FROM message_reactions WHERE chat_id = $1 AND seq = ANY($2)`, c.ID, done); err != nil {
		return fmt.Errorf("chat: delete reactions: %w", err)
	}
	if c.Forum {
		if _, err := t.tx.Exec(ctx, `
			UPDATE forum_topics t SET top_seq = coalesce((SELECT max(seq) FROM messages
					WHERE chat_id = t.chat_id AND topic_id = t.id AND deleted_at IS NULL), 0),
				message_count = greatest(t.message_count - (SELECT count(*) FROM unnest($3::bigint[]) d WHERE d = t.id), 0)
			WHERE t.chat_id = $1 AND t.id = ANY($2)`, c.ID, sortedKeys(topics), deletedTopics); err != nil {
			return fmt.Errorf("chat: topic tops: %w", err)
		}
	}
	members, err := t.fanoutMembers(ctx, c)
	if err != nil {
		return err
	}
	ev := t.event(kindMessageDelete, c.ID, me)
	unpinned, err := t.unpinGone(ctx, c, done)
	if err != nil {
		return err
	}
	if err := t.toChat(ctx, ev, c, members, &appv1.Update{Kind: &appv1.Update_MessageDelete{MessageDelete: &appv1.UpdateMessageDelete{
		ChatId: c.ID, Seqs: done, Recalled: true,
	}}}); err != nil {
		return err
	}
	for _, seq := range unpinned {
		if err := t.toChat(ctx, ev, c, members, &appv1.Update{Kind: &appv1.Update_Pin{Pin: &appv1.UpdatePin{ChatId: c.ID, Seq: seq}}}); err != nil {
			return err
		}
	}
	return nil
}

// unpinGone drops pins of deleted messages and recomputes the chat's pinned
// seq; it returns the seqs that were pinned.
func (t *txn) unpinGone(ctx context.Context, c *chatRow, seqs []int64) ([]int64, error) {
	rows, err := t.tx.Query(ctx, `DELETE FROM pinned_messages WHERE chat_id = $1 AND seq = ANY($2) RETURNING seq`, c.ID, seqs)
	if err != nil {
		return nil, fmt.Errorf("chat: unpin deleted: %w", err)
	}
	unpinned, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("chat: unpin deleted: %w", err)
	}
	if len(unpinned) > 0 {
		if err := t.refreshPinned(ctx, c); err != nil {
			return nil, err
		}
	}
	return unpinned, nil
}

func (t *txn) refreshPinned(ctx context.Context, c *chatRow) error {
	return t.tx.QueryRow(ctx, `
		UPDATE chats SET pinned_seq = coalesce((SELECT max(seq) FROM pinned_messages WHERE chat_id = $1), 0) WHERE id = $1
		RETURNING pinned_seq`, c.ID).Scan(&c.PinnedSeq)
}

func uniqueSorted(xs []int64) []int64 {
	out := slices.Clone(xs)
	slices.Sort(out)
	out = slices.Compact(out)
	return slices.DeleteFunc(out, func(x int64) bool { return x <= 0 })
}

// ---------------------------------------------------------- forward, copy

// ForwardMessages re-posts messages into another chat with a forward
// header.
func (s *Service) ForwardMessages(ctx context.Context, me int64, req *appv1.ForwardMessagesRequest) (*appv1.ForwardMessagesResponse, error) {
	seqs := req.GetSeqs()
	if len(seqs) == 0 || len(seqs) > seqsPerCallMax {
		return nil, errInvalid("seqs must hold 1 to %d messages", seqsPerCallMax)
	}
	if len(req.GetRandomIds()) != 0 && len(req.GetRandomIds()) != len(seqs) {
		return nil, errInvalid("random_ids must match seqs")
	}
	return s.repost(ctx, me, req.GetFromChatId(), seqs, req.GetToChatId(), req.GetToTopicId(), req.GetRandomIds(), true, nil)
}

// CopyMessage re-posts a message's content without a forward header,
// optionally with new text.
func (s *Service) CopyMessage(ctx context.Context, me int64, req *appv1.CopyMessageRequest) (*appv1.CopyMessageResponse, error) {
	var override *textOverride
	if req.Text != nil {
		text, ents, err := s.validateText(req.GetText(), req.GetEntities(), false)
		if err != nil {
			return nil, err
		}
		override = &textOverride{text: text, entities: ents, replyTo: req.GetReplyToSeq()}
	} else if req.GetReplyToSeq() != 0 {
		override = &textOverride{keep: true, replyTo: req.GetReplyToSeq()}
	}
	var randomIDs []int64
	if req.GetRandomId() != 0 {
		randomIDs = []int64{req.GetRandomId()}
	}
	resp, err := s.repost(ctx, me, req.GetFromChatId(), []int64{req.GetSeq()}, req.GetToChatId(), req.GetToTopicId(), randomIDs, false, override)
	if err != nil {
		return nil, err
	}
	out := &appv1.CopyMessageResponse{Ack: resp.GetAck()}
	if len(resp.GetMessages()) > 0 {
		out.Message = resp.GetMessages()[0]
	}
	return out, nil
}

type textOverride struct {
	keep     bool
	text     string
	entities []*appv1.MessageEntity
	replyTo  int64
}

func (s *Service) repost(ctx context.Context, me, fromChat int64, seqs []int64, toChat, toTopic int64, randomIDs []int64, forward bool, override *textOverride) (*appv1.ForwardMessagesResponse, error) {
	for _, r := range randomIDs {
		if r < 0 {
			return nil, errInvalid("random_id must not be negative")
		}
	}
	if err := s.allow(limitSend, "send", me); err != nil {
		return nil, err
	}
	src, srcMember, err := s.activeChatFor(ctx, s.pool, fromChat, me, false)
	if err != nil {
		return nil, err
	}
	msgs, err := loadMessages(ctx, s.pool, map[int64][]int64{fromChat: seqs})
	if err != nil {
		return nil, err
	}
	hidden, err := loadHidden(ctx, s.pool, []int64{me}, map[int64][]int64{fromChat: seqs})
	if err != nil {
		return nil, err
	}
	authors := map[int64]string{}
	var sources []*messageRow
	for _, seq := range seqs {
		m, ok := msgs[msgKey{fromChat, seq}]
		if !ok || m.Deleted || m.Seq < srcMember.VisibleFrom || hidden[hiddenKey{me, msgKey{fromChat, seq}}] {
			return nil, errNotFound("message")
		}
		sources = append(sources, m)
		authors[m.FromID] = ""
	}
	users, err := loadUsers(ctx, s.pool, s.cfg.TenantID, sortedKeys(boolSet(authors)))
	if err != nil {
		return nil, err
	}
	var posted []*messageRow
	var dup []*sendDedupe
	t, err := s.inTx(ctx, func(t *txn) error {
		posted, dup = nil, nil
		c, m, err := s.activeChatFor(ctx, t.tx, toChat, me, true)
		if err != nil {
			return err
		}
		topicID, err := s.postable(ctx, t.tx, c, m, me, toTopic)
		if err != nil {
			return err
		}
		members, err := t.fanoutMembers(ctx, c)
		if err != nil {
			return err
		}
		for i, src0 := range sources {
			var randomID int64
			if i < len(randomIDs) {
				randomID = randomIDs[i]
			}
			d, err := t.claimRandomID(ctx, me, randomID, toChat)
			if err != nil {
				return err
			}
			if d != nil {
				dup = append(dup, d)
				continue
			}
			content := &appv1.Message{}
			if len(src0.Content) > 0 {
				if err := proto.Unmarshal(src0.Content, content); err != nil {
					return fmt.Errorf("chat: decode message: %w", err)
				}
			}
			if content.GetAction() != nil {
				return errInvalid("service messages cannot be forwarded")
			}
			text, replyTo := src0.Text, int64(0)
			if forward {
				if content.GetForwardFrom() == nil {
					header := &appv1.ForwardHeader{FromSeq: src0.Seq, Date: src0.Date.Unix()}
					if src.Type == typeChannel {
						header.FromChatId = src.ID
						header.FromName = src.Title
					} else {
						header.FromUserId = src0.FromID
						if u := users[src0.FromID]; u != nil {
							header.FromName = u.Name
						}
					}
					content.ForwardFrom = header
				}
			} else {
				content.ForwardFrom = nil
				if override != nil {
					if !override.keep {
						text, content.Entities, content.LinkPreview = override.text, override.entities, nil
					}
					replyTo = override.replyTo
				}
			}
			if err := s.checkReply(ctx, t.tx, toChat, replyTo); err != nil {
				return err
			}
			ev := t.event(kindMessageNew, toChat, me)
			p, err := t.postMessage(ctx, ev, c, members, newMessage{
				fromID: me, topicID: topicID, randomID: randomID, replyTo: replyTo, text: text, content: content,
			})
			if err != nil {
				return err
			}
			t.recordRandomID(me, randomID, p.Seq, toChat)
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
	return &appv1.ForwardMessagesResponse{Messages: out, Ack: t.ack(me, toChat)}, nil
}

func boolSet[V any](m map[int64]V) map[int64]bool {
	out := make(map[int64]bool, len(m))
	for k := range m {
		out[k] = true
	}
	return out
}

// ---------------------------------------------------------------- history

// GetHistory pages through the messages me can see (respecting
// visible_from_seq and messages hidden for me), optionally of one forum
// topic. Messages deleted for everyone come as recalled placeholders.
func (s *Service) GetHistory(ctx context.Context, me int64, req *appv1.GetHistoryRequest) (*appv1.GetHistoryResponse, error) {
	c, m, err := s.activeChatFor(ctx, s.pool, req.GetChatId(), me, false)
	if err != nil {
		return nil, err
	}
	limit := int(req.GetLimit())
	if limit <= 0 {
		limit = historyPageDef
	}
	limit = min(limit, historyPageMax)
	topic := req.GetTopicId()
	if topic != 0 && !c.Forum {
		return nil, errInvalid("this chat has no topics")
	}
	offset := req.GetOffsetSeq()
	if offset < 0 {
		return nil, errInvalid("offset_seq must not be negative")
	}
	h := historyQuery{s: s, chatID: c.ID, me: me, visibleFrom: m.VisibleFrom, topic: topic}
	var page []*messageRow
	resp := &appv1.GetHistoryResponse{}
	switch req.GetDirection() {
	case appv1.HistoryDirection_HISTORY_DIRECTION_NEWER:
		rows, err := h.fetch(ctx, "m.seq > $5", "ASC", offset, limit+1)
		if err != nil {
			return nil, err
		}
		resp.HasNewer = len(rows) > limit
		page = rows[:min(len(rows), limit)]
		pivot := offset + 1
		if len(page) > 0 {
			pivot = page[0].Seq
		}
		if resp.HasOlder, err = h.exists(ctx, "m.seq < $5", pivot); err != nil {
			return nil, err
		}
	case appv1.HistoryDirection_HISTORY_DIRECTION_AROUND:
		half := (limit + 1) / 2
		before, err := h.fetch(ctx, "m.seq <= $5", "DESC", offset, half+1)
		if err != nil {
			return nil, err
		}
		after, err := h.fetch(ctx, "m.seq > $5", "ASC", offset, limit-half+1)
		if err != nil {
			return nil, err
		}
		resp.HasOlder = len(before) > half
		resp.HasNewer = len(after) > limit-half
		before = before[:min(len(before), half)]
		slices.Reverse(before)
		page = append(before, after[:min(len(after), limit-half)]...)
	default:
		upper := offset
		if upper == 0 {
			upper = 1 << 53
		}
		rows, err := h.fetch(ctx, "m.seq < $5", "DESC", upper, limit+1)
		if err != nil {
			return nil, err
		}
		resp.HasOlder = len(rows) > limit
		page = rows[:min(len(rows), limit)]
		slices.Reverse(page)
		if offset != 0 {
			pivot := offset - 1
			if len(page) > 0 {
				pivot = page[len(page)-1].Seq
			}
			if resp.HasNewer, err = h.exists(ctx, "m.seq > $5", pivot); err != nil {
				return nil, err
			}
		}
	}
	resp.Messages, resp.Users, err = s.renderMessages(ctx, s.pool, me, page)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

type historyQuery struct {
	s           *Service
	chatID, me  int64
	visibleFrom int64
	topic       int64
}

const historyVisible = `m.chat_id = $1 AND m.seq >= $2 AND ($4 = 0 OR m.topic_id = $4)
	AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $3 AND h.chat_id = m.chat_id AND h.seq = m.seq)`

func (h historyQuery) fetch(ctx context.Context, cond, order string, bound int64, limit int) ([]*messageRow, error) {
	rows, err := h.s.pool.Query(ctx, `SELECT `+messageColumns+` FROM messages m WHERE `+historyVisible+` AND `+cond+`
		ORDER BY m.seq `+order+` LIMIT $6`, h.chatID, h.visibleFrom, h.me, h.topic, bound, limit)
	if err != nil {
		return nil, fmt.Errorf("chat: history: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*messageRow, error) { return scanMessage(r) })
	if err != nil {
		return nil, fmt.Errorf("chat: history: %w", err)
	}
	return list, nil
}

func (h historyQuery) exists(ctx context.Context, cond string, bound int64) (bool, error) {
	var ok bool
	err := h.s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messages m WHERE `+historyVisible+` AND `+cond+`)`,
		h.chatID, h.visibleFrom, h.me, h.topic, bound).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("chat: history: %w", err)
	}
	return ok, nil
}

// ------------------------------------------------------------------- read

// ReadHistory moves my read position. In a forum, topic_id reads one topic
// and 0 reads every topic. Readers' own sessions get read (inbox); in small
// chats the authors of the newly read messages get read (outbox).
func (s *Service) ReadHistory(ctx context.Context, me, chatID, maxSeq, topicID int64) (*appv1.SyncAck, error) {
	if maxSeq <= 0 {
		return nil, errInvalid("max_seq is required")
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, false)
		if err != nil {
			return err
		}
		if topicID != 0 && !c.Forum {
			return errInvalid("this chat has no topics")
		}
		maxSeq = min(maxSeq, c.LastSeq)
		return t.read(ctx, c, m, maxSeq, topicID)
	})
	if err != nil {
		return nil, err
	}
	return t.ack(me, chatID), nil
}

func (t *txn) read(ctx context.Context, c *chatRow, m *memberRow, maxSeq, topicID int64) error {
	me := m.UserID
	// Reading the chat clears a "marked as unread", even when the position
	// does not move.
	if m.UnreadMark {
		if err := t.setUnreadMark(ctx, c.ID, me, false); err != nil {
			return err
		}
	}
	// Topics whose position moves, with their old positions.
	topics := []int64{0}
	switch {
	case c.Forum && topicID != 0:
		var exists bool
		if err := t.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM forum_topics WHERE chat_id = $1 AND id = $2)`,
			c.ID, topicID).Scan(&exists); err != nil {
			return fmt.Errorf("chat: load topic: %w", err)
		}
		if !exists {
			return errNotFound("topic")
		}
		topics = []int64{topicID}
	case c.Forum:
		// Only topics with something newer than their read position move,
		// so a read of the whole forum writes one row per unread topic.
		rows, err := t.tx.Query(ctx, `
			SELECT t.id FROM forum_topics t
			LEFT JOIN chat_read_states r ON r.chat_id = t.chat_id AND r.user_id = $2 AND r.topic_id = t.id
			WHERE t.chat_id = $1 AND t.top_seq > greatest(coalesce(r.read_inbox_max_seq, 0), $3)
			ORDER BY t.id`, c.ID, me, m.JoinedSeq)
		if err != nil {
			return fmt.Errorf("chat: list topics: %w", err)
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil {
			return fmt.Errorf("chat: list topics: %w", err)
		}
		topics = ids
	}
	// Old positions (rows lock in topic order: one member's own rows).
	rows, err := t.tx.Query(ctx, `
		SELECT x.topic, coalesce(r.read_inbox_max_seq, 0) FROM unnest($3::bigint[]) AS x(topic)
		LEFT JOIN chat_read_states r ON r.chat_id = $1 AND r.user_id = $2 AND r.topic_id = x.topic
		ORDER BY x.topic`, c.ID, me, topics)
	if err != nil {
		return fmt.Errorf("chat: read positions: %w", err)
	}
	old := map[int64]int64{}
	for rows.Next() {
		var topic, pos int64
		if err := rows.Scan(&topic, &pos); err != nil {
			rows.Close()
			return fmt.Errorf("chat: read positions: %w", err)
		}
		old[topic] = max(pos, m.JoinedSeq)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("chat: read positions: %w", err)
	}
	var moved []int64
	for _, topic := range topics {
		if maxSeq > old[topic] {
			moved = append(moved, topic)
		}
	}
	if len(moved) == 0 {
		return nil
	}
	write := append(slices.Clone(moved), 0)
	if _, err := t.tx.Exec(ctx, `
		INSERT INTO chat_read_states (chat_id, user_id, topic_id, read_inbox_max_seq)
		SELECT $1, $2, x, $4 FROM unnest($3::bigint[]) x ORDER BY x
		ON CONFLICT (chat_id, user_id, topic_id) DO UPDATE
			SET read_inbox_max_seq = greatest(chat_read_states.read_inbox_max_seq, excluded.read_inbox_max_seq), updated_at = now()`,
		c.ID, me, uniqueSorted0(write), maxSeq); err != nil {
		return fmt.Errorf("chat: move read position: %w", err)
	}
	// Read dates for GetMessageReaders, where read receipts are kept.
	if c.Type == typeGroup && int(c.MemberCount) <= t.s.cfg.ReadReceiptsMemberMax {
		if _, err := t.tx.Exec(ctx, `
			INSERT INTO read_receipts (chat_id, topic_id, user_id, max_seq)
			SELECT $1, x, $2, $4 FROM unnest($3::bigint[]) x ORDER BY x
			ON CONFLICT DO NOTHING`, c.ID, me, moved, maxSeq); err != nil {
			return fmt.Errorf("chat: read receipts: %w", err)
		}
	}
	ev := t.event(kindRead, c.ID, me)
	// Outbox reads: in small chats, the authors of messages just read.
	if c.SyncMode == syncSmall {
		lowest := maxSeq
		for _, topic := range moved {
			lowest = min(lowest, old[topic])
		}
		authorRows, err := t.tx.Query(ctx, `
			SELECT from_id, max(seq) FROM messages
			WHERE chat_id = $1 AND seq > $2 AND seq <= $3 AND from_id <> $4 AND deleted_at IS NULL
				AND ($5::bigint[] IS NULL OR topic_id = ANY($5))
			GROUP BY from_id`, c.ID, lowest, maxSeq, me, topicFilter(c, topicID))
		if err != nil {
			return fmt.Errorf("chat: newly read authors: %w", err)
		}
		reads := map[int64]int64{}
		for authorRows.Next() {
			var author, seq int64
			if err := authorRows.Scan(&author, &seq); err != nil {
				authorRows.Close()
				return fmt.Errorf("chat: newly read authors: %w", err)
			}
			reads[author] = seq
		}
		authorRows.Close()
		if err := authorRows.Err(); err != nil {
			return fmt.Errorf("chat: newly read authors: %w", err)
		}
		if len(reads) > 0 {
			authors := sortedKeys(boolSet(reads))
			seqs := make([]int64, len(authors))
			for i, a := range authors {
				seqs[i] = reads[a]
			}
			// Locks the authors' member rows in user id order.
			upd, err := t.tx.Query(ctx, `
				WITH x AS (SELECT * FROM unnest($2::bigint[], $3::bigint[]) AS x(user_id, seq)),
				locked AS (SELECT m.user_id FROM chat_members m JOIN x USING (user_id)
					WHERE m.chat_id = $1 AND m.left_at IS NULL AND m.read_outbox_max_seq < x.seq
					ORDER BY m.user_id FOR UPDATE OF m)
				UPDATE chat_members m SET read_outbox_max_seq = x.seq FROM x, locked
				WHERE m.chat_id = $1 AND m.user_id = x.user_id AND m.user_id = locked.user_id
				RETURNING m.user_id, m.read_outbox_max_seq`, c.ID, authors, seqs)
			if err != nil {
				return fmt.Errorf("chat: outbox reads: %w", err)
			}
			type moved struct{ user, seq int64 }
			list, err := pgx.CollectRows(upd, func(r pgx.CollectableRow) (moved, error) {
				var x moved
				err := r.Scan(&x.user, &x.seq)
				return x, err
			})
			if err != nil {
				return fmt.Errorf("chat: outbox reads: %w", err)
			}
			for _, x := range list {
				t.toUsers(ev, []int64{x.user}, &appv1.Update{Kind: &appv1.Update_Read{Read: &appv1.UpdateRead{
					ChatId: c.ID, MaxSeq: x.seq, Outbox: true,
				}}})
			}
		}
	}
	inbox := &appv1.UpdateRead{ChatId: c.ID, MaxSeq: maxSeq, TopicId: topicID}
	t.toUsers(ev, []int64{me}, &appv1.Update{Kind: &appv1.Update_Read{Read: inbox}})
	// Counted after pts allocation: every message whose update precedes this
	// read in my log is committed by then and counted (ADR 0002 ordering).
	t.beforeWrite = append(t.beforeWrite, func(ctx context.Context) error {
		rs, err := t.s.readState(ctx, t.tx, c, m)
		if err != nil {
			return err
		}
		inbox.UnreadCount, inbox.TopSeq = rs.unread, rs.topSeq
		if c.SyncMode == syncLarge {
			inbox.ChatPts = rs.chatPts
		}
		if topicID != 0 {
			n, err := t.s.topicUnread(ctx, t.tx, c.ID, m, topicID)
			if err != nil {
				return err
			}
			inbox.TopicUnreadCount = n
		}
		return nil
	})
	return nil
}

func topicFilter(c *chatRow, topicID int64) []int64 {
	if c.Forum && topicID != 0 {
		return []int64{topicID}
	}
	return nil
}

func uniqueSorted0(xs []int64) []int64 {
	out := slices.Clone(xs)
	slices.Sort(out)
	return slices.Compact(out)
}

// ----------------------------------------------------------------- pins

// PinMessage pins a message and posts the pinned-message service message.
func (s *Service) PinMessage(ctx context.Context, me, chatID, seq int64) (*appv1.SyncAck, error) {
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if !c.can(m, permPin) {
			return errDenied("you cannot pin messages in this chat")
		}
		target, err := s.liveMessage(ctx, t.tx, chatID, seq)
		if err != nil {
			return err
		}
		if isService(target) {
			return errInvalid("service messages cannot be pinned")
		}
		tag, err := t.tx.Exec(ctx, `INSERT INTO pinned_messages (chat_id, seq) VALUES ($1, $2) ON CONFLICT DO NOTHING`, chatID, seq)
		if err != nil {
			return fmt.Errorf("chat: pin: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		if err := t.refreshPinned(ctx, c); err != nil {
			return fmt.Errorf("chat: pin: %w", err)
		}
		members, err := t.fanoutMembers(ctx, c)
		if err != nil {
			return err
		}
		ev := t.event(kindPin, chatID, me)
		if err := t.toChat(ctx, ev, c, members, &appv1.Update{Kind: &appv1.Update_Pin{Pin: &appv1.UpdatePin{
			ChatId: chatID, Seq: seq, Pinned: true,
		}}}); err != nil {
			return err
		}
		_, err = t.postMessage(ctx, ev, c, members, newMessage{fromID: me, topicID: target.TopicID, content: &appv1.Message{
			Action: &appv1.MessageAction{Kind: &appv1.MessageAction_MessagePinned{MessagePinned: &appv1.ActionMessagePinned{Seq: seq}}},
		}})
		return err
	})
	if err != nil {
		return nil, err
	}
	return t.ack(me, chatID), nil
}

// UnpinMessage unpins a message.
func (s *Service) UnpinMessage(ctx context.Context, me, chatID, seq int64) (*appv1.SyncAck, error) {
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if !c.can(m, permPin) {
			return errDenied("you cannot unpin messages in this chat")
		}
		tag, err := t.tx.Exec(ctx, `DELETE FROM pinned_messages WHERE chat_id = $1 AND seq = $2`, chatID, seq)
		if err != nil {
			return fmt.Errorf("chat: unpin: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		if err := t.refreshPinned(ctx, c); err != nil {
			return fmt.Errorf("chat: unpin: %w", err)
		}
		members, err := t.fanoutMembers(ctx, c)
		if err != nil {
			return err
		}
		ev := t.event(kindPin, chatID, me)
		return t.toChat(ctx, ev, c, members, &appv1.Update{Kind: &appv1.Update_Pin{Pin: &appv1.UpdatePin{ChatId: chatID, Seq: seq}}})
	})
	if err != nil {
		return nil, err
	}
	return t.ack(me, chatID), nil
}

// UnpinAllMessages unpins every pinned message of the chat, or of one forum
// topic, with one pin update.
func (s *Service) UnpinAllMessages(ctx context.Context, me, chatID, topicID int64) (*appv1.SyncAck, error) {
	if topicID < 0 {
		return nil, errInvalid("topic_id must not be negative")
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		if !c.can(m, permPin) {
			return errDenied("you cannot unpin messages in this chat")
		}
		if topicID != 0 && !c.Forum {
			return errInvalid("this chat has no topics")
		}
		rows, err := t.tx.Query(ctx, `
			DELETE FROM pinned_messages p USING messages msg
			WHERE p.chat_id = $1 AND msg.chat_id = p.chat_id AND msg.seq = p.seq AND ($2 = 0 OR msg.topic_id = $2)
			RETURNING p.seq`, chatID, topicID)
		if err != nil {
			return fmt.Errorf("chat: unpin all: %w", err)
		}
		unpinned, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil {
			return fmt.Errorf("chat: unpin all: %w", err)
		}
		if len(unpinned) == 0 {
			return nil
		}
		slices.Sort(unpinned)
		if err := t.refreshPinned(ctx, c); err != nil {
			return fmt.Errorf("chat: unpin all: %w", err)
		}
		members, err := t.fanoutMembers(ctx, c)
		if err != nil {
			return err
		}
		ev := t.event(kindPin, chatID, me)
		return t.toChat(ctx, ev, c, members, &appv1.Update{Kind: &appv1.Update_Pin{Pin: &appv1.UpdatePin{
			ChatId: chatID, Seqs: unpinned,
		}}})
	})
	if err != nil {
		return nil, err
	}
	return t.ack(me, chatID), nil
}

// pinnedVisible is the condition of a pinned message (p, message m) that
// user $4 sees in chat $1: within their history ($2 = visible_from_seq),
// in topic $3 (0 = any) and not hidden for them.
const pinnedVisible = `p.chat_id = $1 AND m.chat_id = p.chat_id AND m.seq = p.seq AND m.deleted_at IS NULL
	AND m.seq >= $2 AND ($3 = 0 OR m.topic_id = $3)
	AND NOT EXISTS (SELECT 1 FROM user_hidden_messages h WHERE h.user_id = $4 AND h.chat_id = m.chat_id AND h.seq = m.seq)`

// GetPinnedMessages lists the pinned messages I can see, newest first,
// optionally of one forum topic, with their total count.
func (s *Service) GetPinnedMessages(ctx context.Context, me int64, req *appv1.GetPinnedMessagesRequest) (*appv1.GetPinnedMessagesResponse, error) {
	c, m, err := s.activeChatFor(ctx, s.pool, req.GetChatId(), me, false)
	if err != nil {
		return nil, err
	}
	topic := req.GetTopicId()
	if topic < 0 || (topic != 0 && !c.Forum) {
		return nil, errInvalid("this chat has no such topic")
	}
	offset := req.GetOffsetSeq()
	if offset < 0 {
		return nil, errInvalid("offset_seq must not be negative")
	}
	if offset == 0 {
		offset = 1 << 53
	}
	limit := pageLimit(req.GetLimit(), pinnedPageDef, pinnedPageMax)
	resp := &appv1.GetPinnedMessagesResponse{}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM pinned_messages p, messages m WHERE `+pinnedVisible,
		c.ID, m.VisibleFrom, topic, me).Scan(&resp.Count); err != nil {
		return nil, fmt.Errorf("chat: count pinned: %w", err)
	}
	rows, err := s.pool.Query(ctx, `SELECT `+messageColumns+` FROM pinned_messages p, messages m WHERE `+pinnedVisible+`
		AND m.seq < $5 ORDER BY m.seq DESC LIMIT $6`, c.ID, m.VisibleFrom, topic, me, offset, limit+1)
	if err != nil {
		return nil, fmt.Errorf("chat: pinned messages: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*messageRow, error) { return scanMessage(r) })
	if err != nil {
		return nil, fmt.Errorf("chat: pinned messages: %w", err)
	}
	if len(list) > limit {
		list = list[:limit]
		resp.HasMore = true
	}
	resp.Messages, resp.Users, err = s.renderMessages(ctx, s.pool, me, list)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func isService(m *messageRow) bool {
	if len(m.Content) == 0 {
		return false
	}
	content := &appv1.Message{}
	return proto.Unmarshal(m.Content, content) == nil && content.GetAction() != nil
}

// -------------------------------------------------------------- reactions

func validEmoji(e string) bool {
	if e == "" || len(e) > reactionBytesMax || !utf8.ValidString(e) || uniseg.GraphemeClusterCount(e) != 1 {
		return false
	}
	r, _ := utf8.DecodeRuneInString(e)
	// Emoji live outside ASCII; refuse letters, digits and controls.
	return r >= 0x80 && !strings.ContainsFunc(e, func(r rune) bool { return r < 0x20 })
}

// SetReaction sets (or with an empty emoji removes) my reaction.
func (s *Service) SetReaction(ctx context.Context, me, chatID, seq int64, emoji string) (*appv1.SetReactionResponse, error) {
	if emoji != "" && !validEmoji(emoji) {
		return nil, errInvalid("reaction must be one emoji")
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	if err := s.checkUnrestricted(ctx, s.pool, me); err != nil {
		return nil, err
	}
	t, err := s.inTx(ctx, func(t *txn) error {
		c, m, err := s.activeChatFor(ctx, t.tx, chatID, me, true)
		if err != nil {
			return err
		}
		target, err := s.liveMessage(ctx, t.tx, chatID, seq)
		if err != nil {
			return err
		}
		if target.Seq < m.VisibleFrom || isService(target) {
			return errNotFound("message")
		}
		blocked, err := peerBlockedMe(ctx, t.tx, c, me)
		if err != nil {
			return err
		}
		if blocked {
			return errDenied("this user does not accept your reactions")
		}
		var tag interface{ RowsAffected() int64 }
		if emoji == "" {
			tag, err = t.tx.Exec(ctx, `DELETE FROM message_reactions WHERE chat_id = $1 AND seq = $2 AND user_id = $3`, chatID, seq, me)
		} else {
			tag, err = t.tx.Exec(ctx, `
				INSERT INTO message_reactions (chat_id, seq, user_id, emoji) VALUES ($1, $2, $3, $4)
				ON CONFLICT (chat_id, seq, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = now()
				WHERE message_reactions.emoji <> excluded.emoji`, chatID, seq, me, emoji)
		}
		if err != nil {
			return fmt.Errorf("chat: set reaction: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		members, err := t.fanoutSeeing(ctx, c, seq)
		if err != nil {
			return err
		}
		ev := t.event(kindReaction, chatID, me)
		return t.toChat(ctx, ev, c, members, &appv1.Update{Kind: &appv1.Update_Reaction{Reaction: &appv1.UpdateReaction{
			ChatId: chatID, Seq: seq,
		}}})
	})
	if err != nil {
		return nil, err
	}
	key := map[int64][]int64{chatID: {seq}}
	reactions, err := loadReactions(ctx, s.pool, key, []int64{me})
	if err != nil {
		return nil, err
	}
	return &appv1.SetReactionResponse{Reactions: reactions.forViewer(msgKey{chatID, seq}, me), Ack: t.ack(me, chatID)}, nil
}

// --------------------------------------------------------- read receipts

// GetMessageReaders lists members who read a message, in small groups and
// for recent messages only.
func (s *Service) GetMessageReaders(ctx context.Context, me, chatID, seq int64) (*appv1.GetMessageReadersResponse, error) {
	c, mem, err := s.activeChatFor(ctx, s.pool, chatID, me, false)
	if err != nil {
		return nil, err
	}
	if c.Type == typeChannel || int(c.MemberCount) > s.cfg.ReadReceiptsMemberMax {
		return nil, errPrecondition("read receipts are only kept for groups up to %d members", s.cfg.ReadReceiptsMemberMax)
	}
	m, err := s.liveMessage(ctx, s.pool, chatID, seq)
	if err != nil {
		return nil, err
	}
	hidden, err := loadHidden(ctx, s.pool, []int64{me}, map[int64][]int64{chatID: {seq}})
	if err != nil {
		return nil, err
	}
	if !mem.sees(m) || hidden[hiddenKey{me, msgKey{chatID, seq}}] {
		return nil, errNotFound("message")
	}
	if time.Since(m.Date) > s.cfg.ReadReceiptsMaxAge {
		return nil, errPrecondition("read receipts are only kept for recent messages")
	}
	topic := int64(0)
	if c.Forum {
		topic = m.TopicID
	}
	rows, err := s.pool.Query(ctx, `
		SELECT x.user_id, x.read_at FROM (
			SELECT mem.user_id, coalesce((SELECT min(rr.read_at) FROM read_receipts rr
				WHERE rr.chat_id = $1 AND rr.topic_id = $3 AND rr.user_id = mem.user_id AND rr.max_seq >= $2), r.updated_at) AS read_at
			FROM chat_members mem
			JOIN chat_read_states r ON r.chat_id = mem.chat_id AND r.user_id = mem.user_id AND r.topic_id = $3
			WHERE mem.chat_id = $1 AND mem.left_at IS NULL AND mem.user_id <> $4 AND r.read_inbox_max_seq >= $2
				AND mem.joined_seq < $2) x
		ORDER BY x.read_at DESC, x.user_id LIMIT 200`, chatID, seq, topic, m.FromID)
	if err != nil {
		return nil, fmt.Errorf("chat: readers: %w", err)
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*appv1.MessageReader, error) {
		var x appv1.MessageReader
		var at time.Time
		err := r.Scan(&x.UserId, &at)
		x.ReadAt = at.Unix()
		return &x, err
	})
	if err != nil {
		return nil, fmt.Errorf("chat: readers: %w", err)
	}
	readers := make([]int64, len(list))
	for i, x := range list {
		readers[i] = x.GetUserId()
	}
	ents := newEntitySet()
	ents.addUsers(me, readers...)
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, err
	}
	return &appv1.GetMessageReadersResponse{UserIds: readers, Users: rendered.users[me], Readers: list}, nil
}

// ------------------------------------------------------------ link preview

// GetLinkPreview returns the text preview of a web page for the composer.
func (s *Service) GetLinkPreview(ctx context.Context, me int64, raw string) (*appv1.GetLinkPreviewResponse, error) {
	url, err := linkpreview.NormalizeURL(raw)
	if err != nil {
		return nil, errInvalid("url must be an http or https URL")
	}
	if err := s.allow(limitPreview, "preview", me); err != nil {
		return nil, err
	}
	p, err := s.previews.Get(ctx, url)
	if err != nil {
		return nil, err
	}
	if p.Empty() {
		return &appv1.GetLinkPreviewResponse{}, nil
	}
	return &appv1.GetLinkPreviewResponse{Preview: &appv1.LinkPreview{
		Url: p.URL, SiteName: p.SiteName, Title: p.Title, Description: p.Description,
	}}, nil
}
