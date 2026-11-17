package telegram

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"app.local/server/internal/bridge"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tgerr"
)

// loginTTL is how long an open login keeps its connection to Telegram.
const loginTTL = 10 * time.Minute

// Steps of the login, in the Token handed back with each answer.
const (
	stepPhone    = "phone"
	stepCode     = "code"
	stepPassword = "password"
)

// login is a sign-in between two answers: the connection that asked
// Telegram to send the code has to be the one that checks it, so it stays
// open here, in this process, until the login ends.
type login struct {
	live  *live
	phone string
	hash  string
	timer *time.Timer
}

func (l *login) close() {
	if l.timer != nil {
		l.timer.Stop()
	}
	if l.live != nil {
		l.live.stop()
	}
}

// Login implements bridge.Adapter: phone number, then the code Telegram
// sends to the account's other devices, then the two-step password when the
// account has one. Nothing the user typed is stored or logged; only the
// session Telegram issues is returned, for the server to seal.
func (a *Adapter) Login(ctx context.Context, prior string, in map[string]string) (bridge.LoginStep, error) {
	if prior == "" {
		id, err := newLoginID()
		if err != nil {
			return bridge.LoginStep{}, err
		}
		return bridge.LoginStep{Kind: bridge.StepInput, Token: id + ":" + stepPhone,
			Fields: []bridge.Field{{Name: "phone", Label: "Phone number (with country code)", Secret: true}}}, nil
	}
	id, step, ok := strings.Cut(prior, ":")
	if !ok {
		return bridge.LoginStep{}, errors.New("telegram: bad login token")
	}
	switch step {
	case stepPhone:
		return a.sendCode(ctx, id, in["phone"])
	case stepCode:
		return a.checkCode(ctx, id, in["code"])
	case stepPassword:
		return a.checkPassword(ctx, id, in["password"])
	}
	return bridge.LoginStep{}, errors.New("telegram: bad login step")
}

func newLoginID() (string, error) {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("telegram: login id: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}

func (a *Adapter) takeLogin(id string) *login {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.logins[id]
}

func (a *Adapter) dropLogin(id string) {
	a.mu.Lock()
	l := a.logins[id]
	delete(a.logins, id)
	a.mu.Unlock()
	if l != nil {
		l.close()
	}
}

func (a *Adapter) sendCode(ctx context.Context, id, phone string) (bridge.LoginStep, error) {
	phone = strings.TrimSpace(phone)
	if !strings.HasPrefix(phone, "+") || len(phone) < 8 {
		return bridge.LoginStep{}, &bridge.InputError{Message: "invalid_phone: enter the number with the country code, like +84…"}
	}
	a.dropLogin(id) // a retry starts a fresh connection
	l := &login{live: a.startLive(nil, nil, false), phone: phone}
	if err := l.live.wait(ctx); err != nil {
		l.close()
		return bridge.LoginStep{}, err
	}
	sent, err := l.live.client.Auth().SendCode(ctx, phone, auth.SendCodeOptions{})
	if err != nil {
		l.close()
		return bridge.LoginStep{}, inputOrFail(err)
	}
	code, ok := sent.(interface{ GetPhoneCodeHash() string })
	if !ok {
		l.close()
		return bridge.LoginStep{}, errors.New("telegram: Telegram did not send a code")
	}
	l.hash = code.GetPhoneCodeHash()
	l.timer = time.AfterFunc(loginTTL, func() { a.dropLogin(id) })
	a.mu.Lock()
	a.logins[id] = l
	a.mu.Unlock()
	return bridge.LoginStep{Kind: bridge.StepInput, Token: id + ":" + stepCode,
		Prompt: "Telegram sent a code to your other devices (or by SMS).",
		Fields: []bridge.Field{{Name: "code", Label: "Login code", Secret: true}}}, nil
}

func (a *Adapter) checkCode(ctx context.Context, id, code string) (bridge.LoginStep, error) {
	l := a.takeLogin(id)
	if l == nil {
		return bridge.LoginStep{}, &bridge.InputError{Message: "login_expired: start the login again"}
	}
	_, err := l.live.client.Auth().SignIn(ctx, l.phone, strings.TrimSpace(code), l.hash)
	switch {
	case errors.Is(err, auth.ErrPasswordAuthNeeded):
		return bridge.LoginStep{Kind: bridge.StepInput, Token: id + ":" + stepPassword,
			Prompt: "This account has a two-step verification password.",
			Fields: []bridge.Field{{Name: "password", Label: "Two-step password", Secret: true}}}, nil
	case err != nil:
		if tgerr.Is(err, "PHONE_CODE_EXPIRED") {
			a.dropLogin(id)
		}
		return bridge.LoginStep{}, inputOrFail(err)
	}
	return a.finish(ctx, id, l)
}

func (a *Adapter) checkPassword(ctx context.Context, id, password string) (bridge.LoginStep, error) {
	l := a.takeLogin(id)
	if l == nil {
		return bridge.LoginStep{}, &bridge.InputError{Message: "login_expired: start the login again"}
	}
	if _, err := l.live.client.Auth().Password(ctx, password); err != nil {
		return bridge.LoginStep{}, inputOrFail(err)
	}
	return a.finish(ctx, id, l)
}

// finish ends a successful login: the session Telegram issued is handed to
// the server and the connection used for signing in is closed.
func (a *Adapter) finish(ctx context.Context, id string, l *login) (bridge.LoginStep, error) {
	defer a.dropLogin(id)
	self, err := l.live.client.Self(ctx)
	if err != nil {
		return bridge.LoginStep{}, translate(err)
	}
	data, err := l.live.storage.LoadSession(ctx)
	if err != nil || len(data) == 0 {
		return bridge.LoginStep{}, errors.New("telegram: no session after signing in")
	}
	return bridge.LoginStep{Kind: bridge.StepDone, Session: data, Account: strconv.FormatInt(self.ID, 10)}, nil
}

// inputErrors are the answers of Telegram that mean the user typed
// something wrong and may try again.
var inputErrors = map[string]string{
	"PHONE_NUMBER_INVALID":  "invalid_phone: Telegram does not accept this phone number",
	"PHONE_CODE_INVALID":    "wrong_code: that code is not right",
	"PHONE_CODE_EMPTY":      "wrong_code: enter the code",
	"PHONE_CODE_EXPIRED":    "code_expired: the code expired, start the login again",
	"PASSWORD_HASH_INVALID": "wrong_password: that password is not right",
	"PHONE_NUMBER_BANNED":   "phone_banned: Telegram refuses this number",
	"PHONE_NUMBER_FLOOD":    "too_many_attempts: Telegram says too many attempts, try later",
	"SEND_CODE_UNAVAILABLE": "too_many_attempts: Telegram cannot send another code now, try later",
}

// inputOrFail makes a wrong answer an InputError (the step stays open) and
// leaves every other failure as it is.
func inputOrFail(err error) error {
	if rpc, ok := tgerr.As(err); ok {
		if msg, known := inputErrors[rpc.Type]; known {
			return &bridge.InputError{Message: msg}
		}
	}
	return translate(err)
}
