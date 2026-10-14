package chat

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// Outbox kinds (ADR 0003).
const (
	kindMessageNew        = "message_new"
	kindMessageEdit       = "message_edit"
	kindMessageDelete     = "message_delete"
	kindMessageHidden     = "message_hidden"
	kindReaction          = "reaction"
	kindRead              = "read"
	kindPin               = "pin"
	kindMemberAdded       = "member_added"
	kindMemberRemoved     = "member_removed"
	kindMemberPermissions = "member_permissions"
	kindChatModeChanged   = "chat_mode_changed"
	kindChatUpdated       = "chat_updated"
	kindTopicChanged      = "topic_changed"
	kindSessionRevoked    = "session_revoked"
	kindDialogMute        = "dialog_mute"
	kindPinnedDialogs     = "pinned_dialogs"
	kindChatDeleted       = "chat_deleted"
	kindDialogUnreadMark  = "dialog_unread_mark"
	kindNotifySettings    = "notification_settings"
)

// userEntry is one update in a user's log.
type userEntry struct {
	UserID int64
	Pts    int64
	Update *appv1.Update
}

// chatEntry is one update in a large chat's log.
type chatEntry struct {
	ChatID  int64
	ChatPts int64
	Update  *appv1.Update
}

// Event is one committed mutation (one outbox row) to deliver in realtime.
type Event struct {
	OutboxID int64
	Kind     string
	ChatID   int64
	ActorID  int64
	Users    []userEntry
	Chats    []chatEntry
	// TopSeq of the chat after the mutation, for chat_activity hints.
	TopSeq int64
	// session_revoked only.
	SessionID int64
	Reason    appv1.SessionRevokeReason
	// Users who are no longer members of ChatID.
	Forget []int64
	// delivered, when set, learns after the realtime delivery whether a
	// recipient had a session online (incoming webhook counters). Events
	// replayed by the outbox sweeper do not carry it.
	delivered func(reached bool)
}

// queued is a per-user log entry waiting for pts allocation at flush.
type queued struct {
	ev     *Event
	users  []int64
	update *appv1.Update
	pts    map[int64]int64
}

// txn is one mutation transaction: it queues per-user log entries,
// allocates their pts in a single sorted statement at flush (so user_state
// rows are always locked in user id order), writes the logs and the outbox.
type txn struct {
	tx     pgx.Tx
	s      *Service
	epoch  int64
	queue  []*queued
	events []*Event
	// allocated: pts were assigned; no entry may be queued afterwards.
	allocated bool
	// beforeWrite runs after pts allocation and before the log rows are
	// written; it may still edit queued updates (read counts).
	beforeWrite []func(ctx context.Context) error
	// chatPts is the newest chat_pts written per chat in this transaction.
	chatPts map[int64]int64
}

// event starts the outbox row of a mutation; entries queued afterwards
// belong to it.
func (t *txn) event(kind string, chatID, actorID int64) *Event {
	ev := &Event{Kind: kind, ChatID: chatID, ActorID: actorID}
	t.events = append(t.events, ev)
	return ev
}

// toUsers queues update for the logs of users (duplicates are ignored).
func (t *txn) toUsers(ev *Event, users []int64, update *appv1.Update) {
	if t.allocated {
		panic("chat: log entry queued after pts allocation")
	}
	if len(users) == 0 {
		return
	}
	uniq := slices.Clone(users)
	slices.Sort(uniq)
	uniq = slices.Compact(uniq)
	t.queue = append(t.queue, &queued{ev: ev, users: uniq, update: update})
}

// toChatLog appends update to a large chat's own log. The chat row must
// already be locked by this transaction.
func (t *txn) toChatLog(ctx context.Context, ev *Event, chatID int64, update *appv1.Update) error {
	var chatPts int64
	if err := t.tx.QueryRow(ctx, `
		UPDATE chats SET chat_pts = chat_pts + 1, chat_pts_at = now() WHERE id = $1 RETURNING chat_pts`,
		chatID).Scan(&chatPts); err != nil {
		return fmt.Errorf("chat: next chat_pts: %w", err)
	}
	payload, err := encodeStored(update)
	if err != nil {
		return err
	}
	if _, err := t.tx.Exec(ctx, `INSERT INTO chat_updates (chat_id, chat_pts, "update") VALUES ($1, $2, $3)`,
		chatID, chatPts, payload); err != nil {
		return fmt.Errorf("chat: append chat log: %w", err)
	}
	if t.chatPts == nil {
		t.chatPts = map[int64]int64{}
	}
	t.chatPts[chatID] = chatPts
	ev.Chats = append(ev.Chats, chatEntry{ChatID: chatID, ChatPts: chatPts, Update: update})
	return nil
}

