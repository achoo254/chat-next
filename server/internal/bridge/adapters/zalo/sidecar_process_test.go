package zalo

import (
	"context"
	"log/slog"
	"strings"
	"testing"
)

// A stdout line over maxLineBytes means the protocol is broken: the sidecar is
// killed and its events end, which a subscription reports as an exit.
func TestAnOverLongLineKillsTheSidecar(t *testing.T) {
	r := &fakeRunner{script: func(p *fakeProcess) {
		p.emit(readyLine)
		p.emit(`{"ev":"message","content":"` + strings.Repeat("x", maxLineBytes) + `"}`)
	}}
	h := &recordingHandler{}
	side, err := startSidecar(context.Background(), r, slog.New(h), fastTiming)
	if err != nil {
		t.Fatal(err)
	}
	defer side.stop()
	for range side.events {
		t.Error("an event came through")
	}
	if !r.process(t, 0).wasKilled() {
		t.Error("the sidecar was not killed")
	}
	if logged := strings.Join(h.all(), "\n"); !strings.Contains(logged, "line too long") || strings.Contains(logged, "xxxx") {
		t.Errorf("log:\n%s", logged)
	}
}
