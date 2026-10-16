package botupdates

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"app.local/server/internal/safehttp"
	"github.com/jackc/pgx/v5"
)

// Webhook request headers (spec/bot-api/openapi.yaml, webhook section).
const (
	// HeaderSecret carries the secret the bot set.
	HeaderSecret = "X-Bot-Api-Secret-Token"
	// HeaderTimestamp carries the Unix time of the request, in seconds.
	HeaderTimestamp = "X-Bot-Timestamp"
	// HeaderSignature carries "v1=" + hex(HMAC-SHA256(secret, timestamp + "." + body)).
	HeaderSignature = "X-Bot-Signature"
)

// Dispatcher timings and limits.
const (
	// replyMax bounds the body of a 2xx answer that is read for an action
	// (the two allowed methods carry at most 4096 characters of text and
	// their entities).
	replyMax = 64 << 10
	// discardMax bounds what is read of other answers.
	discardMax = 64 << 10
	// breakerAfter consecutive failures of a bot's webhook drop its
	// parallelism to one request until a request succeeds again, so a dead
	// or slow endpoint holds one connection, not max_connections.
	breakerAfter = 5
	// headsMax bounds the queues looked at per round.
	headsMax = 1000
	// inflightMax bounds the webhook requests in flight across all bots of
	// the process (each may hold a reply of up to replyMax); see slots.
	inflightMax = 256
	// rescanEvery is how often the bots with a webhook are listed again.
	rescanEvery = 5 * time.Second
	// idleRecheck bounds how long a worker with nothing due trusts its
	// wake-ups alone (new updates, webhook changes, freed slots and
	// finished requests wake it).
	idleRecheck = time.Minute
	// workerRetry is the wait after a failed database read.
	workerRetry = 2 * time.Second
	// drainTimeout is how long in-flight requests may finish at shutdown
	// before they are cancelled (cancelled updates stay pending).
	drainTimeout = 5 * time.Second
	// writeTimeout bounds the database writes after a request.
	writeTimeout = 5 * time.Second
	// replyTimeout bounds running the action of an answer.
	replyTimeout  = 10 * time.Second
	retryFirst    = time.Second
	retryCapLow   = 60 * time.Second
	retryCapHigh  = 120 * time.Second
	retryAfterMax = time.Hour
)

// dispatcher POSTs pending updates to the webhooks of the tenant's bots:
// one worker goroutine per bot with a webhook, one request at a time per
// queue (chat, or presser for callbacks), up to max_connections per bot
// and inflightMax for the process, shared fairly between the bots that
// want more (slots). No request holds a database connection while it waits
// on a webhook, so a slow bot only slows its own queues. A worker reads the
// database when something happened (updates stored, its webhook changed, a
// request ended, a slot freed, a retry fell due), not on a timer while
// idle.
type dispatcher struct {
	s        *Service
	tenantID string
	client   *safehttp.Client
	logger   *slog.Logger
	reply    atomic.Pointer[ReplyFunc]
	slots    *slots
	// retryFloor is the shortest wait before another attempt, also when
	// the answer said Retry-After: 0 (retryFirst; tests shorten it).
	retryFloor time.Duration

	// beforeAck runs after the answer's action and before the update is
	// acknowledged; returning true abandons the request as if the process
	// died there (tests).
	beforeAck func(botID, updateID int64) bool
	// reads counts the workers' rounds of database reads (tests).
	reads atomic.Int64

	mu      sync.Mutex
	running bool
	ctx     context.Context
	workers map[int64]*worker
	hooked  map[int64]bool
	// loops are the workers; a worker returns once its requests ended.
	loops sync.WaitGroup
	// sendCtx cancels the requests in flight drainTimeout after shutdown.
	sendCtx context.Context
}

type worker struct {
	bot  int64
	wake chan struct{}
	done chan sent
	// inflight maps a queue to the update in flight; only the worker
	// goroutine touches it.
	inflight map[int64]int64
	// streak counts consecutive failures (circuit breaker).
	streak int
	// openReqs mirrors len(inflight) for readers outside the worker.
	openReqs atomic.Int32
}

