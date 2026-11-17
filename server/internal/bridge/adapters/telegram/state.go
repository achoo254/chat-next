package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/gotd/td/telegram/updates"
)

// errNoState is what the update manager expects of a storage that has no
// state yet for a Set call.
var errNoState = errors.New("telegram: no update state")

// stateData is the update state of an account, the blob the engine stores:
// the common box (pts, qts, date, seq), the pts of every channel being
// followed and the access hashes Telegram needs to address those channels.
type stateData struct {
	Common   updates.State   `json:"common"`
	Found    bool            `json:"found"`
	Channels map[int64]int   `json:"channels,omitempty"`
	Hashes   map[int64]int64 `json:"hashes,omitempty"`
}

// memState is the update manager's storage for one account. It lives in
// memory; Snapshot gives the blob to persist, loadState reads it back.
type memState struct {
	mu sync.Mutex
	d  stateData
}

var (
	_ updates.StateStorage        = (*memState)(nil)
	_ updates.ChannelAccessHasher = (*memState)(nil)
)

// loadState reads a blob; an empty or unreadable blob is an empty state
// (the account then starts from the present).
func loadState(blob []byte) *memState {
	s := &memState{}
	if len(blob) > 0 {
		_ = json.Unmarshal(blob, &s.d)
	}
	if s.d.Channels == nil {
		s.d.Channels = map[int64]int{}
	}
	if s.d.Hashes == nil {
		s.d.Hashes = map[int64]int64{}
	}
	return s
}

// Snapshot is the current state as a blob.
func (s *memState) Snapshot() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	blob, _ := json.Marshal(s.d)
	return blob
}

func (s *memState) GetState(context.Context, int64) (updates.State, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.d.Common, s.d.Found, nil
}

func (s *memState) SetState(_ context.Context, _ int64, st updates.State) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Common, s.d.Found = st, true
	return nil
}

func (s *memState) set(f func()) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.d.Found {
		return errNoState
	}
	f()
	return nil
}

func (s *memState) SetPts(_ context.Context, _ int64, pts int) error {
	return s.set(func() { s.d.Common.Pts = pts })
}

func (s *memState) SetQts(_ context.Context, _ int64, qts int) error {
	return s.set(func() { s.d.Common.Qts = qts })
}

func (s *memState) SetDate(_ context.Context, _ int64, date int) error {
	return s.set(func() { s.d.Common.Date = date })
}

func (s *memState) SetSeq(_ context.Context, _ int64, seq int) error {
	return s.set(func() { s.d.Common.Seq = seq })
}

func (s *memState) SetDateSeq(_ context.Context, _ int64, date, seq int) error {
	return s.set(func() { s.d.Common.Date, s.d.Common.Seq = date, seq })
}

func (s *memState) GetChannelPts(_ context.Context, _, channelID int64) (int, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pts, ok := s.d.Channels[channelID]
	return pts, ok, nil
}

func (s *memState) SetChannelPts(_ context.Context, _, channelID int64, pts int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Channels[channelID] = pts
	return nil
}

func (s *memState) ForEachChannels(ctx context.Context, _ int64, f func(ctx context.Context, channelID int64, pts int) error) error {
	s.mu.Lock()
	snapshot := make(map[int64]int, len(s.d.Channels))
	for k, v := range s.d.Channels {
		snapshot[k] = v
	}
	s.mu.Unlock()
	for id, pts := range snapshot {
		if err := f(ctx, id, pts); err != nil {
			return err
		}
	}
	return nil
}

func (s *memState) SetChannelAccessHash(_ context.Context, _, channelID, accessHash int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Hashes[channelID] = accessHash
	return nil
}

func (s *memState) GetChannelAccessHash(_ context.Context, _, channelID int64) (int64, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h, ok := s.d.Hashes[channelID]
	return h, ok, nil
}
