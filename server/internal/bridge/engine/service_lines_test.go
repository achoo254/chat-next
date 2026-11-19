package engine_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"google.golang.org/protobuf/proto"
)

// systemLines lists the system lines of a chat as "<kind>[:detail]", oldest first.
func (e *env) systemLines(chatID int64) []string {
	e.t.Helper()
	rows, err := e.st.Pool().Query(context.Background(), `SELECT content FROM messages WHERE chat_id = $1 AND deleted_at IS NULL AND text = '' ORDER BY seq`, chatID)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			e.t.Fatal(err)
		}
		var m appv1.Message
		if err := proto.Unmarshal(raw, &m); err != nil {
			e.t.Fatal(err)
		}
		a := m.GetAction()
		switch {
		case a.GetMembersAdded() != nil:
			out = append(out, fmt.Sprintf("added:%d", len(a.GetMembersAdded().GetUserIds())))
		case a.GetMemberLeft() != nil:
			out = append(out, "left")
		case a.GetMemberRemoved() != nil:
			out = append(out, "removed")
		case a.GetTitleChanged() != nil:
			out = append(out, "title:"+a.GetTitleChanged().GetTitle())
		case a.GetMessagePinned() != nil:
			out = append(out, "pinned")
		case a.GetChatCreated() != nil:
			out = append(out, "created")
		default:
			out = append(out, "other")
		}
	}
	return out
}

func service(id string, from bridge.Participant, minutes int, a bridge.ServiceAction) bridge.Message {
	return bridge.Message{Conversation: "g1", ID: id, From: from, Date: time.Now().Add(time.Duration(minutes-60) * time.Minute), Service: &a}
}

func TestSystemLinesOfTheOtherAppBecomeChatsOwn(t *testing.T) {
	e := newEnv(t)
	chatID := e.twoWay()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	for _, m := range []bridge.Message{
		service("s1", lan, 10, bridge.ServiceAction{Kind: bridge.ServiceMembersAdded, People: []bridge.Participant{minh, {ID: "u-hoa", Name: "Hoa"}}}),
		service("s2", lan, 11, bridge.ServiceAction{Kind: bridge.ServiceTitleChanged, Title: "Nhóm mới"}),
		service("s3", lan, 12, bridge.ServiceAction{Kind: bridge.ServiceMessagePinned, MessageID: "m1"}),
		// a pin of a message Chat does not have cannot be shown
		service("s4", lan, 13, bridge.ServiceAction{Kind: bridge.ServiceMessagePinned, MessageID: "404"}),
		service("s5", minh, 14, bridge.ServiceAction{Kind: bridge.ServiceMemberLeft}),
		service("s6", lan, 15, bridge.ServiceAction{Kind: bridge.ServiceMemberRemoved, People: []bridge.Participant{{ID: "u-hoa", Name: "Hoa"}}}),
		service("s7", lan, 16, bridge.ServiceAction{Kind: "game_score"}),
	} {
		e.fake.Push(bridge.Event{Message: &m})
	}
	want := "[added:2 title:Nhóm mới pinned left removed]"
	e.eventually(func() bool { return fmt.Sprint(e.systemLines(chatID)) == want },
		func() string { return fmt.Sprintf("system lines = %v, want %s", e.systemLines(chatID), want) })
	// text messages are untouched
	e.waitTexts(chatID, []string{"tin 1", "tin 2"})
}

func TestSystemLinesSwitchedOffDoNotComeIn(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	chatID := e.twoWay()
	eng := e.start()
	e.eventually(func() bool { return e.backfillDone(chatID) }, func() string { return "backfill not done" })
	if err := eng.SetFeature(ctx, e.owner, e.account, "g1", feature.Service, feature.Off); err != nil {
		t.Fatal(err)
	}
	m := service("s1", lan, 10, bridge.ServiceAction{Kind: bridge.ServiceTitleChanged, Title: "Nhóm mới"})
	e.fake.Push(bridge.Event{Message: &m})
	after := e.msg("m3", lan, "tin 3", 11)
	e.fake.Push(bridge.Event{Message: &after})
	e.waitTexts(chatID, []string{"tin 1", "tin 2", "tin 3"})
	if got := e.systemLines(chatID); len(got) != 0 {
		t.Fatalf("system lines came in with the feature off: %v", got)
	}
}