// sent is the outcome of one request.
type sent struct {
	queue int64
	// ok: acknowledged; abandoned: neither success nor failure (shutdown).
	ok, abandoned bool
}

// hookConfig is a bot's webhook as the worker uses it.
type hookConfig struct {
	url            string
	secret         []byte
	secretErr      bool
	maxConnections int
}

// head is the oldest pending update of a queue.
type head struct {
	id, queue int64
	kind      string
	attempts  int
	due       time.Time
	payload   []byte
}

func newDispatcher(s *Service, tenantID string, client *safehttp.Client, logger *slog.Logger) *dispatcher {
	return &dispatcher{s: s, tenantID: tenantID, client: client, logger: logger, slots: newSlots(inflightMax), retryFloor: retryFirst,
		workers: map[int64]*worker{}, hooked: map[int64]bool{}}
}

func (d *dispatcher) setReply(fn ReplyFunc) {
	if fn == nil {
		d.reply.Store(nil)
		return
	}
	d.reply.Store(&fn)
}

// run starts a worker for every bot with a webhook and keeps the list
// fresh until ctx ends, then lets in-flight requests finish (drainTimeout).
func (d *dispatcher) run(ctx context.Context) {
	sendCtx, cancelSends := context.WithCancel(context.WithoutCancel(ctx))
	defer cancelSends()
	d.mu.Lock()
	d.running, d.ctx, d.sendCtx = true, ctx, sendCtx
	d.mu.Unlock()
	ticker := time.NewTicker(rescanEvery)
	defer ticker.Stop()
	for {
		d.rescan(ctx)
		select {
		case <-ctx.Done():
			d.mu.Lock()
			d.running = false
			d.mu.Unlock()
			cancelLater := time.AfterFunc(drainTimeout, cancelSends)
			d.loops.Wait()
			cancelLater.Stop()
			return
		case <-ticker.C:
		}
	}
}

// ownerActive is the SQL predicate (on bots) of a bot whose owner's account
// is not waiting for deletion: during the grace period the webhook is
// paused (updates keep queuing until they expire) and it resumes on its own
// at the next rescan when the owner cancels.
const ownerActive = `NOT EXISTS (SELECT 1 FROM users o WHERE o.id = bots.owner_id AND o.deletion_requested_at IS NOT NULL)`

func (d *dispatcher) rescan(ctx context.Context) {
	rows, err := d.s.pool.Query(ctx, `
		SELECT user_id FROM bots WHERE webhook_url IS NOT NULL AND deleted_at IS NULL AND tenant_id = $1 AND `+ownerActive, d.tenantID)
	if err != nil {
		if ctx.Err() == nil {
			d.logger.Warn("listing bots with a webhook failed", "err", err)
		}
		return
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		if ctx.Err() == nil {
			d.logger.Warn("listing bots with a webhook failed", "err", err)
		}
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.hooked = make(map[int64]bool, len(ids))
	for _, id := range ids {
		d.hooked[id] = true
		d.startLocked(id)
	}
	// A webhook gone without changed() (the bot was deleted): its worker
	// finds no webhook and ends.
	for id, w := range d.workers {
		if !d.hooked[id] {
			w.poke()
		}
	}
}

// startLocked starts the bot's worker unless it runs; d.mu is held.
func (d *dispatcher) startLocked(botID int64) *worker {
	if !d.running {
		return nil
	}
	if w := d.workers[botID]; w != nil {
		return w
	}
	w := &worker{bot: botID, wake: make(chan struct{}, 1), done: make(chan sent, MaxConnectionsMax), inflight: map[int64]int64{}}
	d.workers[botID] = w
	d.loops.Add(1)
	go d.work(d.ctx, w)
	return w
}

// wake tells the bot's worker that updates were stored.
func (d *dispatcher) wake(botID int64) {
	d.mu.Lock()
	w := d.workers[botID]
	if w == nil && d.hooked[botID] {
		w = d.startLocked(botID)
	}
	d.mu.Unlock()
	if w != nil {
		w.poke()
	}
}

// poke makes the worker look at the database again; it never blocks.
func (w *worker) poke() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// changed follows a webhook set or deleted in this process.
func (d *dispatcher) changed(botID int64, set bool) {
	d.mu.Lock()
	if set {
		d.hooked[botID] = true
	} else {
		delete(d.hooked, botID)
	}
	d.mu.Unlock()
	d.wake(botID)
}

// open is the number of requests in flight to the bot's webhook.
func (d *dispatcher) open(botID int64) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	if w := d.workers[botID]; w != nil {
		return int(w.openReqs.Load())
	}
	return 0
}

