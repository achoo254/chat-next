package telegram

import (
	"testing"
	"time"

	"github.com/gotd/td/tg"
)

func TestDialogStateReadsMuteAndTheMarksOfADialog(t *testing.T) {
	var d tg.Dialog
	if st := dialogState(&d, notifyGroups, nil); st.MuteUntil != 0 || st.Pinned || st.UnreadMark {
		t.Fatalf("a plain dialog = %+v", st)
	}
	d.Pinned, d.UnreadMark = true, true
	d.NotifySettings.SetMuteUntil(muteForever)
	if st := dialogState(&d, notifyGroups, nil); st.MuteUntil != muteForever || !st.Pinned || !st.UnreadMark {
		t.Fatalf("a muted, pinned, unread dialog = %+v", st)
	}
}

func TestADialogWithoutItsOwnMuteFollowsTheDefaultOfItsKind(t *testing.T) {
	defaults := map[notifyKind]int64{notifyGroups: muteForever}
	var d tg.Dialog
	if st := dialogState(&d, notifyGroups, defaults); st.MuteUntil != muteForever {
		t.Fatalf("a group under muted groups = %d, want muted", st.MuteUntil)
	}
	if st := dialogState(&d, notifyUsers, defaults); st.MuteUntil != 0 {
		t.Fatalf("a private chat = %d, want not muted", st.MuteUntil)
	}
	d.NotifySettings.SetMuteUntil(0) // unmuted on its own, against the default
	if st := dialogState(&d, notifyGroups, defaults); st.MuteUntil != 0 {
		t.Fatalf("a group unmuted on its own = %d, want not muted", st.MuteUntil)
	}
	chats := []tg.ChatClass{&tg.Channel{ID: 5, Broadcast: true}, &tg.Channel{ID: 6, Megagroup: true}}
	if kindOf(&tg.PeerChannel{ChannelID: 5}, chats) != notifyChannels || kindOf(&tg.PeerChannel{ChannelID: 6}, chats) != notifyGroups ||
		kindOf(&tg.PeerChat{ChatID: 1}, chats) != notifyGroups || kindOf(&tg.PeerUser{UserID: 1}, chats) != notifyUsers {
		t.Fatal("a peer follows the default of the wrong kind")
	}
}

func mutedUntil(s tg.InputPeerNotifySettings) (int, bool) { return s.GetMuteUntil() }

func TestInputMuteSetsTheTimeOrClearsIt(t *testing.T) {
	until := time.Now().Add(time.Hour).Unix()
	if got, ok := mutedUntil(inputMute(until)); !ok || int64(got) != until {
		t.Fatalf("a mute until %d = %d (set=%v)", until, got, ok)
	}
	if got, ok := mutedUntil(inputMute(muteForever + 5)); !ok || got != muteForever {
		t.Fatalf("a mute past the end = %d (set=%v), want it capped at forever", got, ok)
	}
	// a mute that already ended, or none, is sent as not muted
	for _, until := range []int64{0, time.Now().Add(-time.Hour).Unix()} {
		if got, ok := mutedUntil(inputMute(until)); !ok || got != 0 {
			t.Fatalf("a mute of %d sent as %d (set=%v), want an explicit 0", until, got, ok)
		}
	}
}
