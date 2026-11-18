// Package contracttest has an in-memory bridge.Adapter that behaves like a
// chat app with a replayable update log (as Telegram's pts is): the engine's
// scenarios run on it, and a real adapter can be checked against the same
// behaviour. The automatic tests never touch a real account.
package contracttest

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"time"

	"app.local/server/internal/bridge"
)

// Fake is a scriptable app. Methods are safe to call from the test while
// the engine uses the adapter.
type Fake struct {
	mu       sync.Mutex
	name     string
	convs    []bridge.Conversation
	history  map[string][]bridge.Message // oldest first
	log      []bridge.Event              // every live event, State = its index+1
	wake     chan struct{}
	failSub  []error
	failPage []error
	// BeforePage runs before each Backfill call is answered (a test pushes a
	// live event here to land it in the middle of a history import).
	BeforePage                                 func(conv string, pageNo int)
	pages                                      map[string]int
	backfillCalls, subscribeCalls, logoutCalls int
	failSend                                   []error
	sentByRandom                               map[int64]bridge.SentRef
	sent                                       []bridge.OutMessage
	edits                                      []bridge.EditRequest
	deletes                                    []bridge.Delete
	nextID                                     int
	topics                                     map[string][]bridge.Topic
	// DedupeRandomID makes a repeated RandomID answer with the message already
	// sent, as the other app does; a test turns it off to see a duplicate.
	DedupeRandomID bool
	// EchoSent pushes each sent message back as a live event of the account
	// owner, as the other app does for the account that sent it.
	EchoSent bool
}

// NewFake makes an app called name.
func NewFake(name string) *Fake {
	return &Fake{name: name, history: map[string][]bridge.Message{}, wake: make(chan struct{}, 1), pages: map[string]int{},
		sentByRandom: map[int64]bridge.SentRef{}, topics: map[string][]bridge.Topic{}, DedupeRandomID: true, EchoSent: true, nextID: 900000}
}

// AddConversation lists a conversation.
func (f *Fake) AddConversation(c bridge.Conversation) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.convs = append(f.convs, c)
}

// AddHistory appends messages (oldest first) to the history of a conversation.
func (f *Fake) AddHistory(conv string, msgs ...bridge.Message) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range msgs {
		msgs[i].Conversation = conv
	}
	f.history[conv] = append(f.history[conv], msgs...)
}

// Push records a live event; the engine receives it (again, after a
// reconnect from an older state) through Subscribe.
func (f *Fake) Push(ev bridge.Event) {
	f.mu.Lock()
	ev.State = []byte(strconv.Itoa(len(f.log) + 1))
	if ev.Message != nil {
		f.history[ev.Message.Conversation] = append(f.history[ev.Message.Conversation], *ev.Message)
	}
	f.log = append(f.log, ev)
	f.mu.Unlock()
	select {
	case f.wake <- struct{}{}:
	default:
	}
}

// FailSubscribe makes the next Subscribe calls return errs, one each.
func (f *Fake) FailSubscribe(errs ...error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failSub = append(f.failSub, errs...)
}

// FailBackfill makes the next Backfill calls return errs, one each.
func (f *Fake) FailBackfill(errs ...error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failPage = append(f.failPage, errs...)
}

// Name implements bridge.Adapter.
func (f *Fake) Name() string { return f.name }

// Capabilities implements bridge.Adapter.
func (f *Fake) Capabilities() bridge.Capabilities {
	return bridge.Capabilities{bridge.CapHistory: true, bridge.CapLive: true, bridge.CapEdits: true, bridge.CapDeletes: true, bridge.CapSend: true, bridge.CapTopics: true}
}

// Login implements bridge.Adapter: two input steps, then done.
func (f *Fake) Login(_ context.Context, prior string, in map[string]string) (bridge.LoginStep, error) {
	switch prior {
	case "":
		return bridge.LoginStep{Kind: bridge.StepInput, Token: "code", Fields: []bridge.Field{{Name: "phone", Label: "Phone", Secret: true}}}, nil
	case "code":
		if in["phone"] == "" {
			return bridge.LoginStep{}, &bridge.InputError{Message: "phone required"}
		}
		return bridge.LoginStep{Kind: bridge.StepInput, Token: "done", Fields: []bridge.Field{{Name: "code", Label: "Code", Secret: true}}}, nil
	default:
		if in["code"] != "12345" {
			return bridge.LoginStep{}, &bridge.InputError{Message: "wrong code"}
		}
		return bridge.LoginStep{Kind: bridge.StepDone, Session: []byte("fake-session"), Account: "fake-user-1"}, nil
	}
}

// Logout implements bridge.Adapter.
func (f *Fake) Logout(context.Context, bridge.Account) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logoutCalls++
	return nil
}

// ListConversations implements bridge.Adapter.
func (f *Fake) ListConversations(context.Context, bridge.Account) ([]bridge.Conversation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bridge.Conversation(nil), f.convs...), nil
}

// Backfill implements bridge.Adapter: pages of history, newest first.
func (f *Fake) Backfill(_ context.Context, _ bridge.Account, conv string, cur bridge.Cursor, limit int) (bridge.Page, error) {
	f.mu.Lock()
	f.backfillCalls++
	f.pages[conv]++
	pageNo := f.pages[conv]
	hook := f.BeforePage
	f.mu.Unlock()
	if hook != nil {
		hook(conv, pageNo)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.failPage) > 0 {
		err := f.failPage[0]
		f.failPage = f.failPage[1:]
		return bridge.Page{}, err
	}
	hist := f.history[conv]
	end := len(hist)
	if cur.Before != "" {
		end = 0
		for i, m := range hist {
			if m.ID == cur.Before {
				end = i
				break
			}
		}
	}
	start := max(end-limit, 0)
	page := bridge.Page{Done: start == 0}
	for i := end - 1; i >= start; i-- {
		page.Messages = append(page.Messages, hist[i])
	}
	if !page.Done {
		page.Next = bridge.Cursor{Before: hist[start].ID}
	}
	return page, nil
}

