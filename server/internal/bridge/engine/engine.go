// Package engine syncs the conversations of an account in another app into
// Chat. It knows nothing of any one app: an bridge.Adapter delivers history
// and live events, and every write goes through chat.ImportTx.
//
// One runner owns one external account at a time (a lease row keeps a second
// server process from connecting the same account). It starts the live
// subscription first, imports the history window of every synced chat that
// has not caught up, and only then handles live events, in the order they
// came. The adapter's update state is saved in the transaction of the write
// it follows, so a crash replays events instead of losing them, and every
// write is idempotent by the key of the message in the other app.
package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/chat"
	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
)

// Config tunes the engine. The zero value of a field takes its default.
type Config struct {
	TenantID string
	// LeaseTTL is how long a connection stays claimed without renewal.
	LeaseTTL time.Duration
	// PageSize is how many messages one history call asks for.
	PageSize int
	// PageDelay is the pause between two history calls (default 300 ms), so
	// a large window does not look like a scraper to the other app.
	PageDelay time.Duration
	// BatchSize is how many messages one Chat transaction imports.
	BatchSize int
	// QueueSize is how many live events wait while history is imported.
	QueueSize int
	// BackoffMin and BackoffMax bound the wait before reconnecting.
	BackoffMin, BackoffMax time.Duration
	// ReconcileEvery is how often accounts to connect and logouts to carry
	// out are looked for.
	ReconcileEvery time.Duration
	// MediaMaxBytes is the largest file copied from the other app (default
	// 25 MiB); a bigger one is left there and the message says so.
	MediaMaxBytes int64
	// OutboxPoll is how often the outbox of a connected account is looked at.
	OutboxPoll time.Duration
	// StatePoll is how often the state of the synced chats that the other app
	// does not announce (mute, pinned, marked unread) is read from it (default 2 min).
	StatePoll time.Duration
	// SendGap is the least time between two sends of one account, so what a
	// user types never looks like a flood to the other app.
	SendGap time.Duration
	// SendBatch is how many sends one look at the outbox makes, so live events
	// are not held back by a long queue.
	SendBatch int
	// SendAttempts is how many times a send is tried before it is given up
	// as failed (a limit of the other app's answer, not of its being busy).
	SendAttempts int
	// TopicRefreshGap is the least time between two asks of the other app for
	// the topics of a forum, when messages keep naming topics the chat does not
	// have (default 5 s).
	TopicRefreshGap time.Duration
	// SendRetryWindow is how long a send in flight is repeated on its own
	// after a restart; later it becomes 'unknown' and the user decides.
	SendRetryWindow time.Duration
	// Holder names this process in lease rows.
	Holder string
}

func (c Config) withDefaults() Config {
	if c.LeaseTTL <= 0 {
		c.LeaseTTL = time.Minute
	}
	if c.PageSize <= 0 {
		c.PageSize = 100
	}
	if c.PageDelay == 0 {
		c.PageDelay = 300 * time.Millisecond
	}
	if c.BatchSize <= 0 {
		c.BatchSize = 200
	}
	if c.QueueSize <= 0 {
		c.QueueSize = 256
	}
	if c.BackoffMin <= 0 {
		c.BackoffMin = time.Second
	}
	if c.BackoffMax <= 0 {
		c.BackoffMax = 5 * time.Minute
	}
	if c.MediaMaxBytes <= 0 {
		c.MediaMaxBytes = defaultMediaMax
	}
	if c.ReconcileEvery <= 0 {
		c.ReconcileEvery = 10 * time.Second
	}
	if c.StatePoll <= 0 {
		c.StatePoll = 2 * time.Minute
	}
	if c.OutboxPoll <= 0 {
		c.OutboxPoll = 500 * time.Millisecond
	}
	if c.SendGap == 0 {
		c.SendGap = 700 * time.Millisecond
	}
	if c.SendBatch <= 0 {
		c.SendBatch = 10
	}
	if c.SendAttempts <= 0 {
		c.SendAttempts = 10
	}
	if c.TopicRefreshGap == 0 {
		c.TopicRefreshGap = 5 * time.Second
	}
	if c.SendRetryWindow <= 0 {
		c.SendRetryWindow = 10 * time.Minute
	}
	if c.Holder == "" {
		c.Holder = fmt.Sprintf("bridge-%d", time.Now().UnixNano())
	}
	return c
}

