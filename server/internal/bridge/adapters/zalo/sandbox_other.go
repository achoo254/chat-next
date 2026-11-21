//go:build !linux

package zalo

// realHost: no sandbox outside Linux, so Zalo is never offered there.
func realHost() hostSystem { return hostSystem{supported: false, serverUID: -1} }
