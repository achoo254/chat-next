package engine_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"strings"
	"sync"
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

func withPhone(p bridge.Participant, phone string) bridge.Participant {
	p.PhoneKnown, p.Phone = true, phone
	return p
}

// phoneHash is the recorded hash of a person's number and the row's version
// (xmin, which moves on every write).
func (e *env) phoneHash(person string) (hash []byte, version string) {
	e.t.Helper()
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT phone_hmac, xmin::text FROM external_users WHERE account_id = $1 AND external_user_id = $2`, e.account, person).Scan(&hash, &version); err != nil {
		e.t.Fatal(err)
	}
	return hash, version
}

// pushDM delivers a live message of person in the private chat dm1.
func (e *env) pushDM(id string, from bridge.Participant, text string, minutes int) {
	m := e.msg(id, from, text, minutes)
	m.Conversation = "dm1"
	e.fake.Push(bridge.Event{Message: &m})
}

func TestAPhoneNumberIsKeptAsAKeyedHashAndOnlyAStatedChangeMovesIt(t *testing.T) {
	e := newEnv(t)
	e.phoneKey = testPhoneKey
	lanPhone := withPhone(lan, testNumber)
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &lanPhone}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", lanPhone, "chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào"})
	hash, version := e.phoneHash(lan.ID)
	if !bytes.Equal(hash, expectedPhoneHash()) {
		t.Fatal("the recorded hash is not the keyed hash of the E.164 number")
	}
	// The number itself is nowhere in the puppet's rows.
	var rows string
	if err := e.st.Pool().QueryRow(context.Background(), `
		SELECT row_to_json(x)::text || row_to_json(u)::text FROM external_users x JOIN users u ON u.id = x.user_id
		WHERE x.account_id = $1 AND x.external_user_id = $2`, e.account, lan.ID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rows, "900000001") || strings.Contains(rows, "900 000 001") {
		t.Fatal("the raw number is stored")
	}

	// The same number again does not rewrite the row; an update that does not state it keeps it.
	e.pushDM("2", lanPhone, "lại", 1)
	e.pushDM("3", lan, "ngắn", 2)
	e.waitTexts(chatID, []string{"chào", "lại", "ngắn"})
	if got, v := e.phoneHash(lan.ID); !bytes.Equal(got, hash) || v != version {
		t.Fatalf("hash kept = %v, row rewritten = %v", bytes.Equal(got, hash), v != version)
	}
	// An unreadable number is unknown: kept as well.
	e.pushDM("4", withPhone(lan, "not a number"), "lạ", 3)
	e.waitTexts(chatID, []string{"chào", "lại", "ngắn", "lạ"})
	if got, _ := e.phoneHash(lan.ID); !bytes.Equal(got, hash) {
		t.Fatal("an unreadable number erased the recorded one")
	}
	// The app stating «no number» clears it.
	e.pushDM("5", withPhone(lan, ""), "ẩn số", 4)
	e.waitTexts(chatID, []string{"chào", "lại", "ngắn", "lạ", "ẩn số"})
	if got, _ := e.phoneHash(lan.ID); got != nil {
		t.Fatal("a stated «no number» did not clear the hash")
	}
}

func TestWithoutAKeyNoPhoneIsRecorded(t *testing.T) {
	e := newEnv(t)
	lanPhone := withPhone(lan, testNumber)
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &lanPhone}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", lanPhone, "chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào"})
	if got, _ := e.phoneHash(lan.ID); got != nil {
		t.Fatal("a hash was recorded without BRIDGE_PHONE_KEY")
	}
}

// phoneBookFake is the fake app with a contact list.
type phoneBookFake struct {
	*contracttest.Fake
	mu       sync.Mutex
	contacts []bridge.Participant
	calls    int
}

func (f *phoneBookFake) PhoneContacts(context.Context, bridge.Account) ([]bridge.Participant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.contacts, nil
}

func (f *phoneBookFake) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func TestThePhoneBookFillsNumbersOfKnownPeopleOnce(t *testing.T) {
	e := newEnv(t)
	e.phoneKey = testPhoneKey
	book := &phoneBookFake{Fake: e.fake, contacts: []bridge.Participant{
		withPhone(lan, testNumber), withPhone(bridge.Participant{ID: "u-stranger", Name: "Lạ"}, "0900000002"),
	}}
	e.adapter = book
	conv := bridge.Conversation{ID: "dm1", Kind: bridge.ConvPrivate, Peer: &lan}
	e.fake.AddConversation(conv)
	e.fake.AddHistory("dm1", e.msg("1", lan, "chào", 0))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"chào"})
	var readAt *time.Time
	e.eventually(func() bool {
		_ = e.st.Pool().QueryRow(context.Background(), `SELECT phone_book_read_at FROM external_accounts WHERE id = $1`, e.account).Scan(&readAt)
		return readAt != nil
	}, func() string { return "the phone book was not read" })
	if got, _ := e.phoneHash(lan.ID); !bytes.Equal(got, expectedPhoneHash()) {
		t.Fatal("the contact's number was not recorded on their puppet")
	}
	var strangers int
	if err := e.st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM external_users WHERE account_id = $1 AND external_user_id = 'u-stranger'`,
		e.account).Scan(&strangers); err != nil || strangers != 0 {
		t.Fatalf("a contact never talked with got a puppet: %d (err %v)", strangers, err)
	}
	// Another connection does not read it again.
	e.start()
	time.Sleep(300 * time.Millisecond) // many looks at 30 ms
	if n := book.callCount(); n != 1 {
		t.Fatalf("the phone book was read %d times, want once", n)
	}
}