// errLeaseLost ends a run whose lease another process took over.
var errLeaseLost = errors.New("bridge: lease lost")

// runner syncs one account until its context ends or it fails.
type runner struct {
	e       *Engine
	account *accountRow
	adapter bridge.Adapter
	acct    bridge.Account
	logger  *slog.Logger
	// links are the synced chats by the id the other app gives them.
	links map[string]*chatLink
	// cmds asks the runner to import a chat enabled while it runs.
	cmds chan *chatLink
	// puppets caches participant id to Chat user for mentions.
	puppets map[string]int64
	// topics is what is known of the topics of each forum conversation.
	topics map[string]*convTopics
	// pause holds every send until then (the other app asked to wait);
	// nextSend spaces two sends by Config.SendGap.
	pause, nextSend time.Time
}

// run connects the account and syncs until ctx ends or something fails.
func (r *runner) run(ctx context.Context) error {
	e := r.e
	held, err := e.db.claimLease(ctx, r.account.ID, e.cfg.Holder, e.cfg.LeaseTTL)
	if err != nil {
		return err
	}
	if !held {
		return errLeaseLost
	}
	runCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	defer e.db.releaseLease(context.WithoutCancel(ctx), r.account.ID, e.cfg.Holder)
	go r.keepLease(runCtx, cancel)

	links, err := e.db.links(runCtx, r.account.ID)
	if err != nil {
		return err
	}
	r.links = make(map[string]*chatLink, len(links))
	for _, l := range links {
		r.links[l.ExternalChat] = l
	}

	// Subscribe first: what happens while history is imported waits in the
	// queue instead of falling between the two.
	events := make(chan bridge.Event, e.cfg.QueueSize)
	subDone := make(chan error, 1)
	go func() { subDone <- r.adapter.Subscribe(runCtx, r.acct, events) }()

	var caughtUp []*chatLink
	for _, l := range links {
		if l.BackfillDone {
			caughtUp = append(caughtUp, l)
			continue
		}
		if err := r.backfill(runCtx, l); err != nil {
			return r.settle(runCtx, err)
		}
	}
	// A chat synced before pins were read gets them now; a chat that was just
	// imported got them at the end of its backfill.
	for _, l := range caughtUp {
		if err := r.syncPins(runCtx, l); err != nil {
			return r.settle(runCtx, err)
		}
	}
	outbox := time.NewTicker(e.cfg.OutboxPoll)
	defer outbox.Stop()
	states := time.NewTicker(e.cfg.StatePoll)
	defer states.Stop()
	if err := r.pollAll(runCtx); err != nil {
		return r.settle(runCtx, err)
	}
	for {
		select {
		case <-runCtx.Done():
			return r.settle(runCtx, context.Cause(runCtx))
		case <-outbox.C:
			if err := r.sendDue(runCtx); err != nil {
				return r.settle(runCtx, err)
			}
		case <-states.C:
			if err := r.pollAll(runCtx); err != nil {
				return r.settle(runCtx, err)
			}
		case err := <-subDone:
			if err == nil {
				err = errors.New("bridge: subscription ended")
			}
			return r.settle(runCtx, err)
		case l := <-r.cmds:
			r.links[l.ExternalChat] = l
			if err := r.backfill(runCtx, l); err != nil {
				return r.settle(runCtx, err)
			}
		case ev := <-events:
			if err := r.handle(runCtx, ev); err != nil {
				return r.settle(runCtx, err)
			}
		}
	}
}

// settle turns an error of the run into the one to report: the lease loss
// that cancelled the context beats the context error it caused.
func (r *runner) settle(ctx context.Context, err error) error {
	if cause := context.Cause(ctx); cause != nil && errors.Is(err, context.Canceled) {
		return cause
	}
	if errors.Is(err, bridge.ErrGapTooLarge) {
		return r.reconcile(ctx)
	}
	return err
}

