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
// (receive only) is offered only when ZALO_SIDECAR_BUNDLE is set and its
// sandbox passes every check; otherwise it is left out with an error log.
func bridgeAdapters(cfg config.Config, logger *slog.Logger) map[string]bridge.Adapter {
	adapters := map[string]bridge.Adapter{}
	if cfg.TelegramAPIID != 0 {
		adapters[telegram.Name] = telegram.New(telegram.Config{APIID: cfg.TelegramAPIID, APIHash: cfg.TelegramAPIHash})
	}
	if cfg.ZaloSidecarBundle != "" {
		runner, err := zalo.NewSandboxedRunner(zalo.SandboxConfig{
			Node: cfg.ZaloNodePath, Bundle: cfg.ZaloSidecarBundle, User: cfg.ZaloSandboxUser, SHA256: cfg.ZaloSidecarSHA256,
		})
		if err != nil {
			logger.Error("Zalo is not offered: the sidecar sandbox check failed", "source", zalo.Name, "reason", err.Error())
		} else {
			adapters[zalo.Name] = zalo.New(zalo.Config{Runner: runner, Logger: logger.With("source", zalo.Name)})
		}
	}
	return adapters
}
