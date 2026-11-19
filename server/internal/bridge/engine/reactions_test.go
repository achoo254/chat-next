package engine_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
)

// reactionsIn lists the reactions of a message of Chat as "<who>=<emoji>", who being
// "owner" or the external id of a puppet, sorted.
func (e *env) reactionsIn(chatID, seq int64) string {
	e.t.Helper()
	rows, err := e.st.Pool().Query(context.Background(), `
		SELECT CASE WHEN r.user_id = $3 THEN 'owner' ELSE coalesce(x.external_user_id, 'user') END, r.emoji
		FROM message_reactions r LEFT JOIN external_users x ON x.user_id = r.user_id
		WHERE r.chat_id = $1 AND r.seq = $2 ORDER BY 1`, chatID, seq, e.owner)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var who, emoji string
		if err := rows.Scan(&who, &emoji); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, who+"="+emoji)
	}
	return fmt.Sprint(out)
}

func (e *env) waitReactions(chatID, seq int64, want string) {
	e.t.Helper()
	e.eventually(func() bool { return e.reactionsIn(chatID, seq) == want },
		func() string { return fmt.Sprintf("reactions = %s, want %s", e.reactionsIn(chatID, seq), want) })
}

func (e *env) react(chatID, seq int64, emoji string) {
	e.t.Helper()
	if _, err := e.chat.SetReaction(context.Background(), e.owner, chatID, seq, emoji); err != nil {
		e.t.Fatal(err)
	}
}

func reactions(conv, id string, complete bool, list ...bridge.Reaction) *bridge.Reactions {
	return &bridge.Reactions{Conversation: conv, ID: id, List: list, Complete: complete, OwnerKnown: true}
}

var self = bridge.Participant{ID: "self", IsSelf: true}

func TestReactionsOfTheOtherAppReachChatAndFollowItsChanges(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	seq := e.seqOf(chatID, "m1")

	e.fake.ReactRemotely("g1", "m1", lan, "👍", true)
	e.fake.ReactRemotely("g1", "m1", self, "❤", true)
	e.waitReactions(chatID, seq, "[owner=❤ u-lan=👍]")
	// Lan changes theirs, the owner's goes on another device
	e.fake.ReactRemotely("g1", "m1", lan, "🔥", true)
	e.fake.ReactRemotely("g1", "m1", self, "", true)
	e.waitReactions(chatID, seq, "[u-lan=🔥]")
	// a message Chat has not imported is skipped without harm
	e.fake.Push(bridge.Event{Reactions: reactions("g1", "404", true, bridge.Reaction{From: lan, Emoji: "👍"})})
	e.fake.ReactRemotely("g1", "m1", lan, "", true)
	e.waitReactions(chatID, seq, "[]")
}

func TestReactionsMadeInTheOtherAppWithoutAnEventComeInOnALook(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	seq := e.seqOf(chatID, "m2")
	e.fake.ReactRemotely("g1", "m2", lan, "👍", false)
	e.fake.ReactRemotely("g1", "m2", self, "🎉", false)
	e.waitReactions(chatID, seq, "[owner=🎉 u-lan=👍]")
	e.fake.ReactRemotely("g1", "m2", lan, "", false)
	e.waitReactions(chatID, seq, "[owner=🎉]")
}

func TestAReactionSetInChatGoesOutAndIsNotReadBackAway(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	seq := e.seqOf(chatID, "m1")
	e.fake.ReactRemotely("g1", "m1", lan, "👍", false)
	e.waitReactions(chatID, seq, "[u-lan=👍]")

	e.react(chatID, seq, "❤️")
	e.eventually(func() bool { return fmt.Sprint(e.fake.ReactionCalls()) == "[g1/m1:❤️]" }, func() string { return fmt.Sprint(e.fake.ReactionCalls()) })
	// several looks later Chat still has the owner's, and Lan's
	time.Sleep(300 * time.Millisecond)
	if got := e.reactionsIn(chatID, seq); got != "[owner=❤️ u-lan=👍]" {
		t.Fatalf("after the looks Chat has %s", got)
	}
	e.react(chatID, seq, "")
	e.eventually(func() bool { return len(e.fake.ReactionCalls()) == 2 }, func() string { return fmt.Sprint(e.fake.ReactionCalls()) })
	if got := e.fake.ReactionsOf("g1", "m1"); fmt.Sprint(got) != "map[u-lan:👍]" {
		t.Fatalf("the other app has %v after the owner removed theirs", got)
	}
	e.waitReactions(chatID, seq, "[u-lan=👍]")
}

func TestWhileTheOwnersReactionWaitsToGoOutAnOlderOneDoesNotOverwriteIt(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	seq := e.seqOf(chatID, "m1")
	e.stop()
	e.react(chatID, seq, "👍")
	// the other app still says the owner has none, and Lan reacted meanwhile
	e.fake.ReactRemotely("g1", "m1", lan, "😂", true)
	e.start()
	e.eventually(func() bool { return len(e.fake.ReactionCalls()) == 1 }, func() string { return fmt.Sprint(e.fake.ReactionCalls()) })
	e.waitReactions(chatID, seq, "[owner=👍 u-lan=😂]")
}

func TestAReactionTheOtherAppRefusesIsPutBack(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	seq := e.seqOf(chatID, "m1")
	e.fake.ReactRemotely("g1", "m1", self, "👍", false)
	e.waitReactions(chatID, seq, "[owner=👍]")
	e.fake.FailPin(fmt.Errorf("%w: REACTION_INVALID", bridge.ErrNotAllowed))
	e.react(chatID, seq, "🦄")
	e.waitOutbox(chatID, seq, "set_reaction", "failed")
	e.waitReactions(chatID, seq, "[owner=👍]")
}

func TestReactionsSwitchedOffNeitherComeInNorGoOut(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	eng := e.start()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Reactions, feature.Off); err != nil {
		t.Fatal(err)
	}
	seq := e.seqOf(chatID, "m1")
	e.fake.ReactRemotely("g1", "m1", lan, "👍", true)
	e.react(chatID, seq, "❤")
	time.Sleep(300 * time.Millisecond)
	if got := e.reactionsIn(chatID, seq); got != "[owner=❤]" {
		t.Fatalf("with reactions off Chat has %s", got)
	}
	if calls := e.fake.ReactionCalls(); len(calls) != 0 {
		t.Fatalf("with reactions off Chat sent %v", calls)
	}
}

func TestAChatThatOnlyReadsTakesReactionsButNeverSendsTheOwners(t *testing.T) {
	e := newEnv(t)
	conv := e.group("g1")
	e.fake.AddHistory("g1", e.msg("m1", lan, "tin 1", 1))
	chatID := e.enable(conv, 100)
	e.waitTexts(chatID, []string{"tin 1"})
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	seq := e.seqOf(chatID, "m1")
	e.fake.ReactRemotely("g1", "m1", lan, "👍", true)
	e.waitReactions(chatID, seq, "[u-lan=👍]")
	e.react(chatID, seq, "❤")
	time.Sleep(200 * time.Millisecond)
	if calls := e.fake.ReactionCalls(); len(calls) != 0 {
		t.Fatalf("a chat that only reads sent %v", calls)
	}
}
