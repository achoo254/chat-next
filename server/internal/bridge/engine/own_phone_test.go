package engine_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/contracttest"
)

var testPhoneKey = bytes.Repeat([]byte{9}, 32)

// testNumber is a made-up number in national form, and its E.164 form.
const (
	testNumber = "0900 000 001"
	testE164   = "+84900000001"
)

func expectedPhoneHash() []byte {
	mac := hmac.New(sha256.New, testPhoneKey)
	mac.Write([]byte(testE164))
	return mac.Sum(nil)
}

// pushDM delivers a live message of person in the private chat dm1.
func (e *env) pushDM(id string, from bridge.Participant, text string, minutes int) {
	m := e.msg(id, from, text, minutes)
	m.Conversation = "dm1"
	e.fake.Push(bridge.Event{Message: &m})
}

// ownPhoneFake is the fake app that knows the number its account was verified with.
type ownPhoneFake struct {
	*contracttest.Fake
	number string
}

func (f *ownPhoneFake) OwnPhone(context.Context, bridge.Account) (string, error) {
	return f.number, nil
}

// ownerPhoneHash is the hash recorded on the account owner's user row.
func (e *env) ownerPhoneHash() []byte {
	e.t.Helper()
	var got []byte
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT u.phone_hmac FROM users u JOIN external_accounts a ON a.owner_id = u.id WHERE a.id = $1`, e.account).Scan(&got); err != nil {
		e.t.Fatal(err)
	}
	return got
}

func TestTheAccountsOwnNumberIsRecordedForItsOwner(t *testing.T) {
	e := newEnv(t)
	e.phoneKey = testPhoneKey
	e.adapter = &ownPhoneFake{Fake: e.fake, number: testNumber}
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &lan}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", lan, "chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào"})
	var got []byte
	e.eventually(func() bool {
		got = e.ownerPhoneHash()
		return got != nil
	}, func() string { return "the owner's number was not recorded" })
	if !bytes.Equal(got, expectedPhoneHash()) {
		t.Fatal("the recorded hash is not the keyed hash of the E.164 number")
	}
}

func TestWithoutAKeyTheOwnersNumberIsNotRecorded(t *testing.T) {
	e := newEnv(t)
	e.adapter = &ownPhoneFake{Fake: e.fake, number: testNumber}
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &lan}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", lan, "chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào"})
	time.Sleep(300 * time.Millisecond) // many looks at 30 ms
	if got := e.ownerPhoneHash(); got != nil {
		t.Fatal("a hash was recorded without BRIDGE_PHONE_KEY")
	}
}
