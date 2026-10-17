package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"connectrpc.com/connect"
	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
)

// cookieTransport keeps one person's cookies for the api host by hand: the
// session cookie is Secure (__Host-), which net/http's jar would not send
// over plain http to a local server.
type cookieTransport struct {
	host string
	next http.RoundTripper

	mu      sync.Mutex
	cookies map[string]string
}

func (c *cookieTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host == c.host {
		r = r.Clone(r.Context())
		c.mu.Lock()
		for name, value := range c.cookies {
			r.AddCookie(&http.Cookie{Name: name, Value: value})
		}
		c.mu.Unlock()
	}
	resp, err := c.next.RoundTrip(r)
	if err != nil || r.URL.Host != c.host {
		return resp, err
	}
	c.mu.Lock()
	for _, ck := range resp.Cookies() {
		if ck.MaxAge < 0 {
			delete(c.cookies, ck.Name)
		} else {
			c.cookies[ck.Name] = ck.Value
		}
	}
	c.mu.Unlock()
	return resp, nil
}

func (c *cookieTransport) header() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var parts []string
	for name, value := range c.cookies {
		parts = append(parts, name+"="+value)
	}
	return strings.Join(parts, "; ")
}

// person is one fake user: signed in, with RPC clients and a socket.
type person struct {
	index    int
	userID   int64
	http     *http.Client
	cookies  *cookieTransport
	chats    appv1connect.ChatsServiceClient
	messages appv1connect.MessagesServiceClient
	search   appv1connect.SearchServiceClient
	ws       *websocket.Conn
	// sent counts the person's messages: their random_id stays unique.
	sent atomic.Int64
}

// signIn runs the OIDC sign-in of account i against the fake IdP (which
// picks the account named in the authorize request).
func signIn(ctx context.Context, apiURL string, transport http.RoundTripper, i int) (*person, error) {
	u, err := url.Parse(apiURL)
	if err != nil {
		return nil, err
	}
	ct := &cookieTransport{host: u.Host, next: transport, cookies: map[string]string{}}
	client := &http.Client{
		Transport: ct,
		Timeout:   30 * time.Second,
		CheckRedirect: func(r *http.Request, _ []*http.Request) error {
			if r.URL.Path == "/authorize" {
				q := r.URL.Query()
				q.Set("account", accountSub(i))
				r.URL.RawQuery = q.Encode()
			}
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL+"/auth/login?locale=vi", nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("sign in %d: %w", i, err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(ct.header(), "chat_session") {
		return nil, fmt.Errorf("sign in %d: status %d without a session", i, resp.StatusCode)
	}
	origin := connect.WithInterceptors(originInterceptor(apiURL))
	base := apiURL + "/rpc"
	p := &person{
		index: i, http: client, cookies: ct,
		chats:    appv1connect.NewChatsServiceClient(client, base, origin),
		messages: appv1connect.NewMessagesServiceClient(client, base, origin),
		search:   appv1connect.NewSearchServiceClient(client, base, origin),
	}
	self, err := appv1connect.NewUsersServiceClient(client, base, origin).GetSelf(ctx, connect.NewRequest(&appv1.GetSelfRequest{}))
	if err != nil {
		return nil, fmt.Errorf("get self %d: %w", i, err)
	}
	p.userID = self.Msg.GetUser().GetId()
	return p, nil
}

// originInterceptor sets Origin like the web app's same-origin requests.
func originInterceptor(origin string) connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			req.Header().Set("Origin", origin)
			return next(ctx, req)
		}
	}
}

// connectSocket opens the realtime socket and passes every frame to onFrame
// until ctx ends; it keeps the socket alive with pings.
func (p *person) connectSocket(ctx context.Context, apiURL string, onFrame func(*appv1.ServerFrame)) error {
	u, _ := url.Parse(apiURL)
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	header := http.Header{}
	header.Set("Origin", apiURL)
	header.Set("Cookie", p.cookies.header())
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(dialCtx, scheme+"://"+u.Host+"/ws", &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return fmt.Errorf("socket %d: %w", p.index, err)
	}
	ws.SetReadLimit(4 << 20)
	p.ws = ws
	if err := p.write(ctx, &appv1.ClientFrame{Frame: &appv1.ClientFrame_Hello{Hello: &appv1.ClientHelloFrame{
		Platform: appv1.ClientPlatform_CLIENT_PLATFORM_WEB, AppVersion: "loadgen",
	}}}); err != nil {
		return err
	}
	// Updates committed between the gateway's registration and Hello may
	// come first (by design: GetDifference covers the rest); skip them.
	var hello appv1.ServerFrame
	for hello.GetHello() == nil {
		_, data, err := ws.Read(dialCtx)
		if err != nil {
			return fmt.Errorf("hello %d: %w", p.index, err)
		}
		hello.Reset()
		if err := proto.Unmarshal(data, &hello); err != nil {
			return fmt.Errorf("hello %d: %w", p.index, err)
		}
		if e := hello.GetError(); e != nil {
			return fmt.Errorf("hello %d: %v %s", p.index, e.GetCode(), e.GetMessage())
		}
	}
	interval := time.Duration(hello.GetHello().GetHeartbeatIntervalMs()) * time.Millisecond
	if interval <= 0 {
		interval = 25 * time.Second
	}
	go func() {
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var f appv1.ServerFrame
			if proto.Unmarshal(data, &f) == nil {
				onFrame(&f)
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = ws.Close(websocket.StatusNormalClosure, "")
				return
			case <-ticker.C:
				_ = p.write(ctx, &appv1.ClientFrame{Frame: &appv1.ClientFrame_Ping{Ping: &appv1.PingFrame{}}})
			}
		}
	}()
	return nil
}

func (p *person) write(ctx context.Context, f *appv1.ClientFrame) error {
	b, err := proto.Marshal(f)
	if err != nil {
		return err
	}
	return p.ws.Write(ctx, websocket.MessageBinary, b)
}

// stamp is the text of a load message: who sent it and when (unix
// nanoseconds), so receivers measure delivery on this machine's clock.
func stamp(sender int, at time.Time) string {
	return "load " + strconv.Itoa(sender) + " " + strconv.FormatInt(at.UnixNano(), 10)
}

func parseStamp(text string) (time.Time, bool) {
	parts := strings.Fields(text)
	if len(parts) != 3 || parts[0] != "load" {
		return time.Time{}, false
	}
	ns, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.Unix(0, ns), true
}
