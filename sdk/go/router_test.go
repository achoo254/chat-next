package chatbot

import (
	"context"
	"encoding/json"
	"testing"
)

func commandUpdate(id int64, text string, length int64) Update {
	return Update{UpdateID: id, Message: &Message{
		Chat:     Chat{ID: 77, Type: "group"},
		Seq:      id,
		TopicID:  3,
		Text:     text,
		Entities: []Entity{{Type: EntityTypeBotCommand, Offset: 0, Length: length}},
	}}
}

func newTestRouter(t *testing.T) (*fakeAPI, *Router) {
	t.Helper()
	f := newFakeAPI(t)
	f.ok("GET /bot/v1/me", map[string]any{"id": 9, "is_bot": true, "name": "Echo", "username": "Echo_bot", "privacy": true, "tier": "default"})
	f.ok("POST /bot/v1/messages", map[string]any{"chat": map[string]any{"id": 77}, "seq": 1, "date": 1})
	return f, NewRouter(f.client(nil))
}

func TestRouterCommandsAndUsername(t *testing.T) {
	f, r := newTestRouter(t)
	var got []string
	r.Command("start", func(_ context.Context, c *Context) error {
		got = append(got, "start:"+c.Args)
		return nil
	})
	r.Message(func(_ context.Context, c *Context) error {
		got = append(got, "message:"+c.Update.Message.Text)
		return nil
	})
	ctx := context.Background()
	steps := []Update{
		commandUpdate(1, "/start  hello world ", 6),
		commandUpdate(2, "/start@echo_bot x", 15),
		commandUpdate(3, "/start@other_bot y", 16),
		commandUpdate(4, "/START", 6),
		commandUpdate(5, "/help", 5),
		{UpdateID: 6, Message: &Message{Chat: Chat{ID: 77}, Text: "say /start", Entities: []Entity{{Type: EntityTypeBotCommand, Offset: 4, Length: 6}}}},
	}
	for _, u := range steps {
		if _, err := r.Handle(ctx, u); err != nil {
			t.Fatalf("Handle(%d): %v", u.UpdateID, err)
		}
	}
	want := []string{"start:hello world", "start:x", "message:/start@other_bot y", "start:", "message:/help", "message:say /start"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("step %d = %q, want %q", i, got[i], want[i])
		}
	}
	if n := f.count("GET /bot/v1/me"); n != 1 {
		t.Errorf("getMe called %d times, want 1", n)
	}
}

func TestRouterCommandOffsetsCountUTF16(t *testing.T) {
	_, r := newTestRouter(t)
	var args string
	r.Command("hi", func(_ context.Context, c *Context) error {
		args = c.Args
		return nil
	})
	if _, err := r.Handle(context.Background(), commandUpdate(1, "/hi 😀 xin chào", 3)); err != nil {
		t.Fatal(err)
	}
	if args != "😀 xin chào" {
		t.Errorf("args = %q", args)
	}
}

func TestRouterCallbackLongestPrefixWins(t *testing.T) {
	_, r := newTestRouter(t)
	var got string
	r.Callback("pick:", func(context.Context, *Context) error { got = "short"; return nil })
	r.Callback("pick:a", func(context.Context, *Context) error { got = "long"; return nil })
	r.Callback("", func(context.Context, *Context) error { got = "any"; return nil })
	cb := func(data string) Update {
		return Update{UpdateID: 1, Callback: &Callback{ID: "c1", Data: data, Message: Message{Chat: Chat{ID: 77}, Seq: 5}}}
	}
	for data, want := range map[string]string{"pick:a": "long", "pick:b": "short", "other": "any"} {
		got = ""
		if _, err := r.Handle(context.Background(), cb(data)); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("%q routed to %q, want %q", data, got, want)
		}
	}
}

