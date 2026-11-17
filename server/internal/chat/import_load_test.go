package chat

import (
	"context"
	"fmt"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
)

// TestImportLoad imports 10 000 messages into a group of 50 puppet users
// while another user sends ordinary messages, and reports what the import
// costs. It runs only with BRIDGE_LOAD=1 (it takes a while and its numbers
// are for a person to read).
func TestImportLoad(t *testing.T) {
	if os.Getenv("BRIDGE_LOAD") == "" {
		t.Skip("set BRIDGE_LOAD=1 to run the import load test")
	}
	h := newHarness(t, nil)
	ctx := context.Background()
	owner := h.user("owner")
	chatID := h.group(owner)
	puppets := make([]int64, 50)
	for i := range puppets {
		puppets[i] = h.puppet(chatID, fmt.Sprintf("p%d", i))
	}
	a, b := h.user("alice"), h.user("bob")
	other := h.group(a, b)

	const total, batch = 10000, 500
	base := time.Now().Add(-100 * time.Hour)
	var latencies []time.Duration
	var mu sync.Mutex
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			start := time.Now()
			if _, err := h.svc.SendMessage(ctx, a, &appv1.SendMessageRequest{ChatId: other, Text: "hi"}); err != nil {
				t.Error(err)
				return
			}
			mu.Lock()
			latencies = append(latencies, time.Since(start))
			mu.Unlock()
			time.Sleep(20 * time.Millisecond)
		}
	}()

	start := time.Now()
	for done := 0; done < total; done += batch {
		msgs := make([]ImportMessage, batch)
		for i := range msgs {
			n := done + i
			msgs[i] = ImportMessage{FromID: puppets[n%len(puppets)], Date: base.Add(time.Duration(n) * time.Minute), Text: fmt.Sprintf("tin số %d", n)}
		}
		if err := h.importInto(chatID, owner, func(it *ImportTx) error {
			_, err := it.Append(ctx, msgs)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	elapsed := time.Since(start)
	close(stop)
	wg.Wait()

	var ownerUpdates, puppetRows int
	if err := h.st.Pool().QueryRow(ctx, `SELECT count(*) FROM user_updates WHERE user_id = $1 AND chat_id = $2`, owner, chatID).Scan(&ownerUpdates); err != nil {
		t.Fatal(err)
	}
	if err := h.st.Pool().QueryRow(ctx, `SELECT (SELECT count(*) FROM user_updates WHERE user_id = ANY($1)) + (SELECT count(*) FROM user_state WHERE user_id = ANY($1))`, puppets).Scan(&puppetRows); err != nil {
		t.Fatal(err)
	}
	slices.Sort(latencies)
	p := func(q float64) time.Duration {
		if len(latencies) == 0 {
			return 0
		}
		return latencies[min(int(float64(len(latencies))*q), len(latencies)-1)]
	}
	t.Logf("imported %d messages in %v (%.0f msg/s); user_updates of the owner for the chat: %d; rows of the 50 puppets: %d",
		total, elapsed.Round(time.Millisecond), float64(total)/elapsed.Seconds(), ownerUpdates, puppetRows)
	t.Logf("ordinary sends during the import: %d, p50 %v, p95 %v, max %v", len(latencies), p(0.5), p(0.95), latencies[len(latencies)-1])
	if puppetRows != 0 {
		t.Fatalf("puppets got %d log rows", puppetRows)
	}
}