// work runs one bot's deliveries until its webhook is gone (and nothing is
// in flight) or the dispatcher stops.
func (d *dispatcher) work(ctx context.Context, w *worker) {
	defer d.loops.Done()
	timer := time.NewTimer(0)
	defer timer.Stop()
	stop := ctx.Done()
	stopping := false
	for {
		next := idleRecheck
		if !stopping {
			d.reads.Add(1)
			cfg, err := d.config(ctx, w.bot)
			switch {
			case err != nil:
				next = workerRetry
				if ctx.Err() == nil {
					d.logger.Warn("loading a bot webhook failed", "bot_id", w.bot, "err", err)
				}
			case cfg == nil:
				if len(w.inflight) == 0 && d.retire(w) {
					d.slots.forget(w.bot)
					return
				}
			default:
				if wait, err := d.launch(ctx, w, cfg); err != nil {
					next = workerRetry
					if ctx.Err() == nil {
						d.logger.Warn("reading a bot's pending updates failed", "bot_id", w.bot, "err", err)
					}
				} else {
					next = wait
				}
			}
		} else if len(w.inflight) == 0 {
			d.retireNow(w)
			d.slots.forget(w.bot)
			return
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(max(next, 10*time.Millisecond))
		select {
		case <-stop:
			stop, stopping = nil, true
		case <-w.wake:
		case r := <-w.done:
			w.finish(r)
			for drained := false; !drained; {
				select {
				case r := <-w.done:
					w.finish(r)
				default:
					drained = true
				}
			}
		case <-timer.C:
		}
	}
}

func (w *worker) finish(r sent) {
	delete(w.inflight, r.queue)
	w.openReqs.Store(int32(len(w.inflight)))
	switch {
	case r.abandoned:
	case r.ok:
		w.streak = 0
	default:
		w.streak++
	}
}

// retire removes the worker of a bot without webhook, unless a webhook was
// set again meanwhile.
func (d *dispatcher) retire(w *worker) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.hooked[w.bot] && d.running {
		return false
	}
	delete(d.workers, w.bot)
	return true
}

func (d *dispatcher) retireNow(w *worker) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.workers, w.bot)
}

// config loads the bot's webhook; nil when it has none.
func (d *dispatcher) config(ctx context.Context, botID int64) (*hookConfig, error) {
	var cfg hookConfig
	var sealed []byte
	var maxConn int16
	err := d.s.pool.QueryRow(ctx, `
		SELECT webhook_url, webhook_secret, webhook_max_connections FROM bots
		WHERE user_id = $1 AND deleted_at IS NULL AND webhook_url IS NOT NULL AND tenant_id = $2 AND `+ownerActive, botID, d.tenantID).
		Scan(&cfg.url, &sealed, &maxConn)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	cfg.maxConnections = int(maxConn)
	if cfg.secret, err = d.s.box.Open(sealed, secretAAD(botID)); err != nil {
		cfg.secretErr = true
	}
	return &cfg, nil
}

