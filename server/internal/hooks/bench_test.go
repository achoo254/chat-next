package hooks_test

import (
	"fmt"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
)

// BenchmarkHookPost measures POST -> 200 of the hook endpoint server-side
// plus loopback HTTP: authentication, parsing, the delivery transaction on
// the embedded PostgreSQL, and the answer. Reports p50/p99 in ms.
//
//	go test -run '^$' -bench HookPost -benchtime 2000x ./internal/hooks/
func BenchmarkHookPost(b *testing.B) {
	for _, bc := range []struct {
		name    string
		clients int
		body    string
	}{
		{"native", 1, `{"text": "Build *chat-server* #318 lỗi", "parse_mode": "markdown"}`},
		{"native_parallel8", 8, `{"text": "Build *chat-server* #318 lỗi", "parse_mode": "markdown"}`},
		{"alert_group", 1, ""},
	} {
		b.Run(bc.name, func(b *testing.B) {
			h := newHarness(b, allowAll{})
			owner := h.user("owner")
			members := make([]int64, 10)
			for i := range members {
				members[i] = h.user(fmt.Sprintf("m%d", i))
			}
			chatID := h.group(owner, members...)
			format := appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_NATIVE
			body := bc.body
			if bc.name == "alert_group" {
				format = appv1.IncomingHookFormat_INCOMING_HOOK_FORMAT_ALERTMANAGER
				body = string(mustRead(b, "alertmanager-firing.json"))
			}
			_, hookURL := h.create(owner, chatID, "Bench", format)
			// Warm up connections and caches.
			for range 20 {
				h.post(hookURL, "", body)
			}
			var (
				mu    sync.Mutex
				taken = make([]time.Duration, 0, b.N)
				next  = make(chan struct{}, b.N)
			)
			for range b.N {
				next <- struct{}{}
			}
			close(next)
			b.ResetTimer()
			var wg sync.WaitGroup
			for range bc.clients {
				wg.Go(func() {
					for range next {
						start := time.Now()
						r := h.post(hookURL, "", body)
						d := time.Since(start)
						if r.status != http.StatusOK {
							b.Errorf("status %d %s", r.status, r.body)
							return
						}
						mu.Lock()
						taken = append(taken, d)
						mu.Unlock()
					}
				})
			}
			wg.Wait()
			b.StopTimer()
			slices.Sort(taken)
			if len(taken) == 0 {
				return
			}
			pct := func(p float64) float64 {
				return float64(taken[min(len(taken)-1, int(float64(len(taken))*p))].Microseconds()) / 1000
			}
			b.ReportMetric(pct(0.50), "p50_ms")
			b.ReportMetric(pct(0.99), "p99_ms")
			b.ReportMetric(0, "ns/op")
		})
	}
}
