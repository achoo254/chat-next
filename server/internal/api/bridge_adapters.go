package api

import (
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/adapters/telegram"
	"app.local/server/internal/config"
)

// bridgeAdapters is the static set of apps the Chat Bridge can connect,
// keyed by Adapter.Name. An app is added by writing its adapter package and
// listing it here; there is no registry or plugin loader (ADR 0022).
func bridgeAdapters(cfg config.Config) map[string]bridge.Adapter {
	adapters := map[string]bridge.Adapter{}
	if cfg.TelegramAPIID != 0 {
		adapters[telegram.Name] = telegram.New(telegram.Config{APIID: cfg.TelegramAPIID, APIHash: cfg.TelegramAPIHash})
	}
	return adapters
}
