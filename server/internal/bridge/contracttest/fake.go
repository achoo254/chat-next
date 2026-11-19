// Package contracttest has an in-memory bridge.Adapter that behaves like a
// chat app with a replayable update log (as Telegram's pts is): the engine's
// scenarios run on it, and a real adapter can be checked against the same
// behaviour. The automatic tests never touch a real account.
package contracttest

import (
	"bytes"
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
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
	pinned                                     map[string][]string // newest first
	support                                    map[feature.Feature]feature.Support
	dialogs                                    map[string]bridge.DialogState
	dialogCalls                                []string
	infos                                      map[string]bridge.GroupInfo
	infoCalls                                  []string
	topicEdits                                 []string
	members                                    map[string][]bridge.Member
	partial                                    map[string]bool
	memberCalls                                []string
	invites                                    map[string][]bridge.InviteLink
	reads                                      []string
	lifecycle                                  []string
	pinCalls                                   []PinCall
	reactions                                  map[string]map[string]string // conv/msg -> participant -> emoji
	reactionCalls                              []string
	failPin                                    []error
	failTopicEdit                              error
	topicCreates                               []string
	photoBytes                                 map[string][]byte
	photoCalls                                 []string
	photoFetches                               int
	forwards                                   []string
	refuse                                     map[string]bool
	topicByRandom                              map[int64]string
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
		sentByRandom: map[int64]bridge.SentRef{}, topics: map[string][]bridge.Topic{}, pinned: map[string][]string{}, support: defaultSupport(), dialogs: map[string]bridge.DialogState{}, infos: map[string]bridge.GroupInfo{}, members: map[string][]bridge.Member{}, partial: map[string]bool{}, invites: map[string][]bridge.InviteLink{}, reactions: map[string]map[string]string{}, topicByRandom: map[int64]string{}, photoBytes: map[string][]byte{}, refuse: map[string]bool{}, DedupeRandomID: true, EchoSent: true, nextID: 900000}
}

func defaultSupport() map[feature.Feature]feature.Support {
	return map[feature.Feature]feature.Support{
		feature.Messages:  {In: true, Out: true},
		feature.Pins:      {In: true, Out: true},
		feature.Topics:    {In: true, Out: true},
		feature.Read:      {In: true, Out: true},
		feature.Reactions: {In: true, Out: true},
		feature.Alerts:    {In: true},
		feature.Service:   {In: true},
		feature.Notify:    {In: true, Out: true},
		feature.Dialog:    {In: true, Out: true},
		feature.Info:      {In: true, Out: true},
		feature.Members:   {In: true, Out: true},
		feature.Invites:   {In: true, Out: true},
		feature.Lifecycle: {Out: true},
	}
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

// Capabilities implements bridge.Adapter. They follow the features the fake is
// set to support, as a real adapter's do.
func (f *Fake) Capabilities() bridge.Capabilities {
	sup := f.Features()
	caps := bridge.Capabilities{bridge.CapHistory: true, bridge.CapLive: true}
	if sup[feature.Messages].Out {
		caps[bridge.CapSend], caps[bridge.CapEdits], caps[bridge.CapDeletes] = true, true, true
	}
	if sup[feature.Topics].In {
		caps[bridge.CapTopics] = true
	}
	if sup[feature.Pins].In || sup[feature.Pins].Out {
		caps[bridge.CapPins] = true
	}
	return caps
}

// Features implements bridge.Featured: by default everything the contract has
// except what acts on people, which no adapter here does.
func (f *Fake) Features() map[feature.Feature]feature.Support {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[feature.Feature]feature.Support, len(f.support))
	for k, v := range f.support {
		out[k] = v
	}
	return out
}

// Support sets what the fake can do for a feature, to stand for an app with
// another set of features (a read-only app, one without pins...). A feature
// with neither direction is removed.
func (f *Fake) Support(feat feature.Feature, s feature.Support) *Fake {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !s.In && !s.Out {
		delete(f.support, feat)
		return f
	}
	f.support[feat] = s
	return f
}

