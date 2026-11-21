package zalo

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"app.local/server/internal/bridge"
)

// qrLine is a qr event whose image is a (tiny) PNG.
func qrLine(tag string) string {
	img := base64.StdEncoding.EncodeToString(append(append([]byte(nil), pngMagic...), tag...))
	return `{"ev":"qr","image":"` + img + `"}`
}

const loggedInLine = `{"ev":"logged_in","session":{"cookie":[{"key":"zpw_sek","value":"secret-cookie"}],"imei":"imei-1","userAgent":"UA","extra":"dropped"}}`

// scriptedQR plays a sidecar that answers login_qr (without the listener)
// with a QR code, then writes whatever the test sends on lines.
func scriptedQR(t *testing.T, lines <-chan string) func(p *fakeProcess) {
	return func(p *fakeProcess) {
		p.emit(readyLine)
		if c := p.command(t); c != `{"cmd":"login_qr","listen":false}` {
			if c != "" {
				t.Errorf("command = %s, want login_qr without the listener", c)
			}
			return
		}
		p.emit(qrLine("first"))
		for {
			select {
			case l := <-lines:
				p.emit(l)
			case <-p.exited:
				return
			}
		}
	}
}

func asOwner(owner int64) context.Context {
	return bridge.WithLoginOwner(context.Background(), owner)
}

