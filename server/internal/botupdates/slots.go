package botupdates

import (
	"cmp"
	"slices"
	"sync"
)

// slots bounds the webhook requests in flight across every bot of the
// process and shares them fairly: a bot gets a slot only while it holds
// less than an equal share of max among the bots that hold or want slots,
// so one bot with many slow endpoints (each request may buffer a reply)
// cannot take every connection and the memory behind it. A bot refused a
// slot stays a contender until it got all it asked for or says it wants
// none (forget); when slots free, as many waiting bots as there are free
// slots are woken to ask again, those holding the fewest first.
type slots struct {
	mu      sync.Mutex
	max     int
	used    int
	held    map[int64]int
	waiting map[int64]func()
}

func newSlots(max int) *slots {
	return &slots{max: max, held: map[int64]int{}, waiting: map[int64]func(){}}
}

// acquire takes up to n slots for bot and returns how many it got. When
// it got fewer, wake may run once a slot frees.
func (s *slots) acquire(bot int64, n int, wake func()) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	contenders := len(s.held)
	if s.held[bot] == 0 {
		contenders++
	}
	for id := range s.waiting {
		if id != bot && s.held[id] == 0 {
			contenders++
		}
	}
	share := max(1, s.max/contenders)
	got := max(0, min(n, s.max-s.used, share-s.held[bot]))
	if got > 0 {
		s.used += got
		s.held[bot] += got
	}
	if got < n {
		s.waiting[bot] = wake
	} else {
		delete(s.waiting, bot)
	}
	return got
}

// release frees one slot of bot and wakes a waiting bot for it.
func (s *slots) release(bot int64) {
	s.mu.Lock()
	s.used--
	if s.held[bot]--; s.held[bot] <= 0 {
		delete(s.held, bot)
	}
	wakes := s.wakeableLocked()
	s.mu.Unlock()
	for _, wake := range wakes {
		wake()
	}
}

// forget drops the bot's wish for more slots (nothing of it is due, or its
// worker ended); a free slot it was woken for goes to another waiting bot.
func (s *slots) forget(bot int64) {
	s.mu.Lock()
	if _, ok := s.waiting[bot]; !ok {
		s.mu.Unlock()
		return
	}
	delete(s.waiting, bot)
	wakes := s.wakeableLocked()
	s.mu.Unlock()
	for _, wake := range wakes {
		wake()
	}
}

// wakeableLocked picks one waiting bot per free slot, those holding the
// fewest slots first; s.mu is held.
func (s *slots) wakeableLocked() []func() {
	free := s.max - s.used
	if free <= 0 || len(s.waiting) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(s.waiting))
	for id := range s.waiting {
		ids = append(ids, id)
	}
	slices.SortFunc(ids, func(a, b int64) int { return cmp.Compare(s.held[a], s.held[b]) })
	wakes := make([]func(), 0, min(free, len(ids)))
	for _, id := range ids[:min(free, len(ids))] {
		wakes = append(wakes, s.waiting[id])
	}
	return wakes
}