// reconcile answers a gap the other app cannot replay: every synced chat
// imports its window again (messages already imported are skipped) and the
// run restarts from the adapter's current state.
func (r *runner) reconcile(ctx context.Context) error {
	r.logger.Warn("update gap too large to replay; importing the history windows again")
	for _, l := range r.links {
		if _, err := r.e.db.pool.Exec(ctx, `UPDATE external_chats SET backfill_done = false WHERE id = $1`, l.ID); err != nil {
			return fmt.Errorf("bridge: reopen backfill: %w", err)
		}
	}
	if _, err := r.e.db.pool.Exec(ctx, `UPDATE external_accounts SET update_state = NULL WHERE id = $1`, r.account.ID); err != nil {
		return fmt.Errorf("bridge: reset update state: %w", err)
	}
	return errors.New("bridge: reconnecting after an update gap")
}

// keepLease renews the lease until ctx ends; a lost lease ends the run.
func (r *runner) keepLease(ctx context.Context, cancel context.CancelCauseFunc) {
	t := time.NewTicker(r.e.cfg.LeaseTTL / 3)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			held, err := r.e.db.claimLease(ctx, r.account.ID, r.e.cfg.Holder, r.e.cfg.LeaseTTL)
			if err == nil && !held {
				cancel(errLeaseLost)
				return
			}
		}
	}
}

// handle applies one live event and keeps the adapter's state.
func (r *runner) handle(ctx context.Context, ev bridge.Event) error {
	saved, err := r.dispatch(ctx, ev)
	if err != nil {
		if isSkippable(err) {
			// One event Chat will not take must not stop the account.
			r.logger.Warn("event skipped", "reason", err.Error())
			err = nil
		} else {
			return err
		}
	}
	if !saved {
		if err := saveState(ctx, r.e.db.pool, r.account.ID, ev.State); err != nil {
			return err
		}
	}
	if ev.State != nil {
		r.acct.State = ev.State
	}
	return nil
}

// isSkippable reports an error that retrying cannot fix and that concerns
// only the one event: Chat refused its content.
func isSkippable(err error) bool {
	return connect.CodeOf(err) == connect.CodeInvalidArgument
}

// withLink runs fn inside an import transaction of link's chat. A chat that
// is gone ends the sync of that chat only.
func (r *runner) withLink(ctx context.Context, l *chatLink, fn func(*chat.ImportTx) error) error {
	err := r.e.chat.WithImport(ctx, l.ChatID, r.account.OwnerID, fn)
	if errors.Is(err, chat.ErrImportChatGone) {
		r.logger.Warn("synced chat is gone; sync of that chat stopped", "chat_id", l.ChatID)
		delete(r.links, l.ExternalChat)
		if derr := r.e.db.dropLink(ctx, l.ID); derr != nil {
			return derr
		}
		return nil
	}
	return err
}

// sleep waits d or until ctx ends.
func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// retryRateLimit runs call and, when the other app throttles it, waits as
// long as it asks and calls again.
func retryRateLimit[T any](ctx context.Context, call func() (T, error)) (T, error) {
	for {
		v, err := call()
		var limit *bridge.RateLimitError
		if !errors.As(err, &limit) {
			return v, err
		}
		if err := sleep(ctx, limit.RetryAfter); err != nil {
			return v, err
		}
	}
}

// fetchWindow reads the newest limit messages of a conversation, oldest
// first. History comes newest first in pages; it is held in memory (a window
// is at most history_window messages) so that Chat gets it in time order.
func (r *runner) fetchWindow(ctx context.Context, l *chatLink) ([]bridge.Message, error) {
	var newestFirst []bridge.Message
	cur := bridge.Cursor{}
	for len(newestFirst) < l.HistoryMax {
		page, err := retryRateLimit(ctx, func() (bridge.Page, error) {
			return r.adapter.Backfill(ctx, r.acct, l.ExternalChat, cur, min(r.e.cfg.PageSize, l.HistoryMax-len(newestFirst)))
		})
		if err != nil {
			return nil, err
		}
		newestFirst = append(newestFirst, page.Messages...)
		if page.Done || len(page.Messages) == 0 {
			break
		}
		cur = page.Next
		if err := sleep(ctx, r.e.cfg.PageDelay); err != nil {
			return nil, err
		}
	}
	if len(newestFirst) > l.HistoryMax {
		newestFirst = newestFirst[:l.HistoryMax]
	}
	slices.Reverse(newestFirst)
	return newestFirst, nil
}

