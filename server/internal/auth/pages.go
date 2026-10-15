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
)

// The pages carry no script and no external resource. The interstitial
// exists because the session cookie is SameSite=Strict: it is set on the
// response to the IdP's redirect, which is cross-site when the IdP is on
// another site, and only a navigation started from this same-site page is
// sure to send it on the first app request.
var pages = template.Must(template.New("pages").Parse(`
{{define "interstitial"}}<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url={{.}}">
<title>Đang đăng nhập…</title>
</head>
<body>
<p>Đang đăng nhập… <a href="{{.}}">Tiếp tục</a></p>
</body>
</html>
{{end}}
{{define "error"}}<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Đăng nhập không thành công</title>
</head>
<body>
<h1>Đăng nhập không thành công</h1>
<p>{{.Message}}</p>
<p><a href="{{.RetryURL}}">Thử lại</a></p>
</body>
</html>
{{end}}`))

// writePageHeaders sets the headers of every HTML page of the auth routes.
// no-referrer keeps the callback URL (code, state) out of the Referer of the
// next navigation.
func writePageHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
}

// writeInterstitial sends the browser to returnTo, a path CleanReturnTo
// accepted ("" means "/").
func writeInterstitial(w http.ResponseWriter, returnTo string) {
	if returnTo == "" {
		returnTo = "/"
	}
	// Rendered first so the response carries a Content-Length: the browser
	// has the whole page even while the callback still revokes the session
	// it replaces.
	var page bytes.Buffer
	if err := pages.ExecuteTemplate(&page, "interstitial", returnTo); err != nil {
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

// Messages of the sign-in error page.
const (
	msgSignInFailed   = "Không hoàn tất được đăng nhập. Vui lòng thử lại."
	msgIdPUnavailable = "Máy chủ đăng nhập đang tạm thời không phản hồi. Vui lòng thử lại sau ít phút."
)

func writeErrorPage(w http.ResponseWriter, status int, message, locale, returnTo string) {
	retry := "/auth/login"
	q := url.Values{}
	if locale != "" {
		q.Set("locale", locale)
	}
	if returnTo != "" {
		q.Set("return_to", returnTo)
	}
	if len(q) > 0 {
		retry += "?" + q.Encode()
	}
	writePageHeaders(w)
	w.WriteHeader(status)
	_ = pages.ExecuteTemplate(w, "error", struct{ Message, RetryURL string }{message, retry})
}
