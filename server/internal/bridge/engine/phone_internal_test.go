package engine

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"testing"

	"app.local/server/internal/bridge"
)

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