// supports reports whether Chat may make changes of the feature in the fake.
func (f *Fake) canWrite(feat feature.Feature) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.support[feat].Out
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
	if f.refuse[conv] {
		f.mu.Unlock()
		return bridge.Page{}, refusedErr(conv)
	}
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
func (f *Fake) FetchMedia(_ context.Context, _ bridge.Account, ref string) (bridge.MediaStream, error) {
	if conv, ok := strings.CutPrefix(ref, fakePhotoRef); ok {
		f.mu.Lock()
		data := f.photoBytes[conv]
		f.photoFetches++
		f.mu.Unlock()
		if data != nil {
			return &fakeStream{Reader: bytes.NewReader(data), size: int64(len(data))}, nil
		}
	}
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

// SetPinned sets the ids a conversation has pinned (newest first), as
// ListPinned answers them.
func (f *Fake) SetPinned(conv string, ids ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pinned[conv] = append([]string(nil), ids...)
}

// ListPinned implements bridge.PinReader.
func (f *Fake) ListPinned(_ context.Context, _ bridge.Account, conv string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.pinned[conv]...), nil
}

var _ bridge.PinReader = (*Fake)(nil)

// PinCall is one call to PinMessage (Topic empty) or PinTopic.
type PinCall struct {
	Conversation string
	Message      string
	Topic        string
	Pinned       bool
}

// FailTopicEdits makes every topic edit return err until it is called with nil.
func (f *Fake) FailTopicEdits(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failTopicEdit = err
}

// FailPin makes the next pin calls return errs, one each.
func (f *Fake) FailPin(errs ...error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failPin = append(f.failPin, errs...)
}

// Pins returns the pin calls made so far.
func (f *Fake) Pins() []PinCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]PinCall(nil), f.pinCalls...)
}

func (f *Fake) nextPinFailure() error {
	if len(f.failPin) == 0 {
		return nil
	}
	err := f.failPin[0]
	f.failPin = f.failPin[1:]
	return err
}

// PinMessage implements bridge.Pinner; like the other app it tells the account
// owner what changed (EchoSent).
func (f *Fake) PinMessage(_ context.Context, _ bridge.Account, conv, id string, pinned bool) error {
	if !f.canWrite(feature.Pins) {
		return fmt.Errorf("%w: this app does not take pins from Chat", bridge.ErrNotAllowed)
	}
	f.mu.Lock()
	if err := f.nextPinFailure(); err != nil {
		f.mu.Unlock()
		return err
	}
	f.pinCalls = append(f.pinCalls, PinCall{Conversation: conv, Message: id, Pinned: pinned})
	list := slices.DeleteFunc(append([]string(nil), f.pinned[conv]...), func(x string) bool { return x == id })
	if pinned {
		list = append([]string{id}, list...)
	}
	f.pinned[conv] = list
	echo := f.EchoSent
	f.mu.Unlock()
	if echo {
		f.Push(bridge.Event{Pin: &bridge.PinChange{Conversation: conv, IDs: []string{id}, Pinned: pinned}})
	}
	return nil
}

// PinTopic implements bridge.Pinner.
func (f *Fake) PinTopic(_ context.Context, _ bridge.Account, conv, topic string, pinned bool) error {
	if !f.canWrite(feature.Topics) {
		return fmt.Errorf("%w: this app does not take topic pins from Chat", bridge.ErrNotAllowed)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.nextPinFailure(); err != nil {
		return err
	}
	f.pinCalls = append(f.pinCalls, PinCall{Conversation: conv, Topic: topic, Pinned: pinned})
	for i := range f.topics[conv] {
		if f.topics[conv][i].ID == topic {
			f.topics[conv][i].Pinned = pinned
		}
	}
	return nil
}

var _ bridge.Pinner = (*Fake)(nil)
var _ bridge.Featured = (*Fake)(nil)

// SetDialogState sets how the owner has a conversation in the app, as if they had
// changed it there; DialogStates answers it.
func (f *Fake) SetDialogState(conv string, st bridge.DialogState) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dialogs[conv] = st
}

// DialogState is what the app has now for a conversation.
func (f *Fake) DialogState(conv string) bridge.DialogState {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.dialogs[conv]
}

// DialogCalls lists the calls Chat made to change the state of a conversation, as
// "mute:<conv>:<until>", "pin:<conv>:<bool>" and "unread:<conv>:<bool>".
func (f *Fake) DialogCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.dialogCalls...)
}

// DialogStates implements bridge.DialogReader.
func (f *Fake) DialogStates(_ context.Context, _ bridge.Account, convs []string) (map[string]bridge.DialogState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.refusedOne(convs); err != nil {
		return nil, err
	}
	out := map[string]bridge.DialogState{}
	for _, c := range convs {
		out[c] = f.dialogs[c]
	}
	return out, nil
}

