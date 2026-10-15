package api_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/auth/idptest"
	"connectrpc.com/connect"
	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
)

// previewTarget is the one local address the link preview fetcher may
// reach in these tests (the public-address policy refuses loopback).
var previewTarget atomic.Pointer[netip.AddrPort]

func e2eAllow(ap netip.AddrPort) bool {
	t := previewTarget.Load()
	return t != nil && *t == ap
}

type chatClients struct {
	clients
	chats    appv1connect.ChatsServiceClient
	messages appv1connect.MessagesServiceClient
	updates  appv1connect.UpdatesServiceClient
	http     *http.Client
	userID   int64
}

// member signs a new account in with its own browser.
func (e *env) member(t *testing.T, username string) *chatClients {
	t.Helper()
	e.idp.SetAccount(idptest.Account{Sub: "acc_" + username, SID: "sid-" + username, PreferredUsername: username, Name: strings.ToUpper(username)})
	cl, c := e.signedIn(t)
	base := e.srv.URL + "/rpc"
	opt := withOrigin(e.srv.URL)
	m := &chatClients{
		clients:  cl,
		chats:    appv1connect.NewChatsServiceClient(c, base, opt),
		messages: appv1connect.NewMessagesServiceClient(c, base, opt),
		updates:  appv1connect.NewUpdatesServiceClient(c, base, opt),
		http:     c,
	}
	self, err := getSelf(t, cl)
	if err != nil {
		t.Fatal(err)
	}
	m.userID = self.GetId()
	return m
}

// socket is a realtime client of one browser session.
type socket struct {
	ws     *websocket.Conn
	frames chan *appv1.ServerFrame
	hello  *appv1.HelloFrame
}

func (e *env) dial(t *testing.T, m *chatClients, origin string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	u, _ := url.Parse(e.srv.URL)
	header := http.Header{}
	header.Set("Origin", origin)
	var cookies []string
	for _, ck := range m.http.Jar.Cookies(u) {
		cookies = append(cookies, ck.Name+"="+ck.Value)
	}
	if len(cookies) > 0 {
		header.Set("Cookie", strings.Join(cookies, "; "))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, "wss://"+u.Host+"/ws", &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: e.srv.Client().Transport}, HTTPHeader: header,
	})
}

