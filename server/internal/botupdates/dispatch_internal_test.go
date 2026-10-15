package botupdates

import (
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestRetryDelay(t *testing.T) {
	for attempts, want := range map[int]time.Duration{1: time.Second, 2: 2 * time.Second, 3: 4 * time.Second, 6: 32 * time.Second} {
		if got := retryDelay(attempts, 0, false, retryFirst); got != want {
			t.Errorf("retryDelay(%d) = %v, want %v", attempts, got, want)
		}
	}
	for _, attempts := range []int{7, 9, 10, 40} {
		if got := retryDelay(attempts, 0, false, retryFirst); got < 60*time.Second || got >= 120*time.Second {
			t.Errorf("retryDelay(%d) = %v, want 60 to 120 s", attempts, got)
		}
	}
	if got := retryDelay(1, 2*time.Hour, true, retryFirst); got != time.Hour {
		t.Errorf("Retry-After above an hour = %v", got)
	}
	if got := retryDelay(5, 7*time.Second, true, retryFirst); got != 7*time.Second {
		t.Errorf("Retry-After 7 s = %v", got)
	}
	// Retry-After 0 or a date in the past still waits the minimum backoff.
	if got := retryDelay(5, -time.Second, true, retryFirst); got != retryFirst {
		t.Errorf("Retry-After in the past = %v", got)
	}
	if got := retryDelay(5, 0, true, retryFirst); got != retryFirst {
		t.Errorf("Retry-After 0 = %v", got)
	}
}

func TestParseRetryAfter(t *testing.T) {
	if d, ok := parseRetryAfter("7"); !ok || d != 7*time.Second {
		t.Fatalf("seconds = %v %v", d, ok)
	}
	if d, ok := parseRetryAfter("999999"); !ok || d != time.Hour {
		t.Fatalf("large = %v %v", d, ok)
	}
	if _, ok := parseRetryAfter(""); ok {
		t.Fatal("empty parsed")
	}
	if _, ok := parseRetryAfter("soon"); ok {
		t.Fatal("garbage parsed")
	}
	at := time.Now().Add(30 * time.Second).UTC().Format(http.TimeFormat)
	if d, ok := parseRetryAfter(at); !ok || d < 25*time.Second || d > 31*time.Second {
		t.Fatalf("date = %v %v", d, ok)
	}
}

func TestSignAndReplyRandomID(t *testing.T) {
	// Fixed vector (openssl dgst -sha256 -hmac my_secret of
	// `1760500000.{"update_id":1}`), also in docs/bot-api.
	got := Sign([]byte("my_secret"), "1760500000", []byte(`{"update_id":1}`))
	if want := "v1=12ce7a96902e36f654800624244c841b5b6ce24b50f42f876fa551d508a6e8e1"; got != want {
		t.Fatalf("Sign = %q, want %q", got, want)
	}
	if Sign([]byte("other"), "1760500000", []byte(`{"update_id":1}`)) == got {
		t.Fatal("the secret does not change the signature")
	}
	a, b := ReplyRandomID(7, 1), ReplyRandomID(7, 2)
	if a == b || a != ReplyRandomID(7, 1) || a <= 0 || a >= 1<<53 || ReplyRandomID(8, 1) == a {
		t.Fatalf("ReplyRandomID: %d %d", a, b)
	}
}

func TestSlotsBoundTheProcessAndShareFairly(t *testing.T) {
	s := newSlots(10)
	var wokenA, wokenB atomic.Int32
	wakeA := func() { wokenA.Add(1) }
	wakeB := func() { wokenB.Add(1) }
	// Alone, a bot may take every slot, never more.
	if got := s.acquire(1, 25, wakeA); got != 10 || s.used != 10 {
		t.Fatalf("first bot got %d (used %d)", got, s.used)
	}
	// Another bot gets nothing while all are taken, and waits.
	if got := s.acquire(2, 4, wakeB); got != 0 {
		t.Fatalf("second bot got %d of a full pool", got)
	}
	// A freed slot wakes the waiting bot holding the fewest; the first bot
	// is over its share now (10 / 2 bots), so the second bot gets the slot.
	s.acquire(1, 1, wakeA)
	s.release(1)
	if wokenA.Load() != 0 || wokenB.Load() != 1 {
		t.Fatalf("woken: a %d, b %d", wokenA.Load(), wokenB.Load())
	}
	if got := s.acquire(1, 1, wakeA); got != 0 {
		t.Fatalf("the bot over its share got %d more", got)
	}
	if got := s.acquire(2, 4, wakeB); got != 1 {
		t.Fatalf("the waiting bot got %d", got)
	}
	// As the first bot's requests end, the second reaches its share of 5.
	for range 4 {
		s.release(1)
	}
	if got := s.acquire(2, 10, wakeB); got != 4 || s.held[2] != 5 {
		t.Fatalf("second bot got %d, holds %d", got, s.held[2])
	}
	if got := s.acquire(1, 10, wakeA); got != 0 || s.held[1] != 5 {
		t.Fatalf("first bot got %d, holds %d", got, s.held[1])
	}
	// A bot that wants no more hands its turn on: with a slot free, the
	// other waiting bot is woken.
	s.release(2)
	before := wokenA.Load()
	s.forget(2)
	if wokenA.Load() != before+1 {
		t.Fatalf("forget did not pass the free slot on")
	}
	s.acquire(2, 1, wakeB)
	// Ended workers stop counting as contenders; released slots are free.
	s.forget(1)
	s.forget(2)
	for range 5 {
		s.release(1)
		s.release(2)
	}
	if s.used != 0 || len(s.held) != 0 || len(s.waiting) != 0 {
		t.Fatalf("after release: used %d, held %v, waiting %d", s.used, s.held, len(s.waiting))
	}
	// One slot each at least, even with more bots than slots.
	small := newSlots(2)
	for bot := int64(1); bot <= 3; bot++ {
		small.acquire(bot, 1, func() {})
	}
	if small.used != 2 {
		t.Fatalf("used %d of 2", small.used)
	}
}
