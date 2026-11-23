package api

import (
	"log/slog"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/adapters/telegram"
	"app.local/server/internal/bridge/adapters/zalo"
	"app.local/server/internal/config"
)

// bridgeAdapters is the static set of apps the Chat Bridge can connect,
// keyed by Adapter.Name. An app is added by writing its adapter package and
// listing it here; there is no registry or plugin loader (ADR 0022). Zalo
// is offered only when ZALO_SIDECAR_BUNDLE is set and its
// sandbox passes every check; otherwise it is left out with an error log.
func bridgeAdapters(cfg config.Config, logger *slog.Logger) map[string]bridge.Adapter {
	adapters := map[string]bridge.Adapter{}
	if cfg.TelegramAPIID != 0 {
		adapters[telegram.Name] = telegram.New(telegram.Config{APIID: cfg.TelegramAPIID, APIHash: cfg.TelegramAPIHash})
	}
	if cfg.ZaloSidecarBundle != "" {
		runner, err := zalo.NewSandboxedRunner(zalo.SandboxConfig{
			Sudo: cfg.ZaloSudoPath, Node: cfg.ZaloNodePath, Bundle: cfg.ZaloSidecarBundle, User: cfg.ZaloSandboxUser,
			SHA256: cfg.ZaloSidecarSHA256,
		})
		if err != nil {
			logger.Error("Zalo is not offered: the sidecar sandbox check failed", "source", zalo.Name, "reason", err.Error())
		} else {
			adapters[zalo.Name] = zalo.New(zalo.Config{Runner: runner, Logger: logger.With("source", zalo.Name)})
		}
	}
	return adapters
}

// composerOnlyApps names the adapters that recognise a repeated send only
// within limits (bridge.RetryUnsafe): Chat sends to their chats only text the
// owner types in the composer (chat.Service.SetComposerOnlyApps).
func composerOnlyApps(adapters map[string]bridge.Adapter) []string {
	var names []string
	for name, a := range adapters {
		if _, ok := a.(bridge.RetryUnsafe); ok {
			names = append(names, name)
		}
	}
	return names
}