// connect opens the socket, says hello and waits for HelloFrame.
func (e *env) connect(t *testing.T, m *chatClients) *socket {
	t.Helper()
	ws, _, err := e.dial(t, m, e.srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	s := &socket{ws: ws, frames: make(chan *appv1.ServerFrame, 1024)}
	t.Cleanup(func() { _ = ws.CloseNow() })
	hello, err := proto.Marshal(&appv1.ClientFrame{Frame: &appv1.ClientFrame_Hello{Hello: &appv1.ClientHelloFrame{
		Platform: appv1.ClientPlatform_CLIENT_PLATFORM_WEB,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.Write(context.Background(), websocket.MessageBinary, hello); err != nil {
		t.Fatal(err)
	}
	go func() {
		defer close(s.frames)
		for {
			_, data, err := ws.Read(context.Background())
			if err != nil {
				return
			}
			f := &appv1.ServerFrame{}
			if proto.Unmarshal(data, f) == nil {
				s.frames <- f
			}
		}
	}()
	f := s.next(t)
	// The socket is registered before Hello is written, so an update the
	// dispatcher was still delivering (committed before the dial, like the
	// chats every start creates) may come first; clients order by pts.
	for f.GetUpdate() != nil {
		f = s.next(t)
	}
	if f.GetHello() == nil {
		t.Fatalf("first frame = %v, want hello", f)
	}
	s.hello = f.GetHello()
	return s
}

func (s *socket) send(t *testing.T, f *appv1.ClientFrame) {
	t.Helper()
	b, err := proto.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ws.Write(context.Background(), websocket.MessageBinary, b); err != nil {
		t.Fatal(err)
	}
}

func (s *socket) next(t *testing.T) *appv1.ServerFrame {
	t.Helper()
	select {
	case f, ok := <-s.frames:
		if !ok {
			t.Fatal("socket closed")
		}
		return f
	case <-time.After(5 * time.Second):
		t.Fatal("no frame within 5s")
	}
	return nil
}

// reply returns the next frame that is not an update: the chats every
// start creates (the assistant chat) may still be on their way when a test
// waits for the answer to a request.
func (s *socket) reply(t *testing.T) *appv1.ServerFrame {
	t.Helper()
	f := s.next(t)
	for f.GetUpdate() != nil {
		f = s.next(t)
	}
	return f
}

// updates collects the next n per-user updates (skipping presence, typing
// and pong frames).
func (s *socket) updates(t *testing.T, n int) []*appv1.Update {
	t.Helper()
	var out []*appv1.Update
	for len(out) < n {
		f := s.next(t)
		if u := f.GetUpdate(); u != nil {
			out = append(out, u.GetUpdates()...)
		}
	}
	return out
}

func kindOf(u *appv1.Update) string {
	if u.GetKind() == nil {
		return "empty"
	}
	name := fmt.Sprintf("%T", u.GetKind())
	return strings.TrimPrefix(name, "*appv1.Update_")
}

// rpcOK calls a unary RPC and fails the test on error.
func rpcOK[Req, Resp any](t *testing.T, fn func(context.Context, *connect.Request[Req]) (*connect.Response[Resp], error), msg *Req) *Resp {
	t.Helper()
	resp, err := fn(context.Background(), connect.NewRequest(msg))
	if err != nil {
		t.Fatal(err)
	}
	return resp.Msg
}

func TestRealtimeEndToEnd(t *testing.T) {
	e := newEnv(t)
	alice := e.member(t, "alice")
	bob := e.member(t, "bob")
	aliceWS := e.connect(t, alice)
	bobWS := e.connect(t, bob)
	if bobWS.hello.GetUserId() != bob.userID || bobWS.hello.GetServerEpoch() < 1 || bobWS.hello.GetHeartbeatIntervalMs() != 25000 {
		t.Fatalf("hello = %v", bobWS.hello)
	}
	start := rpcOK(t, bob.updates.GetState, &appv1.GetStateRequest{}).GetState()

	// Default privacy lets only bob's contacts add him to groups
	// (add_to_groups = contacts). A private chat writes no update until its
	// first message, and lets bob find alice by id to add her.
	rpcOK(t, alice.chats.CreatePrivate, &appv1.CreatePrivateRequest{UserId: bob.userID})
	if early := rpcOK(t, alice.chats.CreateGroup, &appv1.CreateGroupRequest{
		Title: "Too soon", UserIds: []int64{bob.userID},
	}); len(early.GetFailedUserIds()) != 1 || early.GetFailedUserIds()[0] != bob.userID {
		t.Fatalf("group with a non-contact = %v", early)
	}
	if u := rpcOK(t, bob.users.AddContact, &appv1.AddContactRequest{
		Target: &appv1.AddContactRequest_UserId{UserId: alice.userID},
	}).GetUser(); u.GetId() != alice.userID {
		t.Fatalf("AddContact = %v", u)
	}

	// Each step waits for bob's update before the next mutation, as in a
	// conversation; updates render the message as it is when delivered.
	pts := start.GetPts()
	var got []*appv1.Update
	expect := func(kind string) *appv1.Update {
		t.Helper()
		u := bobWS.updates(t, 1)[0]
		if kindOf(u) != kind {
			t.Fatalf("update %d = %s, want %s: %v", len(got), kindOf(u), kind, u)
		}
		if u.GetPts() != pts+1 || u.GetPtsCount() != 1 || u.GetServerEpoch() != bobWS.hello.GetServerEpoch() {
			t.Fatalf("update %d pts %d/%d epoch %d, want pts %d", len(got), u.GetPts(), u.GetPtsCount(), u.GetServerEpoch(), pts+1)
		}
		pts = u.GetPts()
		got = append(got, u)
		return u
	}

	// A group with topics.
	group := rpcOK(t, alice.chats.CreateGroup, &appv1.CreateGroupRequest{
		Title: "Ops", UserIds: []int64{bob.userID}, Forum: true,
	})
	chatID := group.GetChat().GetId()
	if !group.GetChat().GetForum() || len(group.GetFailedUserIds()) != 0 || group.GetAck().GetPts() == 0 {
		t.Fatalf("CreateGroup = %v", group)
	}
	created := expect("MessageNew").GetMessageNew().GetMessage()
	if created.GetAction().GetChatCreated().GetTitle() != "Ops" || created.GetTopicId() != 1 {
		t.Fatalf("chat created = %v", created)
	}
	topic := rpcOK(t, alice.chats.CreateForumTopic, &appv1.CreateForumTopicRequest{
		ChatId: chatID, Title: "Deploys", IconColor: 0x6e56cf,
	}).GetTopic()
	if topic.GetId() != 2 {
		t.Fatalf("topic id = %d, want 2 (1 is General)", topic.GetId())
	}
	if tc := expect("TopicChanged").GetTopicChanged().GetTopic(); tc.GetTitle() != "Deploys" || tc.GetChatId() != chatID {
		t.Fatalf("topic changed = %v", tc)
	}

	sent := rpcOK(t, alice.messages.SendMessage, &appv1.SendMessageRequest{
		ChatId: chatID, Text: "release 1.2 is out", TopicId: topic.GetId(), RandomId: 77,
	})
	if sent.GetMessage().GetTopicId() != topic.GetId() || sent.GetMessage().GetRandomId() != 77 {
		t.Fatalf("SendMessage = %v", sent)
	}
	msg := expect("MessageNew").GetMessageNew().GetMessage()
	if msg.GetTopicId() != topic.GetId() || msg.GetText() != "release 1.2 is out" || msg.GetRandomId() != 0 || msg.GetFromId() != alice.userID {
		t.Fatalf("bob sees %v (random_id is the sender's only)", msg)
	}
	again := rpcOK(t, alice.messages.SendMessage, &appv1.SendMessageRequest{
		ChatId: chatID, Text: "release 1.2 is out", TopicId: topic.GetId(), RandomId: 77,
	})
	if again.GetMessage().GetSeq() != sent.GetMessage().GetSeq() || again.GetAck().GetPts() != sent.GetAck().GetPts() {
		t.Fatalf("retry with the same random_id = %v, want the first send %v", again, sent)
	}
	seq := sent.GetMessage().GetSeq()
	reply := rpcOK(t, bob.messages.SendMessage, &appv1.SendMessageRequest{
		ChatId: chatID, Text: "nice", TopicId: topic.GetId(), ReplyToSeq: seq,
	})
	if echo := expect("MessageNew").GetMessageNew().GetMessage(); echo.GetReplyToSeq() != seq || echo.GetFromId() != bob.userID {
		t.Fatalf("reply echo = %v", echo)
	}
	rpcOK(t, alice.messages.EditMessage, &appv1.EditMessageRequest{
		ChatId: chatID, Seq: seq, Text: "release 1.2.1 is out",
	})
	if ed := expect("MessageEdit").GetMessageEdit().GetMessage(); ed.GetEditVersion() != 1 || ed.GetText() != "release 1.2.1 is out" || ed.GetEditDate() == 0 {
		t.Fatalf("edit = %v", ed)
	}
	react := rpcOK(t, bob.messages.SetReaction, &appv1.SetReactionRequest{ChatId: chatID, Seq: seq, Emoji: "👍"})
	if len(react.GetReactions()) != 1 || !react.GetReactions()[0].GetChosen() {
		t.Fatalf("SetReaction = %v", react)
	}
	if r := expect("Reaction").GetReaction().GetReactions(); len(r) != 1 || r[0].GetEmoji() != "👍" || !r[0].GetChosen() {
		t.Fatalf("reaction = %v", r)
	}
	read := rpcOK(t, bob.messages.ReadHistory, &appv1.ReadHistoryRequest{
		ChatId: chatID, MaxSeq: reply.GetMessage().GetSeq(), TopicId: topic.GetId(),
	})
	if read.GetAck().GetPts() == 0 || read.GetAck().GetPtsCount() != 1 {
		t.Fatalf("ReadHistory ack = %v", read.GetAck())
	}
	readUpdate := expect("Read")
	rd := readUpdate.GetRead()
	// The topic is read; the chat-created message in General is not.
	if rd.GetOutbox() || rd.GetTopicId() != topic.GetId() || rd.GetUnreadCount() != 1 || rd.GetTopicUnreadCount() != 0 ||
		rd.GetTopSeq() < reply.GetMessage().GetSeq() || readUpdate.GetPts() != read.GetAck().GetPts() {
		t.Fatalf("read = %v", rd)
	}
	rpcOK(t, alice.messages.DeleteMessages, &appv1.DeleteMessagesRequest{
		ChatId: chatID, Seqs: []int64{seq}, ForEveryone: true,
	})
	if d := expect("MessageDelete").GetMessageDelete(); d.GetChatId() != chatID || len(d.GetSeqs()) != 1 || d.GetSeqs()[0] != seq {
		t.Fatalf("delete = %v", d)
	}
	want := []string{"MessageNew", "TopicChanged", "MessageNew", "MessageNew", "MessageEdit", "Reaction", "Read", "MessageDelete"}

	// Alice's socket saw bob read her message (read outbox).
	sawOutbox := false
	for !sawOutbox {
		for _, u := range aliceWS.updates(t, 1) {
			if r := u.GetRead(); r != nil && r.GetOutbox() && r.GetMaxSeq() == seq {
				sawOutbox = true
			}
		}
	}

	// GetDifference replays the same log; the deleted message has no body.
	diff := rpcOK(t, bob.updates.GetDifference, &appv1.GetDifferenceRequest{
		Pts: start.GetPts(), ServerEpoch: start.GetServerEpoch(),
	})
	full := diff.GetFull()
	if full == nil || len(full.GetUpdates()) != len(want) || diff.GetState().GetPts() != pts {
		t.Fatalf("difference = %v", diff)
	}
	for i, u := range full.GetUpdates() {
		wantKind := want[i]
		if i == 2 || i == 4 || i == 5 {
			wantKind = "empty" // new, edit and reaction of the deleted message
		}
		if kindOf(u) != wantKind || u.GetPts() != got[i].GetPts() {
			t.Fatalf("difference update %d = %s pts %d, want %s pts %d", i, kindOf(u), u.GetPts(), wantKind, got[i].GetPts())
		}
	}
	if len(full.GetChats()) == 0 || len(full.GetUsers()) == 0 {
		t.Fatalf("difference carries no entities: %v", full)
	}
	stale := rpcOK(t, bob.updates.GetDifference, &appv1.GetDifferenceRequest{
		Pts: start.GetPts(), ServerEpoch: start.GetServerEpoch() + 1,
	})
	if stale.GetTooLong() == nil {
		t.Fatalf("difference across epochs = %v, want too_long", stale)
	}

	// History of the topic (the recalled message keeps its place, without
	// content), the dialog and the topic list.
	hist := rpcOK(t, bob.messages.GetHistory, &appv1.GetHistoryRequest{ChatId: chatID, TopicId: topic.GetId()})
	if msgs := hist.GetMessages(); len(msgs) != 2 || !msgs[0].GetRecalled() || msgs[0].GetText() != "" ||
		msgs[1].GetSeq() != reply.GetMessage().GetSeq() {
		t.Fatalf("topic history = %v", hist)
	}
	topics := rpcOK(t, bob.chats.GetForumTopics, &appv1.GetForumTopicsRequest{ChatId: chatID})
	if len(topics.GetTopics()) != 2 {
		t.Fatalf("topics = %v", topics)
	}
	peer := rpcOK(t, alice.chats.GetPeerDialogs, &appv1.GetPeerDialogsRequest{ChatIds: []int64{chatID, 999}})
	if len(peer.GetDialogs()) != 1 || peer.GetDialogs()[0].GetTopSeq() != reply.GetMessage().GetSeq() ||
		peer.GetDialogs()[0].GetUnreadCount() != 1 || peer.GetDialogs()[0].GetReadOutboxMaxSeq() != seq {
		t.Fatalf("peer dialogs = %v", peer)
	}

	// Revoking bob's session closes his socket within a second.
	revokedAt := time.Now()
	rpcOK(t, bob.auth.SignOut, &appv1.SignOutRequest{})
	for {
		f, ok := <-bobWS.frames
		if !ok {
			t.Fatal("socket closed without SessionRevokedFrame")
		}
		if r := f.GetSessionRevoked(); r != nil {
			if r.GetReason() != appv1.SessionRevokeReason_SESSION_REVOKE_REASON_SIGNED_OUT {
				t.Fatalf("revoke reason = %v", r.GetReason())
			}
			break
		}
	}
	if _, ok := <-bobWS.frames; ok {
		t.Fatal("socket stayed open after revocation")
	}
	if took := time.Since(revokedAt); took > time.Second {
		t.Fatalf("revocation took %v, want <= 1s", took)
	}
}

func TestRealtimeHandshakeChecks(t *testing.T) {
	e := newEnv(t)
	alice := e.member(t, "alice")
	if _, resp, err := e.dial(t, alice, "https://evil.example"); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin: resp %v err %v", resp, err)
	}
	anon := &chatClients{http: e.browser(t)}
	if _, resp, err := e.dial(t, anon, e.srv.URL); err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no session: resp %v err %v", resp, err)
	}
	// Open chat and typing are refused for chats the user is not in.
	bob := e.member(t, "bob")
	carol := e.member(t, "carol")
	group := rpcOK(t, bob.chats.CreateGroup, &appv1.CreateGroupRequest{Title: "private"})
	ws := e.connect(t, carol)
	ws.send(t, &appv1.ClientFrame{RequestId: 5, Frame: &appv1.ClientFrame_OpenChat{OpenChat: &appv1.OpenChatFrame{ChatId: group.GetChat().GetId()}}})
	f := ws.reply(t)
	if f.GetError().GetCode() != appv1.FrameErrorCode_FRAME_ERROR_CODE_FORBIDDEN || f.GetError().GetRequestId() != 5 {
		t.Fatalf("open chat of a stranger = %v", f)
	}
	ws.send(t, &appv1.ClientFrame{RequestId: 6, Frame: &appv1.ClientFrame_Typing{Typing: &appv1.TypingFrame{ChatId: group.GetChat().GetId()}}})
	if f := ws.reply(t); f.GetError().GetCode() != appv1.FrameErrorCode_FRAME_ERROR_CODE_FORBIDDEN {
		t.Fatalf("typing in a stranger's chat = %v", f)
	}
	ws.send(t, &appv1.ClientFrame{RequestId: 7, Frame: &appv1.ClientFrame_Ping{Ping: &appv1.PingFrame{}}})
	if f := ws.reply(t); f.GetPong().GetRequestId() != 7 {
		t.Fatalf("pong = %v", f)
	}
}

func TestRealtimeTypingAndPresence(t *testing.T) {
	e := newEnv(t)
	alice := e.member(t, "alice")
	bob := e.member(t, "bob")
	chat := rpcOK(t, alice.chats.CreatePrivate, &appv1.CreatePrivateRequest{UserId: bob.userID}).GetChat()
	// Bob's last seen (default: contacts) is exact for alice once she is in
	// his contacts.
	rpcOK(t, bob.users.AddContact, &appv1.AddContactRequest{Target: &appv1.AddContactRequest_UserId{UserId: alice.userID}})
	aliceWS := e.connect(t, alice)
	open := func(s *socket) {
		s.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_OpenChat{OpenChat: &appv1.OpenChatFrame{ChatId: chat.GetId()}}})
	}
	open(aliceWS)
	// Bob is offline: alice hears his presence when she opens the chat.
	if p := aliceWS.reply(t).GetPresence(); p.GetUserId() != bob.userID || p.GetStatus().GetKind() == appv1.UserStatusKind_USER_STATUS_KIND_ONLINE {
		t.Fatalf("presence of offline bob = %v", p)
	}
	bobWS := e.connect(t, bob)
	if p := aliceWS.reply(t).GetPresence(); p.GetUserId() != bob.userID || p.GetStatus().GetKind() != appv1.UserStatusKind_USER_STATUS_KIND_ONLINE {
		t.Fatalf("presence after bob connected = %v", p)
	}
	open(bobWS)
	if p := bobWS.reply(t).GetPresence(); p.GetUserId() != alice.userID {
		t.Fatalf("bob's view of alice = %v", p)
	}
	bobWS.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_Typing{Typing: &appv1.TypingFrame{
		ChatId: chat.GetId(), Action: appv1.TypingAction_TYPING_ACTION_TYPING, UserId: 12345,
	}}})
	ty := aliceWS.reply(t).GetTyping()
	if ty.GetChatId() != chat.GetId() || ty.GetUserId() != bob.userID || ty.GetAction() != appv1.TypingAction_TYPING_ACTION_TYPING {
		t.Fatalf("typing = %v (user_id is set by the server)", ty)
	}
	bobWS.send(t, &appv1.ClientFrame{Frame: &appv1.ClientFrame_Presence{Presence: &appv1.ClientPresenceFrame{Foreground: false}}})
	if p := aliceWS.reply(t).GetPresence(); p.GetStatus().GetKind() != appv1.UserStatusKind_USER_STATUS_KIND_OFFLINE {
		t.Fatalf("presence after bob went to background = %v", p)
	}
}