func TestLoginQRScannedThenDone(t *testing.T) {
	lines := make(chan string, 4)
	r := &fakeRunner{script: scriptedQR(t, lines)}
	a, _ := newTestAdapter(t, r)
	ctx := asOwner(1)

	step, err := a.Login(ctx, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if step.Kind != bridge.StepQR || !strings.HasPrefix(step.Prompt, "data:image/png;base64,") || step.Token == "" {
		t.Fatalf("first step = %+v", step)
	}
	// Nothing new: the same QR comes back after the poll.
	again, err := a.Login(ctx, step.Token, nil)
	if err != nil || again.Kind != bridge.StepQR || again.Prompt != step.Prompt {
		t.Fatalf("idle poll = %+v, %v", again, err)
	}
	lines <- `{"ev":"qr_scanned"}`
	confirm, err := a.Login(ctx, step.Token, nil)
	if err != nil || confirm.Kind != bridge.StepConfirm {
		t.Fatalf("after scan = %+v, %v", confirm, err)
	}
	lines <- loggedInLine
	lines <- `{"ev":"account","uid":"123456789"}`
	var done bridge.LoginStep
	eventually(t, "login done", func() bool {
		done, err = a.Login(ctx, step.Token, nil)
		return err != nil || done.Kind == bridge.StepDone
	})
	if err != nil || done.Account != "123456789" {
		t.Fatalf("done = %+v, %v", done, err)
	}
	want := `{"cookie":[{"key":"zpw_sek","value":"secret-cookie"}],"imei":"imei-1","userAgent":"UA","uid":"123456789"}`
	if string(done.Session) != want {
		t.Errorf("session = %s, want %s", done.Session, want)
	}
	r.process(t, 0).waitStdinClosed(t)
	if _, err := a.Login(ctx, step.Token, nil); !isInputError(err) {
		t.Errorf("login used after done: err = %v, want an input error", err)
	}
}

func TestLoginStartAnswersAtOnceWhileZaloIsSlow(t *testing.T) {
	r := &fakeRunner{script: func(p *fakeProcess) { p.emit(readyLine); p.command(t) }} // never a QR code
	a, _ := newTestAdapter(t, r)
	a.timing.loginStartWait = 100 * time.Millisecond
	a.timing.firstQR = time.Minute
	began := time.Now()
	step, err := a.Login(asOwner(1), "", nil)
	if err != nil || step.Kind != bridge.StepQR || step.Prompt != "" {
		t.Fatalf("step = %+v, %v; want StepQR with no image yet", step, err)
	}
	if took := time.Since(began); took > time.Second {
		t.Errorf("the first call took %v", took)
	}
}

func TestLoginQRExpiredGetsANewCodeThenGivesUp(t *testing.T) {
	lines := make(chan string, 8)
	r := &fakeRunner{script: scriptedQR(t, lines)}
	a, _ := newTestAdapter(t, r)
	ctx := asOwner(1)
	step, err := a.Login(ctx, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= maxQRRefresh; i++ {
		lines <- `{"ev":"qr_expired"}`
		eventually(t, "a fresh sidecar", func() bool { return r.starts() == i+1 })
		r.process(t, i-1).waitExited(t) // so only the new sidecar reads lines
	}
	lines <- `{"ev":"qr_expired"}`
	eventually(t, "the login to give up", func() bool {
		_, err = a.Login(ctx, step.Token, nil)
		return err != nil
	})
	if !isInputError(err) || !strings.HasPrefix(err.Error(), "qr_expired") {
		t.Fatalf("err = %v, want qr_expired", err)
	}
}

func TestLoginQRDeclinedEndsTheLogin(t *testing.T) {
	lines := make(chan string, 4)
	r := &fakeRunner{script: scriptedQR(t, lines)}
	a, _ := newTestAdapter(t, r)
	ctx := asOwner(1)
	step, err := a.Login(ctx, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	lines <- `{"ev":"qr_declined"}`
	_, err = a.Login(ctx, step.Token, nil)
	if !isInputError(err) || !strings.HasPrefix(err.Error(), "qr_declined") {
		t.Fatalf("declined: err = %v", err)
	}
	r.process(t, 0).waitStdinClosed(t)
}

func TestLoginRefusesABadAccountID(t *testing.T) {
	for name, tail := range map[string][]string{
		"undefined":              {loggedInLine, `{"ev":"account","uid":"undefined"}`},
		"null":                   {loggedInLine, `{"ev":"account","uid":null}`},
		"too long":               {loggedInLine, `{"ev":"account","uid":"123456789012345678901"}`},
		"account before session": {`{"ev":"account","uid":"123"}`},
	} {
		t.Run(name, func(t *testing.T) {
			lines := make(chan string, 4)
			r := &fakeRunner{script: scriptedQR(t, lines)}
			a, _ := newTestAdapter(t, r)
			step, err := a.Login(asOwner(1), "", nil)
			if err != nil {
				t.Fatal(err)
			}
			for _, l := range tail {
				lines <- l
			}
			eventually(t, "the login to fail", func() bool {
				_, err = a.Login(asOwner(1), step.Token, nil)
				return err != nil
			})
			if isInputError(err) || strings.Contains(err.Error(), "login_expired") {
				t.Fatalf("err = %v, want a failed login", err)
			}
		})
	}
}

func TestLoginCancelledByTheClientStopsTheSidecar(t *testing.T) {
	lines := make(chan string)
	r := &fakeRunner{script: scriptedQR(t, lines)}
	a, _ := newTestAdapter(t, r)
	a.timing.loginPoll = time.Minute
	step, err := a.Login(asOwner(1), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(asOwner(1))
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	if _, err := a.Login(ctx, step.Token, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	r.process(t, 0).waitStdinClosed(t)
	if _, err := a.Login(asOwner(1), step.Token, nil); !isInputError(err) {
		t.Errorf("a cancelled login lives on: %v", err)
	}
}

func TestLoginNobodyPollsIsStopped(t *testing.T) {
	r := &fakeRunner{script: scriptedQR(t, make(chan string))}
	a, _ := newTestAdapter(t, r)
	a.timing.loginIdle = 100 * time.Millisecond
	if _, err := a.Login(asOwner(1), "", nil); err != nil {
		t.Fatal(err)
	}
	r.process(t, 0).waitStdinClosed(t)
}

func TestLoginFailsWhenTheSidecarErrsBeforeAQRCode(t *testing.T) {
	r := &fakeRunner{script: func(p *fakeProcess) {
		p.emit(readyLine)
		p.command(t)
		p.emit(`{"ev":"error","code":"network_error","message":"TypeError"}`)
	}}
	a, _ := newTestAdapter(t, r)
	_, err := a.Login(asOwner(1), "", nil)
	if err == nil || isInputError(err) || !strings.Contains(err.Error(), "network_error") {
		t.Fatalf("err = %v, want a failure of the call", err)
	}
}

func TestLoginRefusesAnotherProtocol(t *testing.T) {
	r := &fakeRunner{script: func(p *fakeProcess) { p.emit(`{"ev":"ready","protocol":2}`) }}
	a, _ := newTestAdapter(t, r)
	_, err := a.Login(asOwner(1), "", nil)
	if err == nil || !strings.Contains(err.Error(), "protocol 2") {
		t.Fatalf("err = %v, want a protocol mismatch", err)
	}
}

func TestQRDataURLRejectsWhatIsNotAPNG(t *testing.T) {
	if _, err := qrDataURL(base64.StdEncoding.EncodeToString([]byte("GIF89a"))); err == nil {
		t.Error("a GIF was taken as the QR image")
	}
	if _, err := qrDataURL("%%%"); err == nil {
		t.Error("bad base64 was taken as the QR image")
	}
	if _, err := qrDataURL(""); err == nil {
		t.Error("an empty image was taken")
	}
}

func isInputError(err error) bool {
	var in *bridge.InputError
	return errors.As(err, &in)
}