func (f *Fake) writeDialog(feat feature.Feature, call string, change func()) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.support[feat].Out {
		return fmt.Errorf("%w: this app does not take that from Chat", bridge.ErrNotAllowed)
	}
	if err := f.nextPinFailure(); err != nil {
		return err
	}
	f.dialogCalls = append(f.dialogCalls, call)
	change()
	return nil
}

// SetMute implements bridge.DialogWriter.
func (f *Fake) SetMute(_ context.Context, _ bridge.Account, conv string, until int64) error {
	return f.writeDialog(feature.Notify, fmt.Sprintf("mute:%s:%d", conv, until), func() { st := f.dialogs[conv]; st.MuteUntil = until; f.dialogs[conv] = st })
}

// SetDialogPinned implements bridge.DialogWriter.
func (f *Fake) SetDialogPinned(_ context.Context, _ bridge.Account, conv string, pinned bool) error {
	return f.writeDialog(feature.Dialog, fmt.Sprintf("pin:%s:%v", conv, pinned), func() { st := f.dialogs[conv]; st.Pinned = pinned; f.dialogs[conv] = st })
}

// SetUnreadMark implements bridge.DialogWriter.
func (f *Fake) SetUnreadMark(_ context.Context, _ bridge.Account, conv string, unread bool) error {
	return f.writeDialog(feature.Dialog, fmt.Sprintf("unread:%s:%v", conv, unread), func() { st := f.dialogs[conv]; st.UnreadMark = unread; f.dialogs[conv] = st })
}

var (
	_ bridge.DialogReader = (*Fake)(nil)
	_ bridge.DialogWriter = (*Fake)(nil)
)

// SetGroupInfoRemotely sets the title and description of a group in the app, as if
// somebody there had changed them; GroupInfos answers it.
func (f *Fake) SetGroupInfoRemotely(conv string, info bridge.GroupInfo) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.infos[conv] = info
}

// GroupInfo is what the app has now for a group.
func (f *Fake) GroupInfo(conv string) bridge.GroupInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.infos[conv]
}

// InfoCalls lists the calls Chat made to change the info of a group, as "<conv>:<title>:<about>".
func (f *Fake) InfoCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.infoCalls...)
}

// GroupInfos implements bridge.InfoReader.
func (f *Fake) GroupInfos(_ context.Context, _ bridge.Account, convs []string) (map[string]bridge.GroupInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.refusedOne(convs); err != nil {
		return nil, err
	}
	out := map[string]bridge.GroupInfo{}
	for _, c := range convs {
		if info, ok := f.infos[c]; ok {
			out[c] = info
		}
	}
	return out, nil
}

// SetGroupInfo implements bridge.InfoWriter.
func (f *Fake) SetGroupInfo(_ context.Context, _ bridge.Account, conv string, info bridge.GroupInfo) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.support[feature.Info].Out {
		return fmt.Errorf("%w: this app does not take the info of a group from Chat", bridge.ErrNotAllowed)
	}
	if err := f.nextPinFailure(); err != nil {
		return err
	}
	f.infoCalls = append(f.infoCalls, conv+":"+info.Title+":"+info.About)
	f.infos[conv] = info
	return nil
}

var (
	_ bridge.InfoReader = (*Fake)(nil)
	_ bridge.InfoWriter = (*Fake)(nil)
)

// TopicEdits lists the calls Chat made to rename, close or reopen a topic, as
// "<conv>:<topic>:<title>:<closed>".
func (f *Fake) TopicEdits() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.topicEdits...)
}

// EditTopic implements bridge.TopicWriter.
func (f *Fake) EditTopic(_ context.Context, _ bridge.Account, conv, topic string, edit bridge.TopicEdit) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.support[feature.Topics].Out {
		return fmt.Errorf("%w: this app does not take topic changes from Chat", bridge.ErrNotAllowed)
	}
	if f.failTopicEdit != nil {
		return f.failTopicEdit
	}
	if err := f.nextPinFailure(); err != nil {
		return err
	}
	for i := range f.topics[conv] {
		t := &f.topics[conv][i]
		if t.ID != topic {
			continue
		}
		if edit.Title != nil {
			t.Title = *edit.Title
		}
		if edit.Closed != nil {
			t.Closed = *edit.Closed
		}
		f.topicEdits = append(f.topicEdits, fmt.Sprintf("%s:%s:%s:%v", conv, topic, t.Title, t.Closed))
	}
	return nil
}

var _ bridge.TopicWriter = (*Fake)(nil)

