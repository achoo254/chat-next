package api_test

import (
	"bufio"
	"bytes"
	"cmp"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/api"
	"app.local/server/internal/config"
	"connectrpc.com/connect"
)

// SDK conformance: the example bots of every SDK (sdk/ts, sdk/python,
// sdk/go), run as child processes against the real server in long poll and
// webhook mode, answer a user driving the app the same way (the contract:
// plans/dattqh/261013-0448-chat-platform-v1/phase-15-sdk-contract.md).
// Opt-in because it needs node, python3 and go: SDK_CONFORMANCE=1, or
// `pnpm conformance:sdk` from the repository root. The Python miniapp
// example needs the optional cryptography package: PYTHON names an
// interpreter that has it (a venv with `pip install './sdk/python[miniapp]'`),
// python3 by default.

// conformanceSDK starts one example bot of an SDK.
type conformanceSDK struct {
	name string
	dir  string
	// command runs the example; prepare builds what it needs once.
	command func(example string) *exec.Cmd
	prepare func(t *testing.T, examples []string)
}

var conformanceExamples = []string{"echo", "keyboard", "files", "commands", "inline", "miniapp"}

// conformanceMiniAppURL is the miniapp example's button URL: the server only
// takes https URLs on a public domain outside the app's own.
const conformanceMiniAppURL = "https://shop.example.com/app"

func conformanceSDKs(t *testing.T) []conformanceSDK {
	root, err := filepath.Abs("../../../sdk")
	if err != nil {
		t.Fatal(err)
	}
	goBin := t.TempDir()
	python := cmp.Or(os.Getenv("PYTHON"), "python3")
	return []conformanceSDK{
		{name: "ts", dir: filepath.Join(root, "ts"), command: func(ex string) *exec.Cmd {
			return exec.Command("node", filepath.Join("examples", ex+".ts"))
		}},
		{name: "python", dir: filepath.Join(root, "python"), command: func(ex string) *exec.Cmd {
			return exec.Command(python, filepath.Join("examples", ex+".py"))
		}},
		{name: "go", dir: filepath.Join(root, "go"), command: func(ex string) *exec.Cmd {
			return exec.Command(filepath.Join(goBin, ex))
		}, prepare: func(t *testing.T, examples []string) {
			for _, ex := range examples {
				build := exec.Command("go", "build", "-o", filepath.Join(goBin, ex), "./examples/"+ex)
				build.Dir = filepath.Join(root, "go")
				if out, err := build.CombinedOutput(); err != nil {
					t.Fatalf("build the Go example %s: %v\n%s", ex, err, out)
				}
			}
		}},
	}
}

// conformanceEnv is the server with media, reached by the bots through a
// plain-HTTP front like nginx: Bot API paths go to the tenant host, the rest
// (file downloads) to the media host, which is the front's own address.
type conformanceEnv struct {
	*mediaEnv
	front string
	// The bots' owner (an account owns at most 20 bots: one per SDK) and
	// the user driving them (one per SDK and mode, under the per-user rate
	// limits), set by as.
	admin appv1connect.BotAdminServiceClient
	user  *chatClients
	bots  appv1connect.BotsServiceClient
	// miniApp is the base URL of the miniapp example's backend.
	miniApp string
}

// forExample returns the env and the extra environment of an example's
// process: the miniapp example gets its button URL and a port for its
// backend.
func (e *conformanceEnv) forExample(t *testing.T, example string) (*conformanceEnv, []string) {
	t.Helper()
	if example != "miniapp" {
		return e, nil
	}
	port := freePort(t)
	with := *e
	with.miniApp = "http://127.0.0.1:" + port
	return &with, []string{"MINI_APP_URL=" + conformanceMiniAppURL, "MINI_APP_PORT=" + port}
}

// as returns the env acting with a new owner and user.
func (e *conformanceEnv) as(t *testing.T, name string) *conformanceEnv {
	t.Helper()
	owner := e.member(t, name+"owner")
	if resp, body := e.signIn(t, owner.http, "?reauth=1"); resp.StatusCode != http.StatusOK {
		t.Fatalf("reauth: %d %q", resp.StatusCode, body)
	}
	user := e.member(t, name+"user")
	opt := withOrigin(e.srv.URL)
	return &conformanceEnv{
		mediaEnv: e.mediaEnv, front: e.front, user: user,
		admin: appv1connect.NewBotAdminServiceClient(owner.http, e.srv.URL+"/rpc", opt),
		bots:  appv1connect.NewBotsServiceClient(user.http, e.srv.URL+"/rpc", opt),
	}
}

