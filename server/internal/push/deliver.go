package push

import (
	"context"
	"errors"
	"net/url"
	"sync"
	"time"

	"app.local/server/internal/chat"
	"app.local/server/internal/webpush"
	"github.com/jackc/pgx/v5"
)

// Delivery limits.
const (
	// queueMax bounds the sends waiting for a worker; a full queue drops
	// new ones (logged): pushes are best effort, memory is not.
	queueMax = 10000
	// workers is how many sends run at once.
	workers = 16
	// maxFailures consecutive rejections delete a subscription.
	maxFailures = 5
	// drainTimeout is how long queued sends may finish at shutdown.
	drainTimeout = 5 * time.Second
	// writeTimeout bounds the bookkeeping write after a send.
	writeTimeout = 5 * time.Second
	// touchEvery bounds how often a subscription's last_sent_at is written.
	touchEvery = time.Hour
)

// job is one push to send.
type job struct {
	target       chat.PushTarget
	notification webpush.Message
}

// deliveries is the bounded queue of sends and its workers.
type deliveries struct {
	s     *Service
	queue chan job
	// dropped counts sends dropped on a full queue since the last log.
	mu      sync.Mutex
	dropped int
}

func newDeliveries(s *Service) *deliveries {
	return &deliveries{s: s, queue: make(chan job, queueMax)}
}

// add queues j without blocking.
func (d *deliveries) add(j job) {
	select {
	case d.queue <- j:
	default:
		d.mu.Lock()
		d.dropped++
		n := d.dropped
		d.mu.Unlock()
		if n == 1 || n%1000 == 0 {
			d.s.logger.Warn("push queue full; dropping pushes", "dropped", n)
		}
	}
}

// run sends queued pushes until ctx ends, then for at most drainTimeout.
func (d *deliveries) run(ctx context.Context) {
	sendCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	defer cancel()
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for range workers {
		wg.Go(func() {
			for {
				select {
				case j := <-d.queue:
					d.send(sendCtx, j)
				case <-stop:
					// Drain what is queued, until the drain deadline.
					for {
						select {
						case j := <-d.queue:
							if sendCtx.Err() != nil {
								return
							}
							d.send(sendCtx, j)
						default:
							return
						}
					}
				}
			}
		})
	}
	<-ctx.Done()
	timer := time.AfterFunc(drainTimeout, cancel)
	defer timer.Stop()
	close(stop)
	wg.Wait()
}

func (d *deliveries) send(ctx context.Context, j job) {
	t := j.target
	res, err := d.s.cfg.Sender.Send(ctx, t.Endpoint, webpush.Keys{P256DH: t.P256DH, Auth: t.Auth}, j.notification)
	if err != nil {
		// A stored subscription that cannot be sent to at all (an endpoint
		// no longer allowed): drop it.
		d.s.logger.Warn("push subscription unusable; deleting it", "subscription_id", t.SubscriptionID, "err", err)
		d.drop(t)
		return
	}
	switch res.Outcome {
	case webpush.Delivered:
		d.delivered(t)
	case webpush.Gone:
		d.drop(t)
	case webpush.Rejected:
		d.s.logger.Info("push rejected", "subscription_id", t.SubscriptionID, "host", host(t.Endpoint), "status", res.Status)
		d.rejected(t)
	case webpush.Throttled, webpush.Failed:
		if ctx.Err() == nil {
			d.s.logger.Info("push not delivered", "subscription_id", t.SubscriptionID, "host", host(t.Endpoint), "status", res.Status)
		}
	}
}

func (d *deliveries) delivered(t chat.PushTarget) {
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	if _, err := d.s.pool.Exec(ctx, `
		UPDATE push_subscriptions SET last_sent_at = now(), failures = 0
		WHERE id = $1 AND (failures > 0 OR last_sent_at IS NULL OR last_sent_at < now() - $2::interval)`,
		t.SubscriptionID, touchEvery); err != nil {
		d.s.logger.Warn("recording a push failed", "subscription_id", t.SubscriptionID, "err", err)
	}
}

// drop deletes the subscription, unless the browser registered a new
// endpoint for the row meanwhile.
func (d *deliveries) drop(t chat.PushTarget) {
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	if _, err := d.s.pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE id = $1 AND endpoint = $2`,
		t.SubscriptionID, t.Endpoint); err != nil {
		d.s.logger.Warn("deleting a push subscription failed", "subscription_id", t.SubscriptionID, "err", err)
	}
}

// rejected counts a rejection and deletes the subscription at maxFailures.
func (d *deliveries) rejected(t chat.PushTarget) {
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	var failures int16
	err := d.s.pool.QueryRow(ctx, `
		UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1 AND endpoint = $2 RETURNING failures`,
		t.SubscriptionID, t.Endpoint).Scan(&failures)
	if errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err != nil {
		d.s.logger.Warn("recording a rejected push failed", "subscription_id", t.SubscriptionID, "err", err)
		return
	}
	if failures >= maxFailures {
		d.drop(t)
	}
}

// host is the push service of an endpoint, for logs: the rest of the URL
// identifies the device.
func host(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil {
		return ""
	}
	return u.Hostname()
}
