package zalo

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"app.local/server/internal/bridge"
)

// qrLine is a qr event whose image is a (tiny) PNG.
func qrLine(tag string) string {
	img := base64.StdEncoding.EncodeToString(append(append([]byte(nil), pngMagic...), tag...))
	return `{"ev":"qr","image":"` + img + `"}`
}

const loggedInLine = `{"ev":"logged_in","session":{"cookie":[{"key":"zpw_sek","value":"secret-cookie"}],"imei":"imei-1","userAgent":"UA","extra":"dropped"}}`

// scriptedQR plays a sidecar that answers login_qr with a QR code, then
// writes whatever the test sends on lines.
func scriptedQR(t *testing.T, lines <-chan string) func(p *fakeProcess) {
	return func(p *fakeProcess) {
		p.emit(readyLine)
		if c := p.command(t); c != `{"cmd":"login_qr"}` {
			t.Errorf("command = %s, want login_qr", c)
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

func TestLoginQRScannedThenDone(t *testing.T) {
	lines := make(chan string, 4)
	r := &fakeRunner{script: scriptedQR(t, lines)}
	a, _ := newTestAdapter(t, r)
	ctx := context.Background()

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
	done, err := a.Login(ctx, step.Token, nil)
	if err != nil || done.Kind != bridge.StepDone {
		t.Fatalf("after confirm = %+v, %v", done, err)
	}
	if done.Account != "123456789" {
		t.Errorf("account = %q", done.Account)
	}
	want := `{"cookie":[{"key":"zpw_sek","value":"secret-cookie"}],"imei":"imei-1","userAgent":"UA"}`
	if string(done.Session) != want {
		t.Errorf("session = %s, want %s", done.Session, want)
	}
	r.started[0].waitStdinClosed(t)
	if _, err := a.Login(ctx, step.Token, nil); !isInputError(err) {
		t.Errorf("login used after done: err = %v, want an input error", err)
	}
}

func TestLoginQRExpiredGetsANewCode(t *testing.T) {
	lines := make(chan string, 4)
	r := &fakeRunner{script: scriptedQR(t, lines)}
	a, _ := newTestAdapter(t, r)
	ctx := context.Background()
	step, err := a.Login(ctx, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	lines <- `{"ev":"qr_expired"}`
	next, err := a.Login(ctx, step.Token, nil)
	if err != nil || next.Kind != bridge.StepQR {
		t.Fatalf("after expiry = %+v, %v", next, err)
	}
	if r.starts() != 2 {
		t.Errorf("sidecars started = %d, want 2 (a fresh one for the new code)", r.starts())
	}
	r.started[0].waitStdinClosed(t)
}

func TestLoginQRDeclinedEndsTheLogin(t *testing.T) {
	lines := make(chan string, 4)
	r := &fakeRunner{script: scriptedQR(t, lines)}
	a, _ := newTestAdapter(t, r)
	ctx := context.Background()
	step, err := a.Login(ctx, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	lines <- `{"ev":"qr_declined"}`
	_, err = a.Login(ctx, step.Token, nil)
	if !isInputError(err) || !strings.HasPrefix(err.Error(), "qr_declined") {
		t.Fatalf("declined: err = %v", err)
	}
	r.started[0].waitStdinClosed(t)
}

func TestLoginFailsWhenTheSidecarErrsBeforeAQRCode(t *testing.T) {
	r := &fakeRunner{script: func(p *fakeProcess) {
		p.emit(readyLine)
		p.command(t)
		p.emit(`{"ev":"error","code":"command_failed","message":"TypeError"}`)
	}}
	a, _ := newTestAdapter(t, r)
	_, err := a.Login(context.Background(), "", nil)
	if err == nil || isInputError(err) {
		t.Fatalf("err = %v, want a failure of the call", err)
	}
}

func TestLoginRefusesAnotherProtocol(t *testing.T) {
	r := &fakeRunner{script: func(p *fakeProcess) { p.emit(`{"ev":"ready","protocol":1}`) }}
	a, _ := newTestAdapter(t, r)
	_, err := a.Login(context.Background(), "", nil)
	if err == nil || !strings.Contains(err.Error(), "protocol 1") {
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
