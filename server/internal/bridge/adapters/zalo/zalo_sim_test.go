package zalo

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

// zaloSim plays the sidecar and Zalo behind it for sending: it keeps the
// messages Zalo holds, answers send and history with latency, echoes the
// owner's messages on the listener, and can lose answers, lose requests or
// drop the listener.
type zaloSim struct {
	t       *testing.T
	latency time.Duration

	mu          sync.Mutex
	messages    []simMessage // what Zalo holds, oldest first
	nextID      int
	sendTimes   []time.Time // when each send command arrived
	histories   int
	dropAnswers int    // the next sends create the message but are not answered
	loseSends   int    // the next sends create nothing and are not answered
	failNext    string // the next send is answered with this send_error code
	listenerOff bool   // no echo; history answers listener_down
	pageSize    int    // messages in a history page (all chats)
}

type simMessage struct {
	id   string
	peer string
	self bool
	text string
	at   time.Time
}

const simOwner = "999"

func newZaloSim(t *testing.T) *zaloSim {
	return &zaloSim{t: t, latency: 10 * time.Millisecond, nextID: 5000, pageSize: 50}
}

// seed puts a message into Zalo before the test starts.
func (z *zaloSim) seed(peer string, self bool, text string, at time.Time) {
	z.mu.Lock()
	defer z.mu.Unlock()
	z.nextID++
	z.messages = append(z.messages, simMessage{id: fmt.Sprint(z.nextID), peer: peer, self: self, text: text, at: at})
}

// created counts the owner's messages Zalo holds with text.
func (z *zaloSim) created(text string) int {
	z.mu.Lock()
	defer z.mu.Unlock()
	n := 0
	for _, m := range z.messages {
		if m.self && m.text == text {
			n++
		}
	}
	return n
}

func (z *zaloSim) sends() int {
	z.mu.Lock()
	defer z.mu.Unlock()
	return len(z.sendTimes)
}

func (z *zaloSim) historyReads() int {
	z.mu.Lock()
	defer z.mu.Unlock()
	return z.histories
}

func (z *zaloSim) set(f func(z *zaloSim)) {
	z.mu.Lock()
	defer z.mu.Unlock()
	f(z)
}

// script is the fakeRunner script: login, a first message from peer 500 (so
// the account talks with 500), then commands until stdin closes.
func (z *zaloSim) script(p *fakeProcess) {
	p.emit(readyLine)
	select {
	case <-p.commands: // login_session
	case <-p.stdinClosed:
		return
	}
	p.emit(accountLine)
	p.emit(connectedLine)
	p.emit(`{"ev":"message","thread":"user","self":false,"msgType":"webchat","content":"chào","msgId":"4000","uidFrom":"500","idTo":"0","dName":"Lan","ts":"1763700000000"}`)
	for {
		var line string
		select {
		case line = <-p.commands:
		case <-p.stdinClosed:
			return
		}
		var c command
		if err := json.Unmarshal([]byte(line), &c); err != nil {
			z.t.Errorf("sidecar got a bad command line")
			return
		}
		time.Sleep(z.latency)
		switch c.Cmd {
		case cmdSend:
			z.send(p, c)
		case cmdHistory:
			z.history(p, c)
		}
	}
}

func (z *zaloSim) send(p *fakeProcess, c command) {
	z.mu.Lock()
	z.sendTimes = append(z.sendTimes, time.Now())
	if z.failNext != "" {
		code := z.failNext
		z.failNext = ""
		z.mu.Unlock()
		p.emit(fmt.Sprintf(`{"ev":"send_error","id":%q,"code":%q,"zaloCode":114}`, c.ID, code))
		return
	}
	if z.loseSends > 0 {
		z.loseSends--
		z.mu.Unlock()
		return
	}
	z.nextID++
	m := simMessage{id: fmt.Sprint(z.nextID), peer: c.To, self: true, text: c.Text, at: time.Now()}
	z.messages = append(z.messages, m)
	answer := z.dropAnswers == 0
	if !answer {
		z.dropAnswers--
	}
	echo := !z.listenerOff
	z.mu.Unlock()
	if echo { // the listener's echo often comes before the HTTP answer
		content, _ := json.Marshal(m.text)
		p.emit(fmt.Sprintf(`{"ev":"message","thread":"user","self":true,"msgType":"webchat","content":%s,"msgId":%q,"uidFrom":%q,"idTo":%q,"ts":%d}`,
			content, m.id, simOwner, m.peer, m.at.UnixMilli()))
	}
	if answer {
		p.emit(fmt.Sprintf(`{"ev":"sent","id":%q,"msgId":%q,"ts":%d}`, c.ID, m.id, m.at.UnixMilli()))
	}
}

func (z *zaloSim) history(p *fakeProcess, c command) {
	z.mu.Lock()
	z.histories++
	if z.listenerOff {
		z.mu.Unlock()
		p.emit(fmt.Sprintf(`{"ev":"history_error","id":%q,"code":"listener_down"}`, c.ID))
		return
	}
	page := z.messages[max(0, len(z.messages)-z.pageSize):]
	type out struct {
		Self     bool   `json:"self"`
		MsgType  string `json:"msgType"`
		TextHash string `json:"textHash"`
		MsgID    string `json:"msgId"`
		TS       int64  `json:"ts"`
	}
	var oldest int64
	var mine []out
	for _, m := range page {
		if oldest == 0 || m.at.UnixMilli() < oldest {
			oldest = m.at.UnixMilli()
		}
		if m.peer == c.Peer {
			h := hashText(m.text)
			mine = append(mine, out{Self: m.self, MsgType: msgTypeText, TextHash: hex.EncodeToString(h[:]), MsgID: m.id, TS: m.at.UnixMilli()})
		}
	}
	z.mu.Unlock()
	body, _ := json.Marshal(map[string]any{"ev": evHistory, "id": c.ID, "count": len(page), "oldestTs": oldest, "messages": mine})
	p.emit(string(body))
}

// simAccount runs Subscribe for testAccount against the simulation until the
// test ends and returns once the account talks with peer 500. The engine's
// side of the event channel is read by drain unless hold is set: then nothing
// reads it, as when the engine is busy sending.
func simAccount(t *testing.T, z *zaloSim, hold bool) (*Adapter, *recordingHandler, *fakeRunner) {
	t.Helper()
	r := &fakeRunner{script: z.script}
	a, h := newTestAdapter(t, r)
	a.timing.sendGap = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	out := make(chan bridge.Event)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = a.Subscribe(ctx, testAccount, out)
	}()
	if hold {
		// The first message is read so the account knows peer 500; later ones wait.
		<-out
	} else {
		go func() {
			for {
				select {
				case <-out:
				case <-done:
					return
				}
			}
		}()
	}
	t.Cleanup(func() {
		cancel()
		<-done
	})
	eventually(t, "the account hears peer 500", func() bool { return a.heardFor(testAccount.ID).knows("500") })
	return a, h, r
}