// toChat writes a chat event: into every member's log for a small chat, or
// into the chat's own log for a large one. The chat row must be locked.
func (t *txn) toChat(ctx context.Context, ev *Event, c *chatRow, members []int64, update *appv1.Update) error {
	if c.SyncMode == syncLarge {
		return t.toChatLog(ctx, ev, c.ID, update)
	}
	t.toUsers(ev, members, update)
	return nil
}

// allocate assigns pts to every queued entry: one statement locks and
// advances user_state rows in user id order.
func (t *txn) allocate(ctx context.Context) error {
	if t.allocated {
		return nil
	}
	t.allocated = true
	counts := map[int64]int64{}
	for _, q := range t.queue {
		for _, u := range q.users {
			counts[u]++
		}
	}
	if len(counts) == 0 {
		return nil
	}
	users := make([]int64, 0, len(counts))
	for u := range counts {
		users = append(users, u)
	}
	slices.Sort(users)
	ns := make([]int64, len(users))
	for i, u := range users {
		ns[i] = counts[u]
	}
	rows, err := t.tx.Query(ctx, `
		INSERT INTO user_state (user_id, pts, updated_at)
		SELECT u, n, now() FROM unnest($1::bigint[], $2::bigint[]) AS x(u, n) ORDER BY u
		ON CONFLICT (user_id) DO UPDATE SET pts = user_state.pts + excluded.pts, updated_at = now()
		RETURNING user_id, pts`, users, ns)
	if err != nil {
		return fmt.Errorf("chat: allocate pts: %w", err)
	}
	next := map[int64]int64{}
	for rows.Next() {
		var u, pts int64
		if err := rows.Scan(&u, &pts); err != nil {
			rows.Close()
			return fmt.Errorf("chat: allocate pts: %w", err)
		}
		next[u] = pts - counts[u] + 1
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("chat: allocate pts: %w", err)
	}
	for _, q := range t.queue {
		q.pts = make(map[int64]int64, len(q.users))
		for _, u := range q.users {
			q.pts[u] = next[u]
			next[u]++
		}
	}
	return nil
}