// Subscribe implements bridge.Adapter: it replays the log after
// acct.State, then delivers events as they are pushed.
func (f *Fake) Subscribe(ctx context.Context, acct bridge.Account, out chan<- bridge.Event) error {
	f.mu.Lock()
	f.subscribeCalls++
	if len(f.failSub) > 0 {
		err := f.failSub[0]
		f.failSub = f.failSub[1:]
		f.mu.Unlock()
		return err
	}
	f.mu.Unlock()
	next := 0
	if len(acct.State) > 0 {
		n, err := strconv.Atoi(string(acct.State))
		if err != nil {
			return fmt.Errorf("bad state %q", acct.State)
		}
		next = n
	}
	for {
		f.mu.Lock()
		var ev *bridge.Event
		if next < len(f.log) {
			e := f.log[next]
			ev = &e
			next++
		}
		f.mu.Unlock()
		if ev == nil {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-f.wake:
			case <-time.After(20 * time.Millisecond):
			}
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case out <- *ev:
		}
	}
}

// FetchMedia implements bridge.Adapter: the fake has no media.
func (f *Fake) FetchMedia(context.Context, bridge.Account, string) (bridge.MediaStream, error) {
	return nil, fmt.Errorf("fake adapter has no media")
}

// BackfillCalls is how many history calls were made.
func (f *Fake) BackfillCalls() int { f.mu.Lock(); defer f.mu.Unlock(); return f.backfillCalls }

// SubscribeCalls is how many times a live subscription was opened.
func (f *Fake) SubscribeCalls() int { f.mu.Lock(); defer f.mu.Unlock(); return f.subscribeCalls }

// LogoutCalls is how many sessions were logged out.
func (f *Fake) LogoutCalls() int { f.mu.Lock(); defer f.mu.Unlock(); return f.logoutCalls }

// FailSend makes the next SendMessage calls return errs, one each.
func (f *Fake) FailSend(errs ...error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failSend = append(f.failSend, errs...)
}

// SendMessage implements bridge.Sender.
func (f *Fake) SendMessage(_ context.Context, _ bridge.Account, m bridge.OutMessage) (bridge.SentRef, error) {
	f.mu.Lock()
	if len(f.failSend) > 0 {
		err := f.failSend[0]
		f.failSend = f.failSend[1:]
		f.mu.Unlock()
		return bridge.SentRef{}, err
	}
	if f.DedupeRandomID && m.RandomID != 0 {
		if ref, ok := f.sentByRandom[m.RandomID]; ok {
			f.mu.Unlock()
			return ref, nil
		}
	}
	count := max(len(m.Media), 1)
	ref := bridge.SentRef{Date: time.Now()}
	var echoes []bridge.Message
	for i := 0; i < count; i++ {
		f.nextID++
		id := strconv.Itoa(f.nextID)
		ref.IDs = append(ref.IDs, id)
		msg := bridge.Message{Conversation: m.Conversation, ID: id, From: bridge.Participant{ID: "self", IsSelf: true},
			Date: ref.Date, ReplyTo: m.ReplyTo}
		if i == 0 {
			msg.Text, msg.Entities = m.Text, m.Entities
		}
		echoes = append(echoes, msg)
	}
	f.sent = append(f.sent, m)
	if m.RandomID != 0 {
		f.sentByRandom[m.RandomID] = ref
	}
	echo := f.EchoSent
	f.mu.Unlock()
	if echo {
		for i := range echoes {
			msg := echoes[i]
			f.Push(bridge.Event{Message: &msg})
		}
	}
	return ref, nil
}

// EditMessage implements bridge.Sender.
func (f *Fake) EditMessage(_ context.Context, _ bridge.Account, e bridge.EditRequest) error {
	f.mu.Lock()
	f.edits = append(f.edits, e)
	f.mu.Unlock()
	return nil
}

// DeleteMessages implements bridge.Sender.
func (f *Fake) DeleteMessages(_ context.Context, _ bridge.Account, d bridge.Delete) error {
	f.mu.Lock()
	f.deletes = append(f.deletes, d)
	f.mu.Unlock()
	return nil
}

// Sent is every message that SendMessage accepted (a deduplicated repeat is
// not counted twice).
func (f *Fake) Sent() []bridge.OutMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bridge.OutMessage(nil), f.sent...)
}

// Edits is every edit received.
func (f *Fake) Edits() []bridge.EditRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bridge.EditRequest(nil), f.edits...)
}

// Deletes is every delete received.
func (f *Fake) Deletes() []bridge.Delete {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bridge.Delete(nil), f.deletes...)
}

var _ bridge.Sender = (*Fake)(nil)

// AddTopic makes a topic of a forum conversation known to ListTopics.
func (f *Fake) AddTopic(conv string, t bridge.Topic) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.topics[conv] = append(f.topics[conv], t)
}

// ListTopics implements bridge.TopicReader.
func (f *Fake) ListTopics(_ context.Context, _ bridge.Account, conv string) ([]bridge.Topic, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bridge.Topic(nil), f.topics[conv]...), nil
}

var _ bridge.TopicReader = (*Fake)(nil)