// launch starts a request for the head of every due queue that has none
// in flight, within the bot's parallelism and the slots it gets, and
// returns when the next queue becomes due (idleRecheck when none waits on
// time: finished requests and freed slots wake the worker).
func (d *dispatcher) launch(ctx context.Context, w *worker, cfg *hookConfig) (time.Duration, error) {
	heads, err := d.heads(ctx, w.bot)
	if err != nil {
		return 0, err
	}
	limit := cfg.maxConnections
	if w.streak >= breakerAfter {
		limit = 1
	}
	now := time.Now()
	next := idleRecheck
	var due []head
	for _, h := range heads {
		if _, busy := w.inflight[h.queue]; busy {
			continue
		}
		if wait := h.due.Sub(now); wait > 0 {
			next = min(next, wait)
			continue
		}
		if len(w.inflight)+len(due) >= limit {
			break
		}
		due = append(due, h)
	}
	if len(due) == 0 {
		d.slots.forget(w.bot)
		return next, nil
	}
	due = due[:d.slots.acquire(w.bot, len(due), w.poke)]
	if len(due) == 0 {
		return next, nil
	}
	if err := d.payloads(ctx, w.bot, due); err != nil {
		for range due {
			d.slots.release(w.bot)
		}
		return 0, err
	}
	d.mu.Lock()
	sendCtx := d.sendCtx
	d.mu.Unlock()
	for _, h := range due {
		w.inflight[h.queue] = h.id
		go func() {
			r := d.send(sendCtx, w, cfg, h)
			d.slots.release(w.bot)
			w.done <- r
		}()
	}
	w.openReqs.Store(int32(len(w.inflight)))
	return next, nil
}

// headsQuery reads the oldest pending update of each queue of bot $1,
// oldest first, at most $2. It walks bot_updates_pending_idx queue by queue
// (a skip scan: one index probe per queue, then the queue's first live row),
// so its cost follows the number of queues, not the bot's backlog.
const headsQuery = `
	WITH RECURSIVE q(queue_key) AS (
		(SELECT queue_key FROM bot_updates WHERE bot_id = $1 AND NOT acked AND dead_at IS NULL ORDER BY queue_key LIMIT 1)
		UNION ALL
		SELECT (SELECT u.queue_key FROM bot_updates u
			WHERE u.bot_id = $1 AND NOT u.acked AND u.dead_at IS NULL AND u.queue_key > q.queue_key
			ORDER BY u.queue_key LIMIT 1)
		FROM q WHERE q.queue_key IS NOT NULL
	)
	SELECT h.update_id, h.queue_key, h.kind, h.attempts, h.next_attempt_at
	FROM q CROSS JOIN LATERAL (
		SELECT update_id, queue_key, kind, attempts, next_attempt_at FROM bot_updates u
		WHERE u.bot_id = $1 AND NOT u.acked AND u.dead_at IS NULL AND u.queue_key = q.queue_key AND u.expires_at > now()
		ORDER BY u.update_id LIMIT 1
	) h
	WHERE q.queue_key IS NOT NULL
	ORDER BY h.update_id LIMIT $2`

// heads returns the oldest pending update of each queue, oldest first.
func (d *dispatcher) heads(ctx context.Context, botID int64) ([]head, error) {
	rows, err := d.s.pool.Query(ctx, headsQuery, botID, headsMax)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (head, error) {
		var h head
		var attempts int16
		var due *time.Time
		err := r.Scan(&h.id, &h.queue, &h.kind, &attempts, &due)
		h.attempts = int(attempts)
		if due != nil {
			h.due = *due
		}
		return h, err
	})
}

func (d *dispatcher) payloads(ctx context.Context, botID int64, list []head) error {
	ids := make([]int64, len(list))
	for i, h := range list {
		ids[i] = h.id
	}
	rows, err := d.s.pool.Query(ctx, `SELECT update_id, payload FROM bot_updates WHERE bot_id = $1 AND update_id = ANY($2)`, botID, ids)
	if err != nil {
		return err
	}
	byID := map[int64][]byte{}
	for rows.Next() {
		var id int64
		var p []byte
		if err := rows.Scan(&id, &p); err != nil {
			rows.Close()
			return err
		}
		byID[id] = p
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range list {
		list[i].payload = byID[list[i].id]
	}
	return nil
}

// Sign returns the X-Bot-Signature value of a request: "v1=" +
// hex(HMAC-SHA256(secret, timestamp + "." + body)).
func Sign(secret []byte, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(timestamp))
	mac.Write([]byte{'.'})
	mac.Write(body)
	return "v1=" + hex.EncodeToString(mac.Sum(nil))
}

// ReplyRandomID is the random_id of a message sent from a webhook answer
// to update updateID: the same for every delivery of the update, below
// 2^53 and never 0.
func ReplyRandomID(botID, updateID int64) int64 {
	var b [16]byte
	binary.BigEndian.PutUint64(b[:8], uint64(botID))
	binary.BigEndian.PutUint64(b[8:], uint64(updateID))
	sum := sha256.Sum256(append([]byte("webhook-reply:"), b[:]...))
	return int64(binary.BigEndian.Uint64(sum[:8])&(1<<53-1)) | 1
}