// flush allocates pts, writes the per-user log rows and the outbox rows.
func (t *txn) flush(ctx context.Context) error {
	if err := t.allocate(ctx); err != nil {
		return err
	}
	for _, fn := range t.beforeWrite {
		if err := fn(ctx); err != nil {
			return err
		}
	}
	var (
		userIDs  []int64
		ptsList  []int64
		chatIDs  []int64
		payloads [][]byte
	)
	for _, q := range t.queue {
		payload, err := encodeStored(q.update)
		if err != nil {
			return err
		}
		chatID := updateChatID(q.update)
		for _, u := range q.users {
			userIDs = append(userIDs, u)
			ptsList = append(ptsList, q.pts[u])
			chatIDs = append(chatIDs, chatID)
			payloads = append(payloads, payload)
			q.ev.Users = append(q.ev.Users, userEntry{UserID: u, Pts: q.pts[u], Update: q.update})
		}
	}
	if len(userIDs) > 0 {
		if _, err := t.tx.Exec(ctx, `
			INSERT INTO user_updates (user_id, pts, chat_id, "update")
			SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::bytea[])`,
			userIDs, ptsList, chatIDs, payloads); err != nil {
			return fmt.Errorf("chat: append user logs: %w", err)
		}
	}
	for _, ev := range t.events {
		var users, pts []int64
		for _, e := range ev.Users {
			users = append(users, e.UserID)
			pts = append(pts, e.Pts)
		}
		chatPts := []int64{}
		for _, c := range ev.Chats {
			chatPts = append(chatPts, c.ChatPts)
		}
		if users == nil {
			users, pts = []int64{}, []int64{}
		}
		if err := t.tx.QueryRow(ctx, `
			INSERT INTO outbox (kind, tenant_id, chat_id, actor_id, user_ids, pts, chat_pts)
			VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
			ev.Kind, t.s.cfg.TenantID, ev.ChatID, ev.ActorID, users, pts, chatPts).Scan(&ev.OutboxID); err != nil {
			return fmt.Errorf("chat: write outbox: %w", err)
		}
		if len(ev.Chats) > 0 && ev.TopSeq == 0 {
			if err := t.tx.QueryRow(ctx, `SELECT last_seq FROM chats WHERE id = $1`, ev.ChatID).Scan(&ev.TopSeq); err != nil {
				return fmt.Errorf("chat: read top seq: %w", err)
			}
		}
	}
	return nil
}

// ack returns the caller's log positions after the transaction.
func (t *txn) ack(userID, chatID int64) *appv1.SyncAck {
	a := &appv1.SyncAck{ServerEpoch: t.epoch}
	for _, q := range t.queue {
		if p, ok := q.pts[userID]; ok {
			a.Pts = max(a.Pts, p)
			a.PtsCount++
		}
	}
	for _, ev := range t.events {
		for _, c := range ev.Chats {
			if c.ChatID == chatID {
				a.ChatPts = max(a.ChatPts, c.ChatPts)
				a.ChatPtsCount++
			}
		}
	}
	return a
}

// encodeStored encodes an update for a log row: messages inside are reduced
// to their address and rendered again from the messages table when read.
func encodeStored(u *appv1.Update) ([]byte, error) {
	stored := proto.Clone(u).(*appv1.Update)
	stored.Pts, stored.PtsCount, stored.ChatPts, stored.ChatPtsCount, stored.ServerEpoch, stored.Date = 0, 0, 0, 0, 0, 0
	switch k := stored.Kind.(type) {
	case *appv1.Update_MessageNew:
		k.MessageNew.Message = messageRef(k.MessageNew.GetMessage())
	case *appv1.Update_MessageEdit:
		k.MessageEdit.Message = messageRef(k.MessageEdit.GetMessage())
	case *appv1.Update_Reaction:
		k.Reaction.Reactions = nil
	default:
	}
	b, err := proto.Marshal(stored)
	if err != nil {
		return nil, fmt.Errorf("chat: encode update: %w", err)
	}
	return b, nil
}

func messageRef(m *appv1.Message) *appv1.Message {
	return &appv1.Message{ChatId: m.GetChatId(), Seq: m.GetSeq()}
}

func decodeStored(b []byte) (*appv1.Update, error) {
	u := &appv1.Update{}
	if err := proto.Unmarshal(b, u); err != nil {
		return nil, fmt.Errorf("chat: decode update: %w", err)
	}
	return u, nil
}

// updateChatID is the chat an update is about (0 for personal updates).
func updateChatID(u *appv1.Update) int64 {
	switch k := u.Kind.(type) {
	case *appv1.Update_MessageNew:
		return k.MessageNew.GetMessage().GetChatId()
	case *appv1.Update_MessageEdit:
		return k.MessageEdit.GetMessage().GetChatId()
	case *appv1.Update_MessageDelete:
		return k.MessageDelete.GetChatId()
	case *appv1.Update_MessageHidden:
		return k.MessageHidden.GetChatId()
	case *appv1.Update_Reaction:
		return k.Reaction.GetChatId()
	case *appv1.Update_Read:
		return k.Read.GetChatId()
	case *appv1.Update_Pin:
		return k.Pin.GetChatId()
	case *appv1.Update_MemberAdded:
		return k.MemberAdded.GetChatId()
	case *appv1.Update_MemberRemoved:
		return k.MemberRemoved.GetChatId()
	case *appv1.Update_MemberPermissions:
		return k.MemberPermissions.GetChatId()
	case *appv1.Update_ChatModeChanged:
		return k.ChatModeChanged.GetChatId()
	case *appv1.Update_ChatUpdated:
		return k.ChatUpdated.GetChat().GetId()
	case *appv1.Update_ChatActivity:
		return k.ChatActivity.GetChatId()
	case *appv1.Update_TopicChanged:
		return k.TopicChanged.GetTopic().GetChatId()
	case *appv1.Update_DialogMute:
		return k.DialogMute.GetChatId()
	case *appv1.Update_ChatDeleted:
		return k.ChatDeleted.GetChatId()
	case *appv1.Update_DialogUnreadMark:
		return k.DialogUnreadMark.GetChatId()
	default:
		return 0
	}
}

// ------------------------------------------------------------- dispatcher

// dispatcher renders and delivers committed events off the request path.
// Events of one chat go to the same worker, so they reach clients in commit
// order; across chats the client's gap timer absorbs reordering.
type dispatcher struct {
	s       *Service
	workers []chan *Event
	done    chan struct{}
	stopped chan struct{}
	// delivered remembers outbox ids handed to the sink, so the sweeper does
	// not deliver them twice.
	delivered *idSet
}

const (
	dispatchWorkers = 4
	dispatchQueue   = 4096
	deliverTimeout  = 5 * time.Second
)

func newDispatcher(s *Service) *dispatcher {
	d := &dispatcher{s: s, done: make(chan struct{}), stopped: make(chan struct{}), delivered: newIDSet()}
	for range dispatchWorkers {
		d.workers = append(d.workers, make(chan *Event, dispatchQueue))
	}
	return d
}

func (d *dispatcher) start() {
	finished := make(chan struct{}, len(d.workers))
	for _, ch := range d.workers {
		go func() {
			defer func() { finished <- struct{}{} }()
			for ev := range ch {
				d.run(ev)
			}
		}()
	}
	go func() {
		for range d.workers {
			<-finished
		}
		close(d.stopped)
	}()
}

func (d *dispatcher) stop() {
	select {
	case <-d.done:
		return
	default:
	}
	close(d.done)
	for _, ch := range d.workers {
		close(ch)
	}
	<-d.stopped
}

// enqueue never blocks the request: when a worker is full the event is
// dropped and the outbox sweeper delivers it.
func (d *dispatcher) enqueue(ev *Event) {
	select {
	case <-d.done:
		return
	default:
	}
	ch := d.workers[int(uint64(ev.ChatID)%uint64(len(d.workers)))]
	select {
	case ch <- ev:
	default:
		d.s.logger.Warn("realtime dispatch queue full; left to the outbox sweeper", "outbox_id", ev.OutboxID)
	}
}

func (d *dispatcher) run(ev *Event) {
	// The sweeper may have delivered it already (this queue was slow).
	if !d.delivered.addIfAbsent(ev.OutboxID) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), deliverTimeout)
	defer cancel()
	if err := d.s.deliver(ctx, ev); err != nil && !errors.Is(err, context.Canceled) {
		d.s.logger.Error("realtime delivery failed", "outbox_id", ev.OutboxID, "kind", ev.Kind, "err", err)
	}
}

// deliver renders the event for every recipient and hands it to the sink.
func (s *Service) deliver(ctx context.Context, ev *Event) error {
	sink, presence := s.realtime()
	if sink == nil {
		if ev.delivered != nil {
			ev.delivered(false)
		}
		return nil
	}
	// reached: a recipient other than the actor had a session online.
	reached := false
	if ev.SessionID != 0 {
		sink.RevokeSession(ev.SessionID, ev.Reason)
	}
	for _, u := range ev.Forget {
		sink.ForgetChat(u, ev.ChatID)
	}
	epoch := s.Epoch()
	now := time.Now().Unix()
	if len(ev.Users) > 0 {
		jobs := map[int64][]*appv1.Update{}
		var order []int64
		for _, e := range ev.Users {
			u := proto.Clone(e.Update).(*appv1.Update)
			u.Pts, u.PtsCount, u.ServerEpoch, u.Date = e.Pts, 1, epoch, now
			if _, ok := jobs[e.UserID]; !ok {
				order = append(order, e.UserID)
			}
			jobs[e.UserID] = append(jobs[e.UserID], u)
		}
		frames, err := s.renderFrames(ctx, s.pool, order, jobs, false)
		if err != nil {
			return err
		}
		for _, viewer := range order {
			sink.SendUser(viewer, &appv1.ServerFrame{Frame: &appv1.ServerFrame_Update{Update: frames[viewer]}})
			if ev.delivered != nil && !reached && viewer != ev.ActorID && presence != nil && presence.Online(viewer) {
				reached = true
			}
		}
	}
	for _, c := range ev.Chats {
		viewers := sink.ChatViewers(c.ChatID)
		reached = reached || len(viewers) > 0
		if len(viewers) > 0 {
			jobs := map[int64][]*appv1.Update{}
			for _, v := range viewers {
				u := proto.Clone(c.Update).(*appv1.Update)
				u.ChatPts, u.ChatPtsCount, u.ChatId, u.ServerEpoch, u.Date = c.ChatPts, 1, c.ChatID, epoch, now
				jobs[v] = []*appv1.Update{u}
			}
			// Sockets may still show a chat their user just left: only
			// current members get a frame.
			frames, err := s.renderFrames(ctx, s.pool, viewers, jobs, true)
			if err != nil {
				return err
			}
			for _, v := range viewers {
				if f, ok := frames[v]; ok {
					sink.SendChatViewer(v, c.ChatID, &appv1.ServerFrame{Frame: &appv1.ServerFrame_Update{Update: f}})
				}
			}
		}
		sink.ChatActivity(c.ChatID, c.ChatPts, ev.TopSeq)
	}
	if ev.delivered != nil {
		ev.delivered(reached)
	}
	return nil
}
