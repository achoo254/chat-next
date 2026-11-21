package zalo

import (
	"context"
	"strings"
	"testing"
)

// Nothing the sidecar says about a person or a session reaches the log: not
// message text, names, ids, cookies, the imei, nor what stderr carries besides
// a host name.
func TestNoSidecarContentReachesTheLog(t *testing.T) {
	secrets := []string{"bí mật riêng", "Nguyễn Văn Bí", "5550001", "8880002", "secret-cookie", "imei-1", "10.9.8.7", "evil-text"}
	lines := []string{
		`{"ev":"listener","state":"connected"}`,
		`{"ev":"message","thread":"user","self":false,"msgType":"webchat","content":"bí mật riêng","msgId":"8880002","uidFrom":"5550001","idTo":"0","dName":"Nguyễn Văn Bí","ts":"1763700000000"}`,
		`{"ev":"message","thread":"group","self":false,"msgType":"webchat","content":"bí mật riêng","msgId":"8880003","uidFrom":"5550001","idTo":"77","dName":"Nguyễn Văn Bí"}`,
		`{"ev":"message","thread":"user","msgType":"webchat","content":"bí mật riêng","uidFrom":"5550001"}`,
		`{"ev":"event","name":"reaction","payload":{"text":"bí mật riêng","uid":"5550001"}}`,
		`{"ev":"error","code":"listener_error","message":"secret-cookie imei-1"}`,
		`{"ev":"bí mật riêng"}`,
		`bí mật riêng secret-cookie`,
		`{"ev":"listener","state":"closed","code":1000}`,
	}
	r := &fakeRunner{script: func(p *fakeProcess) {
		p.stderr("host chat.zalo.me")
		p.stderr("blocked 10.9.8.7")
		p.stderr("evil-text imei-1")
		p.stderr("host evil-text bí mật riêng")
		scriptedSession(t, lines, false)(p)
	}}
	a, h := newTestAdapter(t, r)
	if _, err := runSubscribe(t, a, testAccount); err == nil {
		t.Fatal("subscription ended without an error")
	}
	r.started[0].waitStdinClosed(t)
	// stderr is read on its own goroutine: wait for its lines to be handled.
	<-r.started[0].exited
	_ = a.Logout(context.Background(), testAccount)
	logged := strings.Join(h.all(), "\n")
	for _, s := range secrets {
		if strings.Contains(logged, s) {
			t.Errorf("log contains %q:\n%s", s, logged)
		}
	}
	if !strings.Contains(logged, "host=chat.zalo.me") {
		t.Errorf("the host name for the firewall is missing:\n%s", logged)
	}
	if !strings.Contains(logged, "blocked") {
		t.Errorf("the blocked connection is not reported:\n%s", logged)
	}
}