// backfill imports the history window of a chat, oldest first, in batches,
// then marks the chat as caught up. A run that dies half way repeats it:
// what is already imported is skipped.
func (r *runner) backfill(ctx context.Context, l *chatLink) error {
	if err := r.syncTopics(ctx, l); err != nil {
		return err
	}
	msgs, err := r.fetchWindow(ctx, l)
	if err != nil {
		return err
	}
	for start := 0; start < len(msgs); start += r.e.cfg.BatchSize {
		batch := msgs[start:min(start+r.e.cfg.BatchSize, len(msgs))]
		if err := r.importBatch(ctx, l, batch); err != nil {
			if !isSkippable(err) {
				return err
			}
			// Chat refused something in the batch: take the messages one by
			// one, so a single bad message costs only itself.
			r.logger.Warn("history batch refused; importing its messages one by one", "reason", err.Error(), "messages", len(batch))
			for i := range batch {
				if err := r.importBatch(ctx, l, batch[i:i+1]); err != nil {
					if !isSkippable(err) {
						return err
					}
					r.logger.Warn("history message skipped", "reason", err.Error())
				}
			}
		}
		if _, ok := r.links[l.ExternalChat]; !ok {
			return nil // the chat is gone
		}
	}
	if err := r.syncPins(ctx, l); err != nil {
		return err
	}
	cursor := ""
	if n := len(msgs); n > 0 {
		cursor = msgs[n-1].ID
	}
	if err := r.e.db.finishBackfill(ctx, l.ID, cursor); err != nil {
		return err
	}
	l.BackfillDone = true
	return nil
}

// importBatch imports messages oldest first into the chat of l, skipping
// the ones already there or deleted before they arrived.
func (r *runner) importBatch(ctx context.Context, l *chatLink, batch []bridge.Message) error {
	if err := r.prepareTopics(ctx, l, batch); err != nil {
		return err
	}
	senders := make(map[string]int64, len(batch))
	for _, m := range batch {
		if _, ok := senders[m.From.ID]; ok {
			continue
		}
		id, err := r.e.db.ensurePuppet(ctx, r.account, m.From)
		if err != nil {
			return err
		}
		senders[m.From.ID] = id
		r.puppets[m.From.ID] = id
	}
	files, err := r.copyFiles(ctx, l, batch)
	if err != nil {
		return err
	}
	return r.withLink(ctx, l, func(it *chat.ImportTx) error {
		ids := make([]string, len(batch))
		for i, m := range batch {
			ids[i] = m.ID
		}
		known, err := knownMessages(ctx, it.Tx(), r.account.ID, l.ExternalChat, ids)
		if err != nil {
			return err
		}
		var fresh []bridge.Message
		for _, m := range batch {
			k := messageKey{r.account.ID, l.ExternalChat, m.ID}
			if known[m.ID] {
				continue
			}
			gone, err := tombstoned(ctx, it.Tx(), k)
			if err != nil {
				return err
			}
			if !gone {
				fresh = append(fresh, m)
			}
		}
		return r.appendMessages(ctx, it, l, fresh, senders, files)
	})
}