// send POSTs one update and records the outcome.
func (d *dispatcher) send(ctx context.Context, w *worker, cfg *hookConfig, h head) sent {
	out := sent{queue: h.queue}
	if cfg.secretErr {
		d.failed(w.bot, h, "secret_unreadable", 0, false)
		return out
	}
	body, err := json.Marshal(Update{ID: h.id, Kind: h.kind, Payload: h.payload})
	if err != nil {
		d.logger.Error("encoding an update failed", append(logAttrs(w.bot, h.id), "err", err)...)
		d.failed(w.bot, h, "encode", 0, false)
		return out
	}
	reqCtx, cancel := context.WithTimeout(ctx, d.client.Timeout())
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, cfg.url, bytes.NewReader(body))
	if err != nil {
		d.failed(w.bot, h, "invalid_url", 0, false)
		return out
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ChatBotWebhook/1.0")
	req.Header.Set(HeaderSecret, string(cfg.secret))
	req.Header.Set(HeaderTimestamp, ts)
	req.Header.Set(HeaderSignature, Sign(cfg.secret, ts, body))
	start := time.Now()
	resp, err := d.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			out.abandoned = true
			return out
		}
		d.failed(w.bot, h, failureOf(err), 0, false)
		return out
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		retryAfter, has := parseRetryAfter(resp.Header.Get("Retry-After"))
		safehttp.Discard(resp, discardMax)
		d.failed(w.bot, h, "http_"+strconv.Itoa(resp.StatusCode), retryAfter, has)
		return out
	}
	answer, err := safehttp.ReadBody(resp, replyMax)
	elapsed := time.Since(start)
	if ctx.Err() != nil {
		out.abandoned = true
		return out
	}
	switch {
	case errors.Is(err, safehttp.ErrTooLarge):
		d.logger.Warn("webhook answer too large; its action is ignored", logAttrs(w.bot, h.id)...)
	case err != nil:
		// The status was 2xx: the bot has the update.
		d.logger.Debug("reading a webhook answer failed", append(logAttrs(w.bot, h.id), "err", err)...)
	default:
		d.runReply(w.bot, h.id, answer)
	}
	if d.beforeAck != nil && d.beforeAck(w.bot, h.id) {
		out.abandoned = true
		return out
	}
	d.delivered(w.bot, h.id, elapsed)
	out.ok = true
	return out
}

// runReply runs the method of a 2xx answer, if it names one. Failures are
// logged; delivery succeeded either way.
func (d *dispatcher) runReply(botID, updateID int64, answer []byte) {
	answer = bytes.TrimSpace(answer)
	if len(answer) == 0 || answer[0] != '{' {
		return
	}
	fn := d.reply.Load()
	if fn == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), replyTimeout)
	defer cancel()
	if err := (*fn)(ctx, botID, ReplyRandomID(botID, updateID), answer); err != nil {
		d.logger.Info("webhook answer action failed", append(logAttrs(botID, updateID), "err", err)...)
	}
}

func (d *dispatcher) delivered(botID, updateID int64, elapsed time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	if _, err := d.s.pool.Exec(ctx, `
		WITH u AS (
			UPDATE bot_updates SET acked = true, delivered_at = now() WHERE bot_id = $1 AND update_id = $2 AND NOT acked RETURNING 1
		)
		INSERT INTO bot_delivery_counters (bot_id, hour, delivered, last_delivered_at, last_delivery_ms)
		SELECT $1, date_trunc('hour', now()), 1, now(), $3 FROM u
		ON CONFLICT (bot_id, hour) DO UPDATE SET delivered = bot_delivery_counters.delivered + 1,
			last_delivered_at = excluded.last_delivered_at, last_delivery_ms = excluded.last_delivery_ms`,
		botID, updateID, int32(min(elapsed.Milliseconds(), 1<<31-1))); err != nil {
		// The update stays pending and is sent again: at least once.
		d.logger.Warn("acknowledging a delivered update failed", append(logAttrs(botID, updateID), "err", err)...)
	}
}

