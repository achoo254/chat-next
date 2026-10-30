// Package locale names the languages the server writes user-facing text
// in: the UI languages of the web app (apps/web/src/i18n).
package locale

// The languages, as the web app and the shared hd_lang cookie name them.
const (
	VI   = "vi"
	EN   = "en"
	ZhCN = "zh-CN"
)

// Default is the language of a user who never told the server theirs.
const Default = VI

// Valid reports whether s is one of the languages.
func Valid(s string) bool {
	switch s {
	case VI, EN, ZhCN:
		return true
	default:
		return false
	}
}