// appendMessages writes fresh messages (oldest first) into the chat, records
// their keys, and wires replies in both directions.
func (r *runner) appendMessages(ctx context.Context, it *chat.ImportTx, l *chatLink, fresh []bridge.Message, senders map[string]int64, files map[string]*appv1.Message) error {
	if len(fresh) == 0 {
		return nil
	}
	topicIDs, err := r.topicIDs(ctx, it, l, fresh)
	if err != nil {
		return err
	}
	imports := make([]chat.ImportMessage, len(fresh))
	replyTo := make([]string, len(fresh))
	for i, m := range fresh {
		from := senders[m.From.ID]
		if from != r.account.OwnerID {
			if err := it.AddMember(ctx, from); err != nil {
				return err
			}
		}
		content := files[m.ID]
		label := labelFor(m, content != nil)
		if label == "" && m.Text == "" && content == nil {
			label = "[Tin nhắn không hỗ trợ]" // an empty message cannot be stored
		}
		labelled, moved := withLabel(label, m.Text, m.Entities)
		text, ents := mapContent(labelled, moved, r.e.chat.MessageLengthMax(), r.userOf)
		imports[i] = chat.ImportMessage{FromID: from, Date: m.Date, Text: text, Entities: ents, Content: content, TopicID: topicIDs[m.Topic], Buttons: chatButtons(m.Buttons)}
		if m.ReplyTo != "" {
			target, err := lookupMessage(ctx, it.Tx(), r.account.ID, l.ExternalChat, m.ReplyTo)
			if err != nil {
				return err
			}
			if target != nil {
				imports[i].ReplyToSeq = target.Seq
			} else {
				replyTo[i] = m.ReplyTo
			}
		}
	}
	// Replies to a message of this same batch are wired once every row of the
	// batch is recorded (the original has no seq before it is written).
	seqs, err := it.Append(ctx, imports)
	if err != nil {
		return err
	}
	for i, m := range fresh {
		k := messageKey{r.account.ID, l.ExternalChat, m.ID}
		if err := insertMessage(ctx, it.Tx(), k, l.ChatID, seqs[i], m.Version, replyTo[i]); err != nil {
			return err
		}
	}
	for i, m := range fresh {
		k := messageKey{r.account.ID, l.ExternalChat, m.ID}
		waiting, err := pendingReplies(ctx, it.Tx(), k)
		if err != nil {
			return err
		}
		for _, seq := range waiting {
			if err := it.SetReply(ctx, seq, seqs[i]); err != nil {
				return err
			}
		}
	}
	return nil
}

// userOf maps an adapter participant id to the Chat user, for mentions.
func (r *runner) userOf(participantID string) (int64, bool) {
	id, ok := r.puppets[participantID]
	return id, ok
}

// onMessage imports a live message.
func (r *runner) onMessage(ctx context.Context, ev bridge.Event, m bridge.Message) (bool, error) {
	return r.upsert(ctx, ev, m, false)
}

// onEdit applies an edit. An edit that arrives before its message imports
// the edited message in the original's place (the original, older, is then
// dropped as a repeat) — unless it is older than anything imported, which is
// outside the window.
func (r *runner) onEdit(ctx context.Context, ev bridge.Event, m bridge.Message) (bool, error) {
	return r.upsert(ctx, ev, m, true)
}

// upsert applies a message or an edit of one. It imports what is new, and
// rewrites what is imported when m carries a newer version; anything else is
// a repeat. It reports whether it saved the adapter state in the write.
func (r *runner) upsert(ctx context.Context, ev bridge.Event, m bridge.Message, isEdit bool) (bool, error) {
	l := r.links[m.Conversation]
	if l == nil || !l.BackfillDone {
		return false, nil
	}
	if err := r.prepareTopics(ctx, l, []bridge.Message{m}); err != nil {
		return false, err
	}
	from, err := r.e.db.ensurePuppet(ctx, r.account, m.From)
	if err != nil {
		return false, err
	}
	r.puppets[m.From.ID] = from
	files, err := r.copyFiles(ctx, l, []bridge.Message{m})
	if err != nil {
		return false, err
	}
	err = r.withLink(ctx, l, func(it *chat.ImportTx) error {
		k := messageKey{r.account.ID, l.ExternalChat, m.ID}
		have, err := lookupMessage(ctx, it.Tx(), k.account, k.chat, k.msg)
		if err != nil {
			return err
		}
		switch {
		case have != nil && m.Version > have.Version:
			if err := r.applyEdit(ctx, it, k, have, m); err != nil {
				return err
			}
		case have != nil:
			// A repeat of what is imported.
		default:
			ok, err := r.mayImport(ctx, it, k, l, m, isEdit)
			if err != nil {
				return err
			}
			if ok {
				if err := r.appendMessages(ctx, it, l, []bridge.Message{m}, map[string]int64{m.From.ID: from}, files); err != nil {
					return err
				}
			}
		}
		return saveState(ctx, it.Tx(), r.account.ID, ev.State)
	})
	return true, err
}