// failed records a failed attempt: the update is tried again after a
// backoff, or dead-lettered after MaxAttempts.
func (d *dispatcher) failed(botID int64, h head, reason string, retryAfter time.Duration, hasRetryAfter bool) {
	attempts := h.attempts + 1
	delay := retryDelay(attempts, retryAfter, hasRetryAfter, d.retryFloor)
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	var dead bool
	err := d.s.pool.QueryRow(ctx, `
		WITH u AS (
			UPDATE bot_updates SET attempts = attempts + 1, last_error = $3, last_error_at = now(),
				next_attempt_at = CASE WHEN attempts + 1 >= $4 THEN NULL ELSE now() + make_interval(secs => $5) END,
				dead_at = CASE WHEN attempts + 1 >= $4 THEN now() END
			WHERE bot_id = $1 AND update_id = $2 AND NOT acked AND dead_at IS NULL
			RETURNING dead_at IS NOT NULL AS dead
		), c AS (
			INSERT INTO bot_delivery_counters (bot_id, hour, failed, dead_lettered, last_error, last_error_at)
			SELECT $1, date_trunc('hour', now()), 1, CASE WHEN dead THEN 1 ELSE 0 END, $3, now() FROM u
			ON CONFLICT (bot_id, hour) DO UPDATE SET failed = bot_delivery_counters.failed + 1,
				dead_lettered = bot_delivery_counters.dead_lettered + excluded.dead_lettered,
				last_error = excluded.last_error, last_error_at = excluded.last_error_at
		)
		SELECT coalesce((SELECT dead FROM u), false)`,
		botID, h.id, reason, MaxAttempts, delay.Seconds()).Scan(&dead)
	if err != nil {
		d.logger.Warn("recording a failed delivery failed", append(logAttrs(botID, h.id), "err", err)...)
		return
	}
	if dead {
		d.logger.Info("bot update dead-lettered", append(logAttrs(botID, h.id), "reason", reason, "attempts", attempts)...)
	}
}

// retryDelay is the wait before the next attempt after attempts failures:
// the answer's Retry-After when it had one, at least floor (so Retry-After
// 0 or a past date cannot burn through the attempts at once) and at most
// an hour; else 1 s doubling per failure, capped at a random 60 to 120 s.
func retryDelay(attempts int, retryAfter time.Duration, hasRetryAfter bool, floor time.Duration) time.Duration {
	if hasRetryAfter {
		return min(max(retryAfter, floor), retryAfterMax)
	}
	d := retryFirst << min(max(attempts-1, 0), 16)
	if d > retryCapLow {
		return retryCapLow + rand.N(retryCapHigh-retryCapLow)
	}
	return d
}

// parseRetryAfter reads Retry-After as seconds or an HTTP date.
func parseRetryAfter(v string) (time.Duration, bool) {
	if v == "" {
		return 0, false
	}
	if n, err := strconv.ParseInt(v, 10, 64); err == nil {
		return time.Duration(min(max(n, 0), int64(retryAfterMax/time.Second))) * time.Second, true
	}
	if t, err := http.ParseTime(v); err == nil {
		return time.Until(t), true
	}
	return 0, false
}

// failureOf names a transport error for the owner (stored as last_error).
func failureOf(err error) string {
	var dnsErr *safehttp.DNSError
	var netDNS *net.DNSError
	var netErr net.Error
	var unknownCA x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	var verify *tls.CertificateVerificationError
	var record tls.RecordHeaderError
	switch {
	case errors.Is(err, safehttp.ErrBlocked):
		return "blocked_address"
	case errors.Is(err, safehttp.ErrURL):
		return "invalid_url"
	case errors.As(err, &dnsErr), errors.As(err, &netDNS):
		return "dns"
	case errors.As(err, &unknownCA), errors.As(err, &hostname), errors.As(err, &invalid), errors.As(err, &verify),
		errors.As(err, &record):
		return "tls"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &netErr) && netErr.Timeout():
		return "timeout"
	default:
		return "connect"
	}
}
