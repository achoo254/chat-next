package api

import "app.local/server/internal/bridge"

// bridgeAdapters is the static set of apps the Chat Bridge can connect,
// keyed by Adapter.Name. An app is added by writing its adapter package and
// listing it here; there is no registry or plugin loader (ADR 0022).
func bridgeAdapters() map[string]bridge.Adapter {
	return map[string]bridge.Adapter{}
}
