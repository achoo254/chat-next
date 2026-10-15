package botupdates

import (
	"net/http"
	"testing"
	"time"
)

func TestRetryDelay(t *testing.T) {
	for attempts, want := range map[int]time.Duration{1: time.Second, 2: 2 * time.Second, 3: 4 * time.Second, 6: 32 * time.Second} {
		if got := retryDelay(attempts, 0, false); got != want {
			t.Errorf("retryDelay(%d) = %v, want %v", attempts, got, want)
		}
	}
	for _, attempts := range []int{7, 9, 10, 40} {
		if got := retryDelay(attempts, 0, false); got < 60*time.Second || got >= 120*time.Second {
			t.Errorf("retryDelay(%d) = %v, want 60 to 120 s", attempts, got)
		}
	}
	if got := retryDelay(1, 2*time.Hour, true); got != time.Hour {
		t.Errorf("Retry-After above an hour = %v", got)
	}
	if got := retryDelay(5, -time.Second, true); got != 0 {
		t.Errorf("Retry-After in the past = %v", got)
	}
	if got := retryDelay(5, 0, true); got != 0 {
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