func TestContextReplyAndAnswer(t *testing.T) {
	f, r := newTestRouter(t)
	f.ok("POST /bot/v1/callbacks/c1:answer", true)
	r.Callback("pick:", func(ctx context.Context, c *Context) error {
		if err := c.Answer(ctx, "Đã chọn A", false); err != nil {
			return err
		}
		_, err := c.Reply(ctx, "Bạn chọn A", nil)
		return err
	})
	u := Update{UpdateID: 1, Callback: &Callback{ID: "c1", Data: "pick:a", Message: Message{Chat: Chat{ID: 77}, Seq: 5, TopicID: 3}}}
	if _, err := r.Handle(context.Background(), u); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	for _, req := range f.requests() {
		var body map[string]any
		_ = json.Unmarshal(req.Body, &body)
		switch req.Path {
		case "/bot/v1/callbacks/c1:answer":
			if body["text"] != "Đã chọn A" {
				t.Errorf("answer body = %s", req.Body)
			}
		case "/bot/v1/messages":
			if body["chat_id"] != float64(77) || body["text"] != "Bạn chọn A" || body["topic_id"] != float64(3) {
				t.Errorf("reply body = %s", req.Body)
			}
		}
	}
	if f.count("POST /bot/v1/messages") != 1 || f.count("POST /bot/v1/callbacks/c1:answer") != 1 {
		t.Errorf("requests = %+v", f.requests())
	}
}

func TestRouterInlineQuery(t *testing.T) {
	f, r := newTestRouter(t)
	f.ok("POST /bot/v1/inline/q1:answer", true)
	r.InlineQuery(func(ctx context.Context, c *Context) error {
		return c.AnswerInline(ctx, []InlineQueryResult{{Type: "article", ID: "1", Title: "HI", Text: c.Update.InlineQuery.Query}}, &AnswerInlineQueryRequest{IsPersonal: true})
	})
	if _, err := r.Handle(context.Background(), Update{UpdateID: 1, InlineQuery: &InlineQuery{ID: "q1", Query: "hi"}}); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	reqs := f.requests()
	if len(reqs) != 1 || reqs[0].Path != "/bot/v1/inline/q1:answer" {
		t.Fatalf("requests = %+v", reqs)
	}
	var body AnswerInlineQueryRequest
	if err := json.Unmarshal(reqs[0].Body, &body); err != nil || len(body.Results) != 1 || body.Results[0].Text != "hi" || !body.IsPersonal {
		t.Errorf("body = %s", reqs[0].Body)
	}
}

func TestRouterOtherKindsAndUnknown(t *testing.T) {
	f, r := newTestRouter(t)
	var got []UpdateKind
	r.On(UpdateKindMessageEdited, func(context.Context, *Context) error { got = append(got, UpdateKindMessageEdited); return nil })
	r.On(UpdateKindReaction, func(context.Context, *Context) error { got = append(got, UpdateKindReaction); return nil })
	ctx := context.Background()
	for _, u := range []Update{
		{UpdateID: 1, MessageEdited: &Message{Chat: Chat{ID: 1}}},
		{UpdateID: 2, Reaction: &Reaction{Emoji: "👍"}},
		{UpdateID: 3, ChannelPost: &Message{Chat: Chat{ID: 1}}},
		{UpdateID: 4},
		{UpdateID: 5, Message: &Message{Chat: Chat{ID: 1}, Text: "no handler"}},
	} {
		answer, err := r.Handle(ctx, u)
		if err != nil || answer != nil {
			t.Fatalf("Handle(%d) = %v, %v", u.UpdateID, answer, err)
		}
	}
	if len(got) != 2 || got[0] != UpdateKindMessageEdited || got[1] != UpdateKindReaction {
		t.Errorf("got %v", got)
	}
	if len(f.requests()) != 0 {
		t.Errorf("unexpected requests %+v", f.requests())
	}
}

func TestRouterIsAHandlerFunc(t *testing.T) {
	_, r := newTestRouter(t)
	var _ HandlerFunc = r.Handle
}
