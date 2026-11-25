package engine

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"testing"

	"app.local/server/internal/bridge"
)

func TestNormalizePhoneWritesEveryFormOfOneNumberTheSameWay(t *testing.T) {
	const want = "+84912345678"
	for _, raw := range []string{"+84912345678", "84912345678", "0912345678", "0912 345 678", "091-234-5678", "(091) 234.5678", "0084912345678", " +84 912 345 678 "} {
		got, ok := normalizePhone(raw)
		if !ok || got != want {
			t.Errorf("normalizePhone(%q) = %q, %v; want %q", raw, got, ok, want)
		}
	}
	// Other countries keep their code; Telegram gives numbers without "+".
	for raw, want := range map[string]string{"14155552671": "+14155552671", "+44 20 7946 0958": "+442079460958", "84241234567": "+84241234567"} {
		if got, ok := normalizePhone(raw); !ok || got != want {
			t.Errorf("normalizePhone(%q) = %q, %v; want %q", raw, got, ok, want)
		}
	}
}

func TestNormalizePhoneRefusesWhatIsNotPlainlyANumber(t *testing.T) {
	for _, raw := range []string{"", "   ", "+", "0", "12345", "091234567x", "0912345678 ext 1", "+84 912*345", "84+912345678",
		"+840912345678", "8412345678901", "841234567", "1234567890123456", "+0912345678", "091234567890"} {
		if got, ok := normalizePhone(raw); ok {
			t.Errorf("normalizePhone(%q) = %q, want refused", raw, got)
		}
	}
}

func TestPhoneUpdateWritesOnlyWhatTheAppStated(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	h := newPhoneHasher(key)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("+84912345678"))
	want := mac.Sum(nil)

	if u := h.update(bridge.Participant{Phone: "0912345678"}); u.write {
		t.Error("a number the app did not state as known was written")
	}
	u := h.update(bridge.Participant{PhoneKnown: true, Phone: "0912 345 678"})
	if !u.write || !bytes.Equal(u.value, want) {
		t.Errorf("a stated number: write = %v, hash matches = %v", u.write, bytes.Equal(u.value, want))
	}
	if bytes.Contains(u.value, []byte("912345678")) {
		t.Error("the hash carries the number")
	}
	if u := h.update(bridge.Participant{PhoneKnown: true}); !u.write || u.value != nil {
		t.Errorf("a stated «none»: write = %v, value set = %v; want cleared", u.write, u.value != nil)
	}
	if u := h.update(bridge.Participant{PhoneKnown: true, Phone: "not a number"}); u.write {
		t.Error("an unreadable number was written")
	}
	var off *phoneHasher
	if newPhoneHasher(nil) != nil {
		t.Error("no key still made a hasher")
	}
	if u := off.update(bridge.Participant{PhoneKnown: true, Phone: "0912345678"}); u.write || u.value != nil {
		t.Error("without a key a number was written")
	}
}
