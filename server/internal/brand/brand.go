// Package brand holds the product names the server shows to users (the
// assistant bot's name and messages, the title of push notifications that
// hide the message). They come from brand.config.json at
// the repository root, copied into brand.json by `pnpm brand:gen` because
// a Go module cannot embed files outside itself; a test fails when the
// copy is stale. Renaming the product needs brand.config.json, brand:gen
// and a rebuild, never a code change.
package brand

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

//go:embed brand.json
var raw []byte

// Names are the product names of the brand.
type Names struct {
	// AppName is the full product name.
	AppName string `json:"appName"`
	// ShortName is the name where space is short (bot names).
	ShortName string `json:"shortName"`
	// PushSenderName titles push notifications that hide the message.
	PushSenderName string `json:"pushSenderName"`
}

// Load returns the embedded names.
func Load() (Names, error) {
	return parse(raw)
}

func parse(b []byte) (Names, error) {
	var n Names
	if err := json.Unmarshal(b, &n); err != nil {
		return Names{}, fmt.Errorf("brand: decode brand.json: %w", err)
	}
	n.AppName, n.ShortName = strings.TrimSpace(n.AppName), strings.TrimSpace(n.ShortName)
	n.PushSenderName = strings.TrimSpace(n.PushSenderName)
	if n.AppName == "" || n.ShortName == "" || n.PushSenderName == "" {
		return Names{}, fmt.Errorf("brand: brand.json needs appName, shortName and pushSenderName")
	}
	return n, nil
}
