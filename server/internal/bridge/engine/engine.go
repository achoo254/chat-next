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
	"sort"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
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
	// PageDelay is the pause between two history calls (default 1 s), so
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
	// DeleteConfirmAfter is how long the second confirmation of deleting a group in the
	// other app must wait before it can be used (default 10 s).
	DeleteConfirmAfter time.Duration
	// MemberActionsPerHour is the most actions on people in the other app (removing
	// them, making them admins) one account sends in an hour (default 10).
	MemberActionsPerHour int
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
		c.PageDelay = time.Second
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
	if c.DeleteConfirmAfter <= 0 {
		c.DeleteConfirmAfter = 10 * time.Second
	}
	if c.MemberActionsPerHour <= 0 {
		c.MemberActionsPerHour = 10
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
	// mentionsAt is, per conversation, the counts its mentions last matched at (syncMentions).
	mentionsAt map[string]mentionCounts
	e          *Engine
	account    *accountRow
	adapter    bridge.Adapter
	acct       bridge.Account
	logger     *slog.Logger
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
	// invitesTick counts the looks at the state of the chats, to read the invite links of groups once in a while.
	invitesTick int
	// membersTick counts the looks at the state of the chats, to read the members of groups once in a while.
	membersTick int
	// infoTick counts the looks at the state of the chats, to read the info of groups once in a while.
	infoTick int
	// reactionsTick counts the same looks, to read the reactions of the newest messages once in a while.
	reactionsTick int
	// pending are the chats waiting for their first import, oldest queued first.
	pending []*chatLink
	// stickerQueue are the chats whose label-only stickers are given their picture
	// (sticker_restore.go); stickerTried are the ones already tried in this run.
	stickerQueue []*chatLink
	stickerTried map[string]bool
	// stickerMarksCleared says the edit marks of stickers restored earlier are taken off in this run.
	stickerMarksCleared bool
	// syncNow asks the runner to read the account's switch again and list the conversations.
	syncNow chan struct{}
	// conversationsTick counts the looks at the state, to list the conversations once in a while.
	conversationsTick int
	// relist asks for the conversations to be listed again (a message came from one without a chat).
	relist bool
	// refusedUntil holds, by "what|conversation", until when a refused read is not asked again.
	refusedUntil map[string]time.Time
	// turn is where each look that reads conversation by conversation goes on next time.
	turn map[string]int
	// floodUntil is when the wait the other app last asked for ends (see holdFlood).
	floodUntil time.Time
	// windows are the history windows half read when the other app asked to wait, by link id.
	windows map[int64]windowProgress
	// photoHeld are the profile photos whose copy failed, by external_users.id (see pollPeoplePhotos).
	photoHeld map[int64]heldPhoto
	// botInfoHeld are the bots whose info could not be read, by external_users.id, until when (see pollBotInfos).
	botInfoHeld map[int64]time.Time
	// botsAnnounced: the account's bot puppets were announced to the owner's sessions on this connection (see announceBotsOnce).
	botsAnnounced bool
	// ownPhoneDone: the owner's own number was read for this connection, or need not be (see recordOwnPhone).
	ownPhoneDone bool
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
	runCtx, cancel := context.WithCancelCause(withLogger(ctx, r.logger))
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
	if retryUnsafe(r.adapter) {
		// A call cut off by a stop may have gone out and cannot be repeated blindly: the owner decides.
		if err := e.db.interruptedToUnknown(runCtx, r.account.ID); err != nil {
			return err
		}
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
		// Imported between events (importNext), so a long first sync of many chats
		// does not hold up what arrives meanwhile.
		r.pending = append(r.pending, l)
	}
	// The periodic reads and the imports put a long wait off instead of sleeping it in the loop.
	busyCtx := deferLongWaits(runCtx)
	if err := r.skipBusy(r.syncConversations(busyCtx), "sync", ""); err != nil {
		return r.settle(runCtx, err)
	}
	// A chat synced before pins were read gets them now; a chat that was just
	// imported got them at the end of its backfill.
	for _, l := range caughtUp {
		if r.floodHeld() {
			break // read at the next run; asking during the wait only makes it longer
		}
		if err := r.skipBusy(r.syncPins(busyCtx, l), "pins", l.ExternalChat); err != nil {
			return r.settle(runCtx, err)
		}
	}
	r.queueStickerRestore(caughtUp)
	outbox := time.NewTicker(e.cfg.OutboxPoll)
	defer outbox.Stop()
	imports := time.NewTicker(e.cfg.OutboxPoll)
	defer imports.Stop()
	states := time.NewTicker(e.cfg.StatePoll)
	defer states.Stop()
	if !r.floodHeld() {
		if err := r.skipBusy(r.pollAll(busyCtx), "sync", ""); err != nil {
			return r.settle(runCtx, err)
		}
	}
	for {
		select {
		case <-runCtx.Done():
			return r.settle(runCtx, context.Cause(runCtx))
		case <-outbox.C:
			if err := r.skipRefused(r.sendDue(runCtx), "sync", ""); err != nil {
				return r.settle(runCtx, err)
			}
		case <-states.C:
			if r.floodHeld() {
				continue
			}
			if err := r.skipBusy(r.pollAll(busyCtx), "sync", ""); err != nil {
				return r.settle(runCtx, err)
			}
			r.conversationsTick++
			if r.conversationsTick%conversationsEvery == 0 || r.relist {
				r.relist = false
				if err := r.skipBusy(r.syncConversations(busyCtx), "sync", ""); err != nil {
					return r.settle(runCtx, err)
				}
			}
		case <-imports.C:
			if r.floodHeld() {
				continue
			}
			if err := r.skipBusy(r.importNext(busyCtx), "sync", ""); err != nil {
				return r.settle(runCtx, err)
			}
			if err := r.skipBusy(r.restoreStickersNext(busyCtx), "sync", ""); err != nil {
				return r.settle(runCtx, err)
			}
		case <-r.syncNow:
			if err := r.reloadSyncState(runCtx); err != nil {
				return r.settle(runCtx, err)
			}
			if r.floodHeld() {
				r.relist = true // listed at the first look after the wait
				continue
			}
			if err := r.skipBusy(r.syncConversations(busyCtx), "sync", ""); err != nil {
				return r.settle(runCtx, err)
			}
		case err := <-subDone:
			if err == nil {
				err = errors.New("bridge: subscription ended")
			}
			return r.settle(runCtx, err)
		case l := <-r.cmds:
			// A nudge for the very link this run already imported (sent while it loaded the link at the start) is stale: importing it
			// again would put the other app's topic list back over changes made since, on either side.
			if have := r.links[l.ExternalChat]; have != nil && have.ID == l.ID && have.BackfillDone {
				continue
			}
			r.links[l.ExternalChat] = l
			if r.floodHeld() {
				r.pending = append([]*chatLink{l}, r.pending...) // imported first once the wait is over
				continue
			}
			if err := r.importOne(busyCtx, l); err != nil {
				return r.settle(runCtx, err)
			}
		case ev := <-events:
			if err := r.skipRefused(r.handle(runCtx, ev), "sync", ""); err != nil {
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

// refused reports that the other app refused a call about one conversation (no right
// there, a peer it no longer knows): retrying cannot help, and it must not stop the sync
// of the account's other conversations.
func refused(err error) bool { return errors.Is(err, bridge.ErrNotAllowed) }

// skipRefused logs a refusal about one conversation and lets the caller go on to the
// next; any other error comes back unchanged.
func (r *runner) skipRefused(err error, what, conv string) error {
	if !refused(err) {
		return err
	}
	r.logger.Warn("the other app refused this for one conversation; it is skipped", "what", what, "conversation", conv, "reason", err.Error())
	if conv != "" {
		r.refusedUntil[what+"|"+conv] = time.Now().Add(refusedPause)
	}
	return nil
}

// refusedPause is how long a read the other app refused for a conversation is not asked
// again: a right or a peer does not come back by itself within minutes, and asking every
// look costs calls and fills the log.
const refusedPause = 6 * time.Hour

// stillRefused reports whether what was refused for conv not long ago, so the look skips
// it without asking.
func (r *runner) stillRefused(what, conv string) bool {
	until, ok := r.refusedUntil[what+"|"+conv]
	if !ok {
		return false
	}
	if time.Now().After(until) {
		delete(r.refusedUntil, what+"|"+conv)
		return false
	}
	return true
}

// eachAlone asks again for each conversation of a batch on its own, after the other app
// refused the batch for one of them, and leaves out only the ones it refuses alone.
func eachAlone[T any](ctx context.Context, r *runner, what string, batch []string, call func([]string) (map[string]T, error)) (map[string]T, error) {
	out := map[string]T{}
	for _, conv := range batch {
		got, err := retryRateLimit(ctx, func() (map[string]T, error) { return call([]string{conv}) })
		if err != nil {
			if err := r.skipRefused(err, what, conv); err != nil {
				return nil, err
			}
			continue
		}
		for k, v := range got {
			out[k] = v
		}
	}
	return out, nil
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
		// The link and the keys of its messages go together: keys left behind would make a later copy of
		// the same conversation take every message for one it already has, and import nothing.
		return r.e.chat.DeleteImportedChat(ctx, r.account.OwnerID, l.ChatID)
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
		if limit.RetryAfter > maxInlineWait && defersLongWaits(ctx) {
			// Sleeping here would hold the run's only loop (live events, sends from Chat, the
			// other reads) for as long as the other app asks; the caller defers instead.
			return v, err
		}
		// A long wait is said, or the sync looks stuck while it waits.
		if limit.RetryAfter >= rateLimitLogAfter {
			loggerFrom(ctx).Warn("the other app asked to wait before the next call; waiting", "wait", limit.RetryAfter.String(), "until", time.Now().Add(limit.RetryAfter).Format(time.TimeOnly))
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
	newestFirst, cur, complete := r.takeWindow(l)
	for !complete && len(newestFirst) < l.HistoryMax {
		page, err := retryRateLimit(ctx, func() (bridge.Page, error) {
			return r.adapter.Backfill(ctx, r.acct, l.ExternalChat, cur, min(r.e.cfg.PageSize, l.HistoryMax-len(newestFirst)))
		})
		if err != nil {
			var limit *bridge.RateLimitError
			if errors.As(err, &limit) && len(newestFirst) > 0 {
				r.keepWindow(l, newestFirst, cur) // the next try goes on from this page
			}
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
			if isWait(err) {
				// A file or the topics of the batch must wait: the window read stays, and
				// what is written already (earlier batches, the start of this one) is skipped next time.
				r.keepWholeWindow(l, msgs)
				return err
			}
			if !isSkippable(err) {
				return err
			}
			// Chat refused something in the batch: take the messages one by
			// one, so a single bad message costs only itself.
			r.logger.Warn("history batch refused; importing its messages one by one", "reason", err.Error(), "messages", len(batch))
			for i := range batch {
				if err := r.importBatch(ctx, l, batch[i:i+1]); err != nil {
					if isWait(err) {
						r.keepWholeWindow(l, msgs)
						return err
					}
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
	files, waitsAt, err := r.copyFiles(ctx, l, batch)
	if err != nil {
		if waitsAt > 0 {
			// The files before the one that must wait are copied already: their messages
			// are written now, so the next try does not fetch them again.
			if werr := r.writeBatch(ctx, l, batch[:waitsAt], senders, files); werr != nil {
				return werr
			}
		}
		return err
	}
	return r.writeBatch(ctx, l, batch, senders, files)
}

// writeBatch writes the messages of batch Chat does not have yet, in one transaction.
func (r *runner) writeBatch(ctx context.Context, l *chatLink, batch []bridge.Message, senders map[string]int64, files map[string]*appv1.Message) error {
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
		return r.appendMessages(ctx, it, l, fresh, senders, files, false)
	})
}

// appendMessages writes fresh messages (oldest first) into the chat, records
// their keys, and wires replies in both directions.
func (r *runner) appendMessages(ctx context.Context, it *chat.ImportTx, l *chatLink, fresh []bridge.Message, senders map[string]int64, files map[string]*appv1.Message, live bool) error {
	fresh, err := r.keepServiceLines(ctx, l, fresh)
	if err != nil {
		return err
	}
	// A system line becomes Chat's action; one that cannot be shown is left out.
	actions := map[string]*appv1.MessageAction{}
	kept := fresh[:0:0]
	for _, m := range fresh {
		if m.Service == nil {
			kept = append(kept, m)
			continue
		}
		a, ok, err := r.serviceAction(ctx, it, l, m.Service, senders[m.From.ID])
		if err != nil {
			return err
		}
		if ok {
			actions[m.ID] = a
			kept = append(kept, m)
		}
	}
	fresh = kept
	if len(fresh) == 0 {
		return nil
	}
	topicIDs, err := r.topicIDs(ctx, it, l, fresh)
	if err != nil {
		return err
	}
	// A message that just arrived notifies, when the alerts feature receives for this chat; history does not.
	notify := false
	if live {
		dir, err := r.e.db.featureDirection(ctx, r.account.ID, l.ExternalChat, feature.Alerts)
		if err != nil {
			return err
		}
		notify = dir.Receives()
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
		if a := actions[m.ID]; a != nil {
			imports[i] = chat.ImportMessage{FromID: from, Date: m.Date, Content: &appv1.Message{Action: a}, TopicID: topicIDs[m.Topic]}
			continue
		}
		content := files[m.ID]
		label := labelFor(m, content != nil)
		if m.Forward != nil {
			header, err := r.forwardHeader(ctx, m.Forward)
			if err != nil {
				return err
			}
			if content == nil {
				content = &appv1.Message{}
			}
			content.ForwardFrom = header
		}
		if label == "" && m.Text == "" && files[m.ID] == nil {
			label = "[Tin nhắn không hỗ trợ]" // an empty message cannot be stored
		}
		labelled, moved := withLabel(label, m.Text, m.Entities)
		text, ents := mapContent(labelled, moved, r.e.chat.MessageLengthMax(), r.userOf)
		imports[i] = chat.ImportMessage{FromID: from, Date: m.Date, Text: text, Entities: ents, Content: content, TopicID: topicIDs[m.Topic], Buttons: chatButtons(m.Buttons), Notify: notify && from != r.account.OwnerID, OwnerMention: ownerMention(m.Mention)}
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
	if l == nil && r.syncOn() {
		r.relist = true // a conversation without a chat yet: it gets one, this message with its history
	}
	if l == nil {
		return false, nil
	}
	if !l.BackfillDone {
		// A chat whose first import waits with part of its history read takes the message
		// into that part, or it would fall between the pages read and the import.
		r.foldIntoWindow(l, m, isEdit)
		// An edit of a message an earlier batch already wrote is applied now: the import
		// skips messages Chat has, so the edit would be lost there.
		if !isEdit {
			return false, nil
		}
		have, err := lookupMessage(ctx, r.e.db.pool, r.account.ID, m.Conversation, m.ID)
		if err != nil || have == nil {
			return false, err
		}
	}
	if err := r.prepareTopics(ctx, l, []bridge.Message{m}); err != nil {
		return false, err
	}
	from, err := r.e.db.ensurePuppet(ctx, r.account, m.From)
	if err != nil {
		return false, err
	}
	r.puppets[m.From.ID] = from
	if m.Peer != nil {
		// The owner's own message names the other side: a chat met nameless takes its name.
		if _, err := r.e.db.ensurePuppet(ctx, r.account, *m.Peer); err != nil {
			return false, err
		}
	}
	files, _, err := r.copyFiles(ctx, l, []bridge.Message{m})
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
				if err := r.appendMessages(ctx, it, l, []bridge.Message{m}, map[string]int64{m.From.ID: from}, files, !isEdit); err != nil {
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
	if _, err := it.Edit(ctx, have.Seq, chat.ImportMessage{Text: text, Entities: ents, Buttons: chatButtons(m.Buttons), OwnerMention: ownerMention(m.Mention)}); err != nil {
		return err
	}
	return setVersion(ctx, it.Tx(), k, m.Version)
}

// onDelete removes messages, or remembers the delete for a message that has
// not arrived yet.
// onRead moves the owner's outbox read position: the other side read what the
// owner sent up to rd.MaxID.
func (r *runner) onRead(ctx context.Context, ev bridge.Event, rd bridge.Read) (bool, error) {
	l := r.links[rd.Conversation]
	if l == nil || !l.BackfillDone {
		return false, nil
	}
	seq, err := newestSeqUpTo(ctx, r.e.db.pool, r.account.ID, rd.Conversation, rd.MaxID)
	if err != nil || seq == 0 {
		return false, err
	}
	err = r.withLink(ctx, l, func(it *chat.ImportTx) error {
		if err := it.MarkPeerRead(ctx, seq); err != nil {
			return err
		}
		return saveState(ctx, it.Tx(), r.account.ID, ev.State)
	})
	return true, err
}

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
// are skipped, so repeating an import does not download twice. When the other
// app asks to wait for a file (only during an import, see copyFile), waitsAt is
// the index in batch of its message: the files before it are in the map.
func (r *runner) copyFiles(ctx context.Context, l *chatLink, batch []bridge.Message) (files map[string]*appv1.Message, waitsAt int, err error) {
	var withMedia []bridge.Message
	for _, m := range batch {
		if len(m.Media) > 0 {
			withMedia = append(withMedia, m)
		}
	}
	if len(withMedia) == 0 || r.e.mediaSvc == nil {
		return nil, 0, nil
	}
	ids := make([]string, len(withMedia))
	for i, m := range withMedia {
		ids[i] = m.ID
	}
	known, err := knownMessages(ctx, r.e.db.pool, r.account.ID, l.ExternalChat, ids)
	if err != nil {
		return nil, 0, err
	}
	files = map[string]*appv1.Message{}
	for _, m := range withMedia {
		if known[m.ID] {
			continue
		}
		content, err := r.copyFile(ctx, m)
		if err != nil {
			return files, slices.IndexFunc(batch, func(b bridge.Message) bool { return b.ID == m.ID }), err
		}
		if content != nil {
			files[m.ID] = content
		}
	}
	return files, 0, nil
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

// rateLimitLogAfter: a wait the other app asks for at least this long is logged.
var rateLimitLogAfter = 10 * time.Second

type loggerKey struct{}

// withLogger carries the runner's logger to helpers that only get a context.
func withLogger(ctx context.Context, l *slog.Logger) context.Context {
	return context.WithValue(ctx, loggerKey{}, l)
}

// loggerFrom is the logger withLogger put in ctx, else the default one.
func loggerFrom(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(loggerKey{}).(*slog.Logger); ok && l != nil {
		return l
	}
	return slog.Default()
}

// pollBudget is how many conversations one look reads for one feature. With every
// conversation of an account synced (191 for the first real one), reading them all at
// once made the other app ask to wait for minutes on end, and the run did nothing else
// meanwhile; a budget spreads the reads over the looks, in turn.
var pollBudget = 20

// inTurn lists the conversations this look reads for what: the next pollBudget of the
// imported chats, in a fixed order, going round.
func (r *runner) inTurn(what string) []string {
	var all []string
	for conv, l := range r.links {
		if l.BackfillDone {
			all = append(all, conv)
		}
	}
	if len(all) <= pollBudget {
		return all
	}
	sort.Strings(all)
	start := r.turn[what] % len(all)
	out := make([]string, 0, pollBudget)
	for i := 0; i < pollBudget; i++ {
		out = append(out, all[(start+i)%len(all)])
	}
	r.turn[what] = (start + pollBudget) % len(all)
	return out
}