const ogPage = `<html><head><meta property="og:site_name" content="Status">
<meta property="og:title" content="All systems operational"><meta property="og:description" content="No incidents."></head></html>`

func TestLinkPreviewEndToEnd(t *testing.T) {
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprint(w, ogPage)
	}))
	defer page.Close()
	pu, _ := url.Parse(page.URL)
	addr := netip.MustParseAddrPort(pu.Host)
	previewTarget.Store(&addr)
	defer previewTarget.Store(nil)

	e := newEnv(t)
	ctx := context.Background()
	alice := e.member(t, "alice")
	bob := e.member(t, "bob")
	chat := rpcOK(t, alice.chats.CreatePrivate, &appv1.CreatePrivateRequest{UserId: bob.userID}).GetChat()
	bobWS := e.connect(t, bob)

	// The composer asks first; the page is fetched and cached.
	p := rpcOK(t, alice.messages.GetLinkPreview, &appv1.GetLinkPreviewRequest{Url: page.URL + "/status"}).GetPreview()
	if p.GetSiteName() != "Status" || p.GetTitle() != "All systems operational" || p.GetDescription() != "No incidents." {
		t.Fatalf("preview = %v", p)
	}
	// A cached preview is attached at send time.
	sent := rpcOK(t, alice.messages.SendMessage, &appv1.SendMessageRequest{
		ChatId: chat.GetId(), Text: "see " + page.URL + "/status",
	}).GetMessage()
	if sent.GetLinkPreview().GetTitle() != "All systems operational" {
		t.Fatalf("sent message preview = %v", sent.GetLinkPreview())
	}
	// Dropped by the sender.
	plain := rpcOK(t, alice.messages.SendMessage, &appv1.SendMessageRequest{
		ChatId: chat.GetId(), Text: "see " + page.URL + "/status", NoLinkPreview: true,
	}).GetMessage()
	if plain.GetLinkPreview() != nil {
		t.Fatalf("preview kept although dropped: %v", plain.GetLinkPreview())
	}
	// Not cached yet: the server fetches after the send and edits it in.
	later := rpcOK(t, alice.messages.SendMessage, &appv1.SendMessageRequest{
		ChatId: chat.GetId(), Text: page.URL + "/other",
	}).GetMessage()
	if later.GetLinkPreview() != nil {
		t.Fatal("uncached preview attached synchronously")
	}
	deadline := time.After(10 * time.Second)
	for found := false; !found; {
		select {
		case f := <-bobWS.frames:
			for _, u := range f.GetUpdate().GetUpdates() {
				m := u.GetMessageEdit().GetMessage()
				if m.GetSeq() == later.GetSeq() && m.GetLinkPreview().GetTitle() == "All systems operational" && m.GetEditDate() == 0 {
					found = true
				}
			}
		case <-deadline:
			t.Fatal("no message_edit with the fetched preview")
		}
	}

	// Private addresses are refused: no preview.
	for _, u := range []string{"http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:1/"} {
		resp := rpcOK(t, alice.messages.GetLinkPreview, &appv1.GetLinkPreviewRequest{Url: u})
		if resp.GetPreview() != nil {
			t.Fatalf("preview of %s = %v, want none", u, resp.GetPreview())
		}
	}
	if _, err := alice.messages.GetLinkPreview(ctx, connect.NewRequest(&appv1.GetLinkPreviewRequest{Url: "file:///etc/passwd"})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("file URL: %v", err)
	}
}
