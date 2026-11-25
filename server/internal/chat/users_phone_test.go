package chat

import (
	"bytes"
	"context"
	"testing"

	appv1 "app.local/server/gen/app/v1"
)

var testPhoneKey = bytes.Repeat([]byte{5}, 32)

// ownPhone records the number a user was verified with, as the bridge engine does.
func (h *harness) ownPhone(user int64, number string) {
	h.t.Helper()
	hash, ok := h.svc.phoneHash(number)
	if !ok {
		h.t.Fatalf("%q is not a phone number", number)
	}
	if _, err := h.st.Pool().Exec(context.Background(), `UPDATE users SET phone_hmac = $2 WHERE id = $1`, user, hash); err != nil {
		h.t.Fatal(err)
	}
}

func TestAUserIsFoundAndAddedByTheirPhoneNumberInAnyForm(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.PhoneKey = testPhoneKey })
	ctx := context.Background()
	me, lan := h.user("me"), h.user("lan")
	h.ownPhone(lan, "+84912345678")
	for _, q := range []string{"0912345678", "+84 912 345 678", "84912345678", "091-234-5678"} {
		found, err := h.svc.SearchUsers(ctx, me, q, 10)
		if err != nil || len(found) != 1 || found[0].GetId() != lan {
			t.Fatalf("SearchUsers(%q) = %v, %v", q, found, err)
		}
	}
	if found, err := h.svc.SearchUsers(ctx, me, "0912345679", 10); err != nil || len(found) != 0 {
		t.Fatalf("another number found %v, %v", found, err)
	}
	added, err := h.svc.AddContact(ctx, me, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_Phone{Phone: "0912 345 678"}})
	if err != nil || added.GetId() != lan {
		t.Fatalf("AddContact by phone = %v, %v", added, err)
	}
}

func TestThePhoneAudienceDecidesWhoFindsAUserAndTheNumberIsNeverShown(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.PhoneKey = testPhoneKey })
	ctx := context.Background()
	me, lan := h.user("me"), h.user("lan")
	h.ownPhone(lan, "0912345678")
	nobody := appv1.PrivacyAudience_PRIVACY_AUDIENCE_NOBODY
	if _, err := h.svc.SetPrivacy(ctx, lan, &appv1.SetPrivacyRequest{FindByPhone: &nobody}); err != nil {
		t.Fatal(err)
	}
	if found, err := h.svc.SearchUsers(ctx, me, "0912345678", 10); err != nil || len(found) != 0 {
		t.Fatalf("found despite nobody: %v, %v", found, err)
	}
	if _, err := h.svc.AddContact(ctx, me, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_Phone{Phone: "0912345678"}}); err == nil {
		t.Fatal("AddContact by phone worked despite nobody")
	}
	got, err := h.svc.GetPrivacy(ctx, lan)
	if err != nil || got.GetFindByPhone() != nobody {
		t.Fatalf("privacy = %v, %v", got, err)
	}
}

func TestWithoutAKeyNobodyIsFoundByPhoneAndANumberIsRefused(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	me := h.user("me")
	if _, err := h.svc.AddContact(ctx, me, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_Phone{Phone: "0912345678"}}); err == nil {
		t.Fatal("a phone number was accepted with no key")
	}
}