// SetMembers sets who is in a group of the app, as if people there had joined and left;
// partial says the group is too big to be listed in full.
func (f *Fake) SetMembers(conv string, partial bool, members ...bridge.Member) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.members[conv] = append([]bridge.Member(nil), members...)
	f.partial[conv] = partial
}

// Members is who the app has in a group now.
func (f *Fake) Members(conv string) []bridge.Member {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bridge.Member(nil), f.members[conv]...)
}

// MemberCalls lists the calls Chat made to act on people, as "remove:<conv>:<id>" and "admin:<conv>:<id>:<bool>".
func (f *Fake) MemberCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.memberCalls...)
}

// ListMembers implements bridge.MemberReader.
func (f *Fake) ListMembers(_ context.Context, _ bridge.Account, conv string) ([]bridge.Member, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bridge.Member(nil), f.members[conv]...), !f.partial[conv], nil
}

func (f *Fake) writeMember(call string, change func()) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.support[feature.Members].Out {
		return fmt.Errorf("%w: this app does not take that from Chat", bridge.ErrNotAllowed)
	}
	if err := f.nextPinFailure(); err != nil {
		return err
	}
	f.memberCalls = append(f.memberCalls, call)
	change()
	return nil
}

// RemoveMember implements bridge.MemberWriter.
func (f *Fake) RemoveMember(_ context.Context, _ bridge.Account, conv, participant string) error {
	return f.writeMember("remove:"+conv+":"+participant, func() {
		f.members[conv] = slices.DeleteFunc(f.members[conv], func(m bridge.Member) bool { return m.Participant.ID == participant })
	})
}

// SetMemberAdmin implements bridge.MemberWriter.
func (f *Fake) SetMemberAdmin(_ context.Context, _ bridge.Account, conv, participant string, admin bool) error {
	return f.writeMember(fmt.Sprintf("admin:%s:%s:%v", conv, participant, admin), func() {
		for i := range f.members[conv] {
			if f.members[conv][i].Participant.ID == participant {
				f.members[conv][i].Admin = admin
			}
		}
	})
}

var (
	_ bridge.MemberReader = (*Fake)(nil)
	_ bridge.MemberWriter = (*Fake)(nil)
)

// AddMember implements bridge.MemberAdder.
func (f *Fake) AddMember(_ context.Context, _ bridge.Account, conv, participant string) error {
	return f.writeMember("add:"+conv+":"+participant, func() {
		f.members[conv] = append(f.members[conv], bridge.Member{Participant: bridge.Participant{ID: participant, Name: "Người " + participant}})
	})
}

// SetMemberPerms implements bridge.PermWriter.
func (f *Fake) SetMemberPerms(_ context.Context, _ bridge.Account, conv, participant string, perms bridge.Perms) error {
	return f.writeMember(fmt.Sprintf("perms:%s:%s:%+v", conv, participant, perms), func() {
		for i := range f.members[conv] {
			if f.members[conv][i].Participant.ID == participant {
				p := perms
				f.members[conv][i].Perms = &p
				if perms == bridge.FullPerms {
					f.members[conv][i].Perms = nil
				}
			}
		}
	})
}

// SetInvites sets the invite links the account has for a group in the app.
func (f *Fake) SetInvites(conv string, links ...bridge.InviteLink) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.invites[conv] = append([]bridge.InviteLink(nil), links...)
}

// Invites is the links the app has for a group now.
func (f *Fake) Invites(conv string) []bridge.InviteLink {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bridge.InviteLink(nil), f.invites[conv]...)
}

// ListInvites implements bridge.InviteManager.
func (f *Fake) ListInvites(_ context.Context, _ bridge.Account, conv string) ([]bridge.InviteLink, error) {
	f.mu.Lock()
	refused := f.refuse[conv]
	f.mu.Unlock()
	if refused {
		return nil, refusedErr(conv)
	}
	return f.Invites(conv), nil
}

// Refuse makes the app refuse every read about a conversation (history, state, info,
// invite links), as Telegram does for a peer it no longer knows; a batch naming it is
// refused whole.
func (f *Fake) Refuse(conv string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refuse[conv] = true
}

func refusedErr(conv string) error {
	return fmt.Errorf("%w: PEER_ID_INVALID (%s)", bridge.ErrNotAllowed, conv)
}

// refusedOne is the refusal of a batch that names a refused conversation; f.mu is held.
func (f *Fake) refusedOne(convs []string) error {
	for _, c := range convs {
		if f.refuse[c] {
			return refusedErr(c)
		}
	}
	return nil
}

