package auth

import (
	"html/template"
	"net/http"
	"net/url"
)

// The pages carry no script and no external resource. The interstitial
// exists because the session cookie is SameSite=Strict: it is set on the
// response to the IdP's cross-site redirect, and only a navigation started
// from this same-site page sends it on the first app request.
var pages = template.Must(template.New("pages").Parse(`
{{define "interstitial"}}<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=/">
<title>Đang đăng nhập…</title>
</head>
<body>
<p>Đang đăng nhập… <a href="/">Tiếp tục</a></p>
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

func writeInterstitial(w http.ResponseWriter) {
	writePageHeaders(w)
	w.WriteHeader(http.StatusOK)
	_ = pages.ExecuteTemplate(w, "interstitial", nil)
}

// Messages of the sign-in error page.
const (
	msgSignInFailed   = "Không hoàn tất được đăng nhập. Vui lòng thử lại."
	msgIdPUnavailable = "Máy chủ đăng nhập đang tạm thời không phản hồi. Vui lòng thử lại sau ít phút."
)

func writeErrorPage(w http.ResponseWriter, status int, message, locale string) {
	retry := "/auth/login"
	if locale != "" {
		retry += "?" + url.Values{"locale": {locale}}.Encode()
	}
	writePageHeaders(w)
	w.WriteHeader(status)
	_ = pages.ExecuteTemplate(w, "error", struct{ Message, RetryURL string }{message, retry})
}