func newConformanceEnv(t *testing.T) *conformanceEnv {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	front := "http://" + ln.Addr().String()
	me := newMediaEnv(t, config.StorageFilesystem, func(m *config.Media) { m.PublicURL = mustURL(t, front) },
		func(c *config.Config, _ *api.Options) { c.BotWebhookLocal = true })
	target := mustURL(t, me.srv.URL)
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = ln.Addr().String()
			if strings.HasPrefix(r.In.URL.Path, "/bot/") {
				r.Out.Host = target.Host
			}
		},
		Transport: me.srv.Client().Transport,
	}
	srv := &http.Server{Handler: proxy, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	return &conformanceEnv{mediaEnv: me, front: front}
}

// newBot creates a bot owned by the owner and returns its id and token.
func (e *conformanceEnv) newBot(t *testing.T, username string) (int64, string) {
	t.Helper()
	ctx := t.Context()
	created, err := e.admin.CreateBot(ctx, connect.NewRequest(&appv1.CreateBotRequest{Username: username, Name: username}))
	if err != nil {
		t.Fatal(err)
	}
	id := created.Msg.GetBot().GetUser().GetId()
	reset, err := e.admin.ResetBotToken(ctx, connect.NewRequest(&appv1.ResetBotTokenRequest{BotId: id}))
	if err != nil {
		t.Fatal(err)
	}
	return id, reset.Msg.GetToken()
}

// runBot starts an example and waits for its "ready" line; the process is
// stopped when the test ends and its output logged when the test failed.
func runBot(t *testing.T, sdk conformanceSDK, example, mode, token, front string, extraEnv []string) {
	t.Helper()
	cmd := sdk.command(example)
	cmd.Dir = sdk.dir
	env := append([]string{"BOT_TOKEN=" + token, "BOT_API=" + front + "/bot/v1", "BOT_MODE=" + mode}, extraEnv...)
	if mode == "webhook" {
		port := freePort(t)
		env = append(env, "WEBHOOK_PORT="+port, "WEBHOOK_SECRET=conformance-secret-"+example,
			"WEBHOOK_URL=http://127.0.0.1:"+port+"/")
	}
	cmd.Env = append(os.Environ(), env...)
	cmd.WaitDelay = 3 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var logs safeBuffer
	cmd.Stderr = &logs
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s/%s: %v", sdk.name, example, err)
	}
	ready := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(stdout)
		signalled := false
		for scanner.Scan() {
			line := scanner.Text()
			_, _ = fmt.Fprintln(&logs, line)
			if line == "ready" && !signalled {
				signalled = true
				close(ready)
			}
		}
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Signal(os.Interrupt)
		done := make(chan struct{})
		go func() { _ = cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
		if t.Failed() {
			t.Logf("%s/%s output:\n%s", sdk.name, example, logs.String())
		}
	})
	select {
	case <-ready:
	case <-time.After(60 * time.Second):
		t.Fatalf("%s/%s never printed ready", sdk.name, example)
	}
}

func freePort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	return fmt.Sprint(ln.Addr().(*net.TCPAddr).Port)
}

type safeBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *safeBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *safeBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// botMessage waits for a message of the bot in the chat that matches.
func (e *conformanceEnv) botMessage(t *testing.T, chatID, botID int64, match func(*appv1.Message) bool) *appv1.Message {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		h, err := e.user.messages.GetHistory(t.Context(), connect.NewRequest(&appv1.GetHistoryRequest{ChatId: chatID, Limit: 20}))
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range h.Msg.GetMessages() {
			if m.GetFromId() == botID && match(m) {
				return m
			}
		}
		if time.Now().After(deadline) {
			var got []string
			for _, m := range h.Msg.GetMessages() {
				got = append(got, fmt.Sprintf("%d: %q", m.GetFromId(), m.GetText()))
			}
			t.Fatalf("no matching message of the bot; chat has %v", got)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func text(want string) func(*appv1.Message) bool {
	return func(m *appv1.Message) bool { return m.GetText() == want }
}

func (e *conformanceEnv) say(t *testing.T, chatID int64, text string) {
	t.Helper()
	if _, err := e.user.messages.SendMessage(t.Context(), connect.NewRequest(&appv1.SendMessageRequest{
		ChatId: chatID, Text: text, RandomId: time.Now().UnixNano() & (1<<52 - 1),
	})); err != nil {
		t.Fatal(err)
	}
}

func (e *conformanceEnv) start(t *testing.T, botID int64) int64 {
	t.Helper()
	started, err := e.bots.StartBot(t.Context(), connect.NewRequest(&appv1.StartBotRequest{BotId: botID, RandomId: time.Now().UnixNano() & (1<<52 - 1)}))
	if err != nil {
		t.Fatal(err)
	}
	return started.Msg.GetChat().GetId()
}

// conformanceScenarios drive one example each, as the user.
var conformanceScenarios = map[string]func(t *testing.T, e *conformanceEnv, botID int64){
	"echo": func(t *testing.T, e *conformanceEnv, botID int64) {
		chatID := e.start(t, botID)
		e.botMessage(t, chatID, botID, text("Xin chào! Gửi gì mình nhắc lại nấy."))
		e.say(t, chatID, "ping Hà Nội")
		e.botMessage(t, chatID, botID, text("ping Hà Nội"))
	},
	"keyboard": func(t *testing.T, e *conformanceEnv, botID int64) {
		chatID := e.start(t, botID)
		m := e.botMessage(t, chatID, botID, text("Chọn một:"))
		rows := m.GetReplyMarkup().GetInlineKeyboard().GetRows()
		if len(rows) != 1 || len(rows[0].GetButtons()) != 2 || rows[0].GetButtons()[0].GetCallbackData() == nil {
			t.Fatalf("keyboard = %v", m.GetReplyMarkup())
		}
		pressed, err := e.user.messages.PressInlineButton(t.Context(), connect.NewRequest(&appv1.PressInlineButtonRequest{
			ChatId: chatID, Seq: m.GetSeq(), CallbackData: []byte("pick:a"),
		}))
		if err != nil || pressed.Msg.GetText() != "Đã chọn A" {
			t.Fatalf("press: %v, %v", pressed, err)
		}
		edited := e.botMessage(t, chatID, botID, func(x *appv1.Message) bool { return x.GetSeq() == m.GetSeq() && x.GetText() == "Bạn chọn A" })
		if edited.GetReplyMarkup().GetInlineKeyboard() != nil {
			t.Fatalf("the keyboard is still there: %v", edited.GetReplyMarkup())
		}
	},
	"files": func(t *testing.T, e *conformanceEnv, botID int64) {
		chatID := e.start(t, botID)
		e.say(t, chatID, "/file")
		sent := e.botMessage(t, chatID, botID, func(m *appv1.Message) bool { return m.GetMedia() != nil })
		if sent.GetMedia().GetFileName() != "hello.txt" || sent.GetMedia().GetSize() != int64(len("xin chào")) || sent.GetText() != "Tệp mẫu" {
			t.Fatalf("the bot's file = %v %q", sent.GetMedia(), sent.GetText())
		}
		ref, err := e.upload(t, e.user, appv1.MediaKind_MEDIA_KIND_DOCUMENT, "note.txt", []byte("ba chữ"), nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.user.messages.SendMedia(t.Context(), connect.NewRequest(&appv1.SendMediaRequest{
			ChatId: chatID, FileId: ref.GetFileId(), RandomId: time.Now().UnixNano() & (1<<52 - 1),
		})); err != nil {
			t.Fatal(err)
		}
		e.botMessage(t, chatID, botID, text(fmt.Sprintf("Nhận note.txt: %d byte", len("ba chữ"))))
	},
	"commands": func(t *testing.T, e *conformanceEnv, botID int64) {
		chatID := e.start(t, botID)
		e.botMessage(t, chatID, botID, text("Sẵn sàng."))
		info, err := e.bots.GetBotInfo(t.Context(), connect.NewRequest(&appv1.GetBotInfoRequest{BotId: botID, ChatId: chatID}))
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, c := range info.Msg.GetCommands() {
			names = append(names, c.GetCommand()+"="+c.GetDescription())
		}
		if strings.Join(names, ",") != "start=Bắt đầu,help=Trợ giúp" {
			t.Fatalf("commands = %v", names)
		}
		e.say(t, chatID, "/help")
		e.botMessage(t, chatID, botID, text("Lệnh: /start, /help"))
	},
	"inline": func(t *testing.T, e *conformanceEnv, botID int64) {
		if _, err := e.admin.UpdateBot(t.Context(), connect.NewRequest(&appv1.UpdateBotRequest{BotId: botID, InlinePlaceholder: ptr("Tìm…")})); err != nil {
			t.Fatal(err)
		}
		chatID := e.start(t, botID)
		res, err := e.bots.InlineQuery(t.Context(), connect.NewRequest(&appv1.InlineQueryRequest{BotId: botID, ChatId: chatID, Query: "phở bò"}))
		if err != nil || len(res.Msg.GetResults()) != 1 || res.Msg.GetResults()[0].GetTitle() != "PHỞ BÒ" || res.Msg.GetResults()[0].GetId() != "1" {
			t.Fatalf("inline: %v, %v", res, err)
		}
	},
	"miniapp": func(t *testing.T, e *conformanceEnv, botID int64) {
		chatID := e.start(t, botID)
		m := e.botMessage(t, chatID, botID, func(m *appv1.Message) bool { return m.GetReplyMarkup().GetInlineKeyboard() != nil })
		rows := m.GetReplyMarkup().GetInlineKeyboard().GetRows()
		if len(rows) != 1 || len(rows[0].GetButtons()) != 1 || rows[0].GetButtons()[0].GetText() != "Mở cửa hàng" ||
			rows[0].GetButtons()[0].GetMiniAppUrl() != conformanceMiniAppURL {
			t.Fatalf("keyboard = %v", m.GetReplyMarkup())
		}
		opened, err := e.bots.OpenMiniApp(t.Context(), connect.NewRequest(&appv1.OpenMiniAppRequest{
			BotId: botID, ChatId: chatID, Seq: m.GetSeq(), Url: conformanceMiniAppURL,
		}))
		if err != nil {
			t.Fatal(err)
		}
		status, body := e.verifyMiniApp(t, opened.Msg.GetInitData())
		var who struct {
			UserID   int64  `json:"user_id"`
			ChatType string `json:"chat_type"`
		}
		if status != http.StatusOK || json.Unmarshal(body, &who) != nil || who.UserID != e.user.userID || who.ChatType != "private" {
			t.Fatalf("verify: %d %s", status, body)
		}
		tampered, err := url.ParseQuery(opened.Msg.GetInitData())
		if err != nil {
			t.Fatal(err)
		}
		tampered.Set("chat_type", "group")
		if status, body := e.verifyMiniApp(t, tampered.Encode()); status != http.StatusUnauthorized {
			t.Fatalf("verify tampered init data: %d %s", status, body)
		}
		if _, err := e.bots.SendMiniAppData(t.Context(), connect.NewRequest(&appv1.SendMiniAppDataRequest{
			BotId: botID, Data: "order-42", ButtonText: "Mở cửa hàng",
		})); err != nil {
			t.Fatal(err)
		}
		e.botMessage(t, chatID, botID, text("Đã nhận đơn: order-42"))
	},
}

func ptr[T any](v T) *T { return &v }

// verifyMiniApp posts init data to the miniapp example's backend, as a Mini
// App would, and returns the status and body.
func (e *conformanceEnv) verifyMiniApp(t *testing.T, initData string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, e.miniApp+"/verify", strings.NewReader(initData))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "text/plain")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, body
}

func TestSDKConformance(t *testing.T) {
	if os.Getenv("SDK_CONFORMANCE") == "" {
		t.Skip("set SDK_CONFORMANCE=1 (needs node, python3 and go)")
	}
	e := newConformanceEnv(t)
	for _, sdk := range conformanceSDKs(t) {
		t.Run(sdk.name, func(t *testing.T) {
			if sdk.prepare != nil {
				sdk.prepare(t, conformanceExamples)
			}
			for _, mode := range []string{"poll", "webhook"} {
				t.Run(mode, func(t *testing.T) {
					e := e.as(t, sdk.name+mode)
					for _, ex := range conformanceExamples {
						t.Run(ex, func(t *testing.T) {
							botID, token := e.newBot(t, fmt.Sprintf("%s_%s_%s_bot", sdk.name, mode, ex))
							e, env := e.forExample(t, ex)
							runBot(t, sdk, ex, mode, token, e.front, env)
							conformanceScenarios[ex](t, e, botID)
						})
					}
				})
			}
		})
	}
}
