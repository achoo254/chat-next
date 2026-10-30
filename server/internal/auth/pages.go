package auth

import (
	"bytes"
	"html/template"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"app.local/server/internal/locale"
)

// The pages carry no script; their only resources are the web app's
// favicon files on this same host (img-src 'self'). The interstitial
// exists because the session cookie is SameSite=Strict: it is set on the
// response to the IdP's redirect, which is cross-site when the IdP is on
// another site, and only a navigation started from this same-site page is
// sure to send it on the first app request.
var pages = template.Must(template.New("pages").Parse(`
{{define "icons"}}<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">{{end}}
{{define "interstitial"}}<!doctype html>
<html lang="{{.Text.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url={{.URL}}">
<title>{{.Text.SigningIn}}</title>
{{template "icons"}}
</head>
<body>
<p>{{.Text.SigningIn}} <a href="{{.URL}}">{{.Text.Continue}}</a></p>
</body>
</html>
{{end}}
{{define "error"}}<!doctype html>
<html lang="{{.Text.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Text.Failed}}</title>
{{template "icons"}}
</head>
<body>
<h1>{{.Text.Failed}}</h1>
<p>{{.Message}}</p>
<p><a href="{{.RetryURL}}">{{.Text.Retry}}</a></p>
</body>
</html>
{{end}}`))

// pageMessage is the reason an error page gives.
type pageMessage int

// Messages of the sign-in error page.
const (
	msgSignInFailed pageMessage = iota
	msgIdPUnavailable
	msgSignupLimited
)

// pageText is the text of the pages in one language.
type pageText struct {
	Lang, SigningIn, Continue, Failed, Retry string
	messages                                 [3]string // by pageMessage
}

// pageTexts holds the pages' text by locale (the ?locale= the sign-in
// started with); any other value gets Vietnamese.
var pageTexts = map[string]pageText{
	locale.VI: {
		Lang: locale.VI, SigningIn: "Đang đăng nhập…", Continue: "Tiếp tục", Failed: "Đăng nhập không thành công", Retry: "Thử lại",
		messages: [3]string{
			msgSignInFailed:   "Không hoàn tất được đăng nhập. Vui lòng thử lại.",
			msgIdPUnavailable: "Máy chủ đăng nhập đang tạm thời không phản hồi. Vui lòng thử lại sau ít phút.",
			msgSignupLimited:  "Vừa có quá nhiều tài khoản mới được tạo từ mạng của bạn. Vui lòng thử lại sau ít phút.",
		},
	},
	locale.EN: {
		Lang: locale.EN, SigningIn: "Signing in…", Continue: "Continue", Failed: "Sign-in failed", Retry: "Try again",
		messages: [3]string{
			msgSignInFailed:   "Sign-in could not be completed. Please try again.",
			msgIdPUnavailable: "The sign-in server is not responding right now. Please try again in a few minutes.",
			msgSignupLimited:  "Too many new accounts were just created from your network. Please try again in a few minutes.",
		},
	},
	locale.ZhCN: {
		Lang: locale.ZhCN, SigningIn: "正在登录…", Continue: "继续", Failed: "登录失败", Retry: "重试",
		messages: [3]string{
			msgSignInFailed:   "未能完成登录，请重试。",
			msgIdPUnavailable: "登录服务器暂时没有响应，请过几分钟再试。",
			msgSignupLimited:  "你所在的网络刚刚创建了过多新账号，请过几分钟再试。",
		},
	},
}

// textOf is the pages' text in lang, Vietnamese when lang is not one of them.
func textOf(lang string) pageText {
	if t, ok := pageTexts[lang]; ok {
		return t
	}
	return pageTexts[locale.Default]
}

// writePageHeaders sets the headers of every HTML page of the auth routes.
// no-referrer keeps the callback URL (code, state) out of the Referer of the
// next navigation.
func writePageHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Security-Policy", "default-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
}

// writeInterstitial sends the browser to returnTo, a path CleanReturnTo
// accepted ("" means "/"), with its text in lang.
func writeInterstitial(w http.ResponseWriter, lang, returnTo string) {
	if returnTo == "" {
		returnTo = "/"
	}
	// Rendered first so the response carries a Content-Length: the browser
	// has the whole page even while the callback still revokes the session
	// it replaces.
	var page bytes.Buffer
	if err := pages.ExecuteTemplate(&page, "interstitial", struct {
		Text pageText
		URL  string
	}{textOf(lang), returnTo}); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writePageHeaders(w)
	w.Header().Set("Content-Length", strconv.Itoa(page.Len()))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(page.Bytes())
}

// returnToMax bounds the return_to path, in bytes.
const returnToMax = 512

// CleanReturnTo returns raw when it is safe to send the browser to after
// sign-in, else "". Only a path on this origin passes: it starts with a
// single "/" (never "//", which browsers read as another host), has no
// backslash (browsers turn it into "/"), no control or space character
// (browsers drop tabs and newlines inside URLs), parses with no scheme or
// host, does not point back into /auth/, and is at most returnToMax bytes.
func CleanReturnTo(raw string) string {
	if raw == "" || len(raw) > returnToMax || raw[0] != '/' || strings.HasPrefix(raw, "//") ||
		strings.ContainsAny(raw, "\\ ") {
		return ""
	}
	for _, r := range raw {
		if r < 0x20 || r == 0x7f || r == utf8.RuneError || unicode.IsSpace(r) {
			return ""
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil || u.Opaque != "" || !strings.HasPrefix(u.Path, "/") {
		return ""
	}
	if p := strings.ToLower(u.Path); p == "/auth" || strings.HasPrefix(p, "/auth/") {
		return ""
	}
	return raw
}

// writeErrorPage tells why sign-in failed, in lang, with a link that starts
// it again in the same language and toward the same returnTo.
func writeErrorPage(w http.ResponseWriter, status int, message pageMessage, lang, returnTo string) {
	retry := "/auth/login"
	q := url.Values{}
	if lang != "" {
		q.Set("locale", lang)
	}
	if returnTo != "" {
		q.Set("return_to", returnTo)
	}
	if len(q) > 0 {
		retry += "?" + q.Encode()
	}
	writePageHeaders(w)
	w.WriteHeader(status)
	text := textOf(lang)
	_ = pages.ExecuteTemplate(w, "error", struct {
		Text              pageText
		Message, RetryURL string
	}{text, text.messages[message], retry})
}