// CreateInvite implements bridge.InviteManager.
func (f *Fake) CreateInvite(_ context.Context, _ bridge.Account, conv, title string) (bridge.InviteLink, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.support[feature.Invites].Out {
		return bridge.InviteLink{}, fmt.Errorf("%w: this app does not make invite links from Chat", bridge.ErrNotAllowed)
	}
	if err := f.nextPinFailure(); err != nil {
		return bridge.InviteLink{}, err
	}
	l := bridge.InviteLink{Link: fmt.Sprintf("https://fake.test/+%s%d", conv, len(f.invites[conv])+1), Title: title}
	f.invites[conv] = append(f.invites[conv], l)
	return l, nil
}

// RevokeInvite implements bridge.InviteManager.
func (f *Fake) RevokeInvite(_ context.Context, _ bridge.Account, conv, link string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.nextPinFailure(); err != nil {
		return err
	}
	for i := range f.invites[conv] {
		if f.invites[conv][i].Link == link {
			f.invites[conv][i].Revoked = true
		}
	}
	return nil
}

// LifecycleCalls lists the leave and delete calls Chat made, as "leave:<conv>" and "delete:<conv>".
func (f *Fake) LifecycleCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.lifecycle...)
}

func (f *Fake) lifecycleCall(call string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.support[feature.Lifecycle].Out {
		return fmt.Errorf("%w: this app does not take that from Chat", bridge.ErrNotAllowed)
	}
	if err := f.nextPinFailure(); err != nil {
		return err
	}
	f.lifecycle = append(f.lifecycle, call)
	return nil
}

// LeaveGroup implements bridge.GroupLifecycle.
func (f *Fake) LeaveGroup(_ context.Context, _ bridge.Account, conv string) error {
	return f.lifecycleCall("leave:" + conv)
}

// DeleteGroup implements bridge.GroupLifecycle.
func (f *Fake) DeleteGroup(_ context.Context, _ bridge.Account, conv string) error {
	return f.lifecycleCall("delete:" + conv)
}

// MarkReads lists what Chat told the app it read, as "conversation:id".
func (f *Fake) MarkReads() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.reads...)
}

// MarkRead implements bridge.ReadWriter.
func (f *Fake) MarkRead(_ context.Context, _ bridge.Account, conv, upToID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.support[feature.Read].Out {
		return fmt.Errorf("%w: this app does not take that from Chat", bridge.ErrNotAllowed)
	}
	f.reads = append(f.reads, conv+":"+upToID)
	return nil
}

var (
	_ bridge.ReadWriter     = (*Fake)(nil)
	_ bridge.MemberAdder    = (*Fake)(nil)
	_ bridge.PermWriter     = (*Fake)(nil)
	_ bridge.InviteManager  = (*Fake)(nil)
	_ bridge.GroupLifecycle = (*Fake)(nil)
)

// CreatedTopics lists the topics Chat opened, as "<conv>:<title>".
func (f *Fake) CreatedTopics() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.topicCreates...)
}

// CreateTopic implements bridge.TopicCreator. A repeated randomID answers the topic
// already opened. Like the other app it tells of the new topic (EchoSent).
func (f *Fake) CreateTopic(_ context.Context, _ bridge.Account, conv, title string, iconColor int, randomID int64) (string, error) {
	f.mu.Lock()
	if !f.support[feature.Topics].Out {
		f.mu.Unlock()
		return "", fmt.Errorf("%w: this app does not take topic changes from Chat", bridge.ErrNotAllowed)
	}
	if id, ok := f.topicByRandom[randomID]; ok {
		f.mu.Unlock()
		return id, nil
	}
	if err := f.nextPinFailure(); err != nil {
		f.mu.Unlock()
		return "", err
	}
	f.nextID++
	t := bridge.Topic{ID: strconv.Itoa(f.nextID), Title: title, IconColor: iconColor}
	f.topics[conv] = append(f.topics[conv], t)
	f.topicByRandom[randomID] = t.ID
	f.topicCreates = append(f.topicCreates, conv+":"+title)
	echo := f.EchoSent
	f.mu.Unlock()
	if echo {
		f.Push(bridge.Event{Topic: &bridge.TopicChange{Conversation: conv, Topic: t}})
	}
	return t.ID, nil
}

var _ bridge.TopicCreator = (*Fake)(nil)