// mayImport reports whether a message not yet imported is imported now: not
// when a delete for it came first, and, for an edit, not when it is older
// than the oldest imported message (outside the history window).
func (r *runner) mayImport(ctx context.Context, it *chat.ImportTx, k messageKey, l *chatLink, m bridge.Message, isEdit bool) (bool, error) {
	gone, err := tombstoned(ctx, it.Tx(), k)
	if err != nil || gone {
		return false, err
	}
	if !isEdit {
		return true, nil
	}
	floor, err := earliestImported(ctx, it.Tx(), l.ChatID)
	if err != nil {
		return false, err
	}
	return floor.IsZero() || !m.Date.Before(floor), nil
}

// applyEdit rewrites an imported message when m is newer than the stored one.
func (r *runner) applyEdit(ctx context.Context, it *chat.ImportTx, k messageKey, have *importedMessage, m bridge.Message) error {
	text, ents := mapContent(m.Text, m.Entities, r.e.chat.MessageLengthMax(), r.userOf)
	if _, err := it.Edit(ctx, have.Seq, chat.ImportMessage{Text: text, Entities: ents, Buttons: chatButtons(m.Buttons)}); err != nil {
		return err
	}
	return setVersion(ctx, it.Tx(), k, m.Version)
}

// onDelete removes messages, or remembers the delete for a message that has
// not arrived yet.
func (r *runner) onDelete(ctx context.Context, ev bridge.Event, d bridge.Delete) (bool, error) {
	// Group what exists by chat; the rest become tombstones.
	byChat := map[int64][]int64{}
	links := map[int64]*chatLink{}
	var missing []messageKey
	for _, id := range d.IDs {
		have, err := lookupMessage(ctx, r.e.db.pool, r.account.ID, d.Conversation, id)
		if err != nil {
			return false, err
		}
		if have == nil {
			missing = append(missing, messageKey{r.account.ID, d.Conversation, id})
			continue
		}
		byChat[have.ChatID] = append(byChat[have.ChatID], have.Seq)
		if l := r.links[have.ExternalChat]; l != nil {
			links[have.ChatID] = l
		}
	}
	for chatID, seqs := range byChat {
		l := links[chatID]
		if l == nil {
			continue
		}
		if err := r.withLink(ctx, l, func(it *chat.ImportTx) error { return it.Delete(ctx, seqs) }); err != nil {
			return false, err
		}
	}
	if len(missing) > 0 {
		if d.Conversation != "" && r.links[d.Conversation] == nil {
			return false, nil // a chat that is not synced
		}
		err := pgx.BeginFunc(ctx, r.e.db.pool, func(tx pgx.Tx) error {
			for _, k := range missing {
				if err := addTombstone(ctx, tx, k); err != nil {
					return err
				}
			}
			return saveState(ctx, tx, r.account.ID, ev.State)
		})
		return true, err
	}
	return false, nil
}

// copyFiles copies the files of the messages of batch that are not yet
// imported, before any Chat transaction opens (a download can take long and
// the chat is locked while a transaction is open). Messages already imported
// are skipped, so repeating an import does not download twice.
func (r *runner) copyFiles(ctx context.Context, l *chatLink, batch []bridge.Message) (map[string]*appv1.Message, error) {
	var withMedia []bridge.Message
	for _, m := range batch {
		if len(m.Media) > 0 {
			withMedia = append(withMedia, m)
		}
	}
	if len(withMedia) == 0 || r.e.mediaSvc == nil {
		return nil, nil
	}
	ids := make([]string, len(withMedia))
	for i, m := range withMedia {
		ids[i] = m.ID
	}
	known, err := knownMessages(ctx, r.e.db.pool, r.account.ID, l.ExternalChat, ids)
	if err != nil {
		return nil, err
	}
	files := map[string]*appv1.Message{}
	for _, m := range withMedia {
		if known[m.ID] {
			continue
		}
		if content := r.copyFile(ctx, m); content != nil {
			files[m.ID] = content
		}
	}
	return files, nil
}

// chatButtons turns the link buttons of a bridge message into the buttons of
// an imported Chat message.
func chatButtons(rows [][]bridge.Button) [][]chat.IntegrationButton {
	out := make([][]chat.IntegrationButton, len(rows))
	for i, row := range rows {
		out[i] = make([]chat.IntegrationButton, len(row))
		for j, b := range row {
			out[i][j] = chat.IntegrationButton{Text: b.Text, URL: b.URL}
		}
	}
	return out
}
