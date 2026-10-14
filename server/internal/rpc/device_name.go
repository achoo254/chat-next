package rpc

import "strings"

// browsers and systems are matched in order: Edge and Opera also announce
// Chrome, and Chrome also announces Safari; iOS also announces "Mac OS X".
var (
	browsers = [][2]string{
		{"Edg/", "Edge"}, {"OPR/", "Opera"}, {"Firefox/", "Firefox"}, {"FxiOS/", "Firefox"},
		{"CriOS/", "Chrome"}, {"Chrome/", "Chrome"}, {"Safari/", "Safari"},
	}
	systems = [][2]string{
		{"iPhone", "iOS"}, {"iPad", "iPadOS"}, {"Android", "Android"}, {"Windows", "Windows"},
		{"Mac OS X", "macOS"}, {"CrOS", "ChromeOS"}, {"Linux", "Linux"},
	}
)

// DeviceName summarizes a User-Agent as "Browser, System" for the session
// list, e.g. "Chrome, macOS". Unknown parts are left out; an unknown agent
// yields "".
func DeviceName(userAgent string) string {
	var parts []string
	for _, list := range [][][2]string{browsers, systems} {
		for _, m := range list {
			if strings.Contains(userAgent, m[0]) {
				parts = append(parts, m[1])
				break
			}
		}
	}
	return strings.Join(parts, ", ")
}
