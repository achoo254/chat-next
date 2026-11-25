package zalo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"app.local/server/internal/bridge"
)

// subscription is the sidecar listening for one account.
type subscription struct {
	side      *sidecar
	loggedOut atomic.Bool
}

// listening is what one subscription knows about its account.
type listening struct {
	account     string // Account.ID
	uid         string // the Zalo account the stored session belongs to
	fingerprint string // of the stored session
	connected   bool
}

// Subscribe implements bridge.Adapter: it starts a sidecar with the stored
// session and delivers 1-1 messages until ctx ends or the sidecar stops. Every
// stop is an error the engine retries with its backoff (one sidecar per
// call), except a session Zalo keeps refusing over time (ErrSessionRevoked,
// see session_refusals.go) and a session that logs in as another Zalo account
// (errAccountMismatch, not tried again until the account signs in anew).
// Zalo cannot replay what was missed while offline, so acct.State is unused.
func (a *Adapter) Subscribe(ctx context.Context, acct bridge.Account, out chan<- bridge.Event) error {
	forSidecar, uid, err := openStored(acct.Session)
	if err != nil {
		return fmt.Errorf("%w: %w", bridge.ErrSessionRevoked, err)
	}
	st := &listening{account: acct.ID, uid: uid, fingerprint: sessionFingerprint(acct.Session)}
	a.mu.Lock()
	refused := a.mismatched[acct.ID] == st.fingerprint
	a.mu.Unlock()
	if refused {
		return errAccountMismatch
	}
	side, err := startSidecar(ctx, a.runner, a.logger, a.timing)
	if err != nil {
		return err
	}
	sub := &subscription{side: side}
	a.mu.Lock()
	previous := a.subs[acct.ID]
	a.subs[acct.ID] = sub
	a.mu.Unlock()
	if previous != nil {
		previous.side.stop() // one listener per account: Zalo kicks the older one anyway
	}
	defer func() {
		side.stop()
		a.mu.Lock()
		if a.subs[acct.ID] == sub {
			delete(a.subs, acct.ID)
		}
		a.mu.Unlock()
	}()
	if err := side.send(command{Cmd: cmdLoginSession, Session: forSidecar}); err != nil {
		return err
	}
	return a.listen(ctx, st, sub, out)
}

// listen handles the events of a subscribed sidecar.
func (a *Adapter) listen(ctx context.Context, st *listening, sub *subscription, out chan<- bridge.Event) error {
	heard := a.heardFor(st.account)
	own := a.sendStateFor(st.account).log
	groupsIgnored := 0
	// A login Zalo never answers must not hold the account forever.
	connectTimer := time.NewTimer(a.timing.connect)
	defer connectTimer.Stop()
	for {
		var ev wireEvent
		var ok bool
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-connectTimer.C:
			if !st.connected {
				return errors.New("zalo: the listener did not connect in time")
			}
			continue
		case ev, ok = <-sub.side.events:
		}
		if !ok {
			if sub.loggedOut.Load() {
				return fmt.Errorf("%w: logged out from Chat", bridge.ErrSessionRevoked)
			}
			return errors.New("zalo: sidecar exited")
		}
		switch ev.Ev {
		case evMessage:
			if ev.Thread == threadGroup {
				groupsIgnored++
				a.logger.Debug("zalo group message ignored", "ignored_since_connect", groupsIgnored)
				continue
			}
			if err := a.deliver(ctx, heard, own, ev, out); err != nil {
				return err
			}
		case evOther:
			var err error
			switch ev.Name {
			case "undo":
				err = a.deliverUndo(ctx, heard, ev, out)
			case "reaction":
				err = a.deliverReaction(ctx, heard, st.uid, ev, out)
			}
			if err != nil {
				return err
			}
		case evAccount:
			if err := a.checkAccount(st, string(ev.UID)); err != nil {
				return err
			}
		case evListener:
			if err := a.listenerState(st, ev); err != nil {
				return err
			}
		case evError:
			if err := a.sidecarError(st, ev); err != nil {
				return err
			}
		}
	}
}

// deliverUndo hands the engine the recall of a 1-1 message, so Chat removes
// the copy it holds; a recall of a message Chat has not copied yet is kept as a
// tombstone by the engine.
func (a *Adapter) deliverUndo(ctx context.Context, heard *heardAccount, ev wireEvent, out chan<- bridge.Event) error {
	conv, id, err := mapUndo(ev.Payload)
	if err != nil {
		a.logger.Debug("zalo recall dropped", "reason", err.Error())
		return nil
	}
	heard.forget(conv, id)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case out <- bridge.Event{Delete: &bridge.Delete{Conversation: conv, IDs: []string{id}}}:
		return nil
	}
}

// deliverReaction hands the engine the reactions Zalo reports for 1-1 messages.
func (a *Adapter) deliverReaction(ctx context.Context, heard *heardAccount, ownerUID string, ev wireEvent, out chan<- bridge.Event) error {
	var probe struct {
		ThreadID looseString `json:"threadId"`
	}
	_ = json.Unmarshal(ev.Payload, &probe)
	conv := string(probe.ThreadID)
	peer := bridge.Participant{ID: conv, Name: "Zalo " + conv, NameUnknown: true}
	if known := heard.peer(conv); known != nil {
		peer = *known
	}
	_, list, err := mapReactions(ev.Payload, peer, bridge.Participant{ID: ownerUID, IsSelf: true})
	if err != nil {
		a.logger.Debug("zalo reaction dropped", "reason", err.Error())
		return nil
	}
	for i := range list {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case out <- bridge.Event{Reactions: &list[i]}:
		}
	}
	return nil
}

// deliver maps a 1-1 message, drops a repeat, keeps it for ListConversations
// and Backfill (and, for the owner's own text, for matching a repeated send),
// then hands it to the engine.
func (a *Adapter) deliver(ctx context.Context, heard *heardAccount, own *sentLog, ev wireEvent, out chan<- bridge.Event) error {
	m, conv, err := mapMessage(ev, a.now())
	if err != nil {
		a.logger.Debug("zalo message dropped", "reason", err.Error())
		return nil
	}
	if !heard.firstSighting(m.ID) {
		return nil
	}
	heard.record(conv, m)
	if text, ok := textContent(ev.Content); ok && ev.Self && string(ev.MsgType) == msgTypeText {
		own.heard(ownMessage{conv: conv.ID, text: hashText(text), id: m.ID, date: m.Date})
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case out <- bridge.Event{Message: &m}:
		return nil
	}
}
