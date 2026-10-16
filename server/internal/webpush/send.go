package webpush

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Urgency of a push message (RFC 8030 section 5.3).
const (
	UrgencyNormal = "normal"
	UrgencyHigh   = "high"
)

// Sender timings.
const (
	sendTimeout = 10 * time.Second
	// discardMax bounds what is read of a push service's answer.
	discardMax = 4 << 10
)

// topicPattern: RFC 8030 section 5.4, at most 32 characters of the URL and
// filename safe base64 alphabet.
// appleHost is Apple's push service, which refuses RFC 8030 Topic headers
// with {"reason":"BadWebPushTopic"} (seen on prod with "chat4"); the
// notification tag in the service worker still collapses per chat there.
const appleHost = "push.apple.com"

// reasonMax caps how much of a refusal body is kept for the log.
const reasonMax = 256

var topicPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// Message is one push message before encryption.
type Message struct {
	Payload []byte
	// TTL is how long the push service keeps an undelivered message.
	TTL time.Duration
	// Urgency is UrgencyNormal or UrgencyHigh (battery hint for phones).
	Urgency string
	// Topic, when set, replaces an undelivered message with the same topic
	// at the push service (one pending notification per chat).
	Topic string
}

// Outcome classifies a push service's answer.
type Outcome int

const (
	// Delivered: the push service accepted the message (2xx).
	Delivered Outcome = iota
	// Gone: the subscription expired or was removed (404, 410); delete it.
	Gone
	// Rejected: the push service refused this request (other 4xx but 429),
	// for example an expired VAPID token or a key the subscription was not
	// made with; repeated rejections mean the subscription is unusable.
	Rejected
	// Throttled: too many messages (429); try later.
	Throttled
	// Failed: a server error or a network failure; transient.
	Failed
)

// Result is the outcome of one send.
type Result struct {
	Outcome Outcome
	// Status is the HTTP status; 0 when no answer came.
	Status int
	// Reason is the start of the body of a non-2xx answer (push services
	// explain refusals there, e.g. Apple's {"reason":"BadJwtToken"}); it
	// never holds message content.
	Reason string
}

// Sender POSTs encrypted messages to push services.
type Sender struct {
	client     *http.Client
	vapid      *VAPID
	allowLocal bool
	padTo      int
	now        func() time.Time
}

// SenderOptions configure NewSender.
type SenderOptions struct {
	// Client replaces the HTTP client (tests route the push service hosts
	// to a local server); nil uses a client with sendTimeout that never
	// follows redirects.
	Client *http.Client
	// AllowLocal also sends to loopback endpoints (development only, see
	// CheckEndpoint).
	AllowLocal bool
	// PadTo pads plaintexts to a multiple of this many bytes.
	PadTo int
}

// NewSender returns a Sender signing with vapid.
func NewSender(vapid *VAPID, o SenderOptions) (*Sender, error) {
	if vapid == nil {
		return nil, errors.New("webpush: VAPID signer required")
	}
	client := o.Client
	if client == nil {
		transport, ok := http.DefaultTransport.(*http.Transport)
		if !ok {
			return nil, errors.New("webpush: unexpected default transport")
		}
		t := transport.Clone()
		t.Proxy = nil
		t.MaxIdleConnsPerHost = 32
		client = &http.Client{Transport: t, Timeout: sendTimeout}
	}
	// A push service never redirects; an endpoint must not lead elsewhere.
	noRedirect := *client
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Sender{client: &noRedirect, vapid: vapid, allowLocal: o.AllowLocal, padTo: o.PadTo, now: time.Now}, nil
}

// AllowLocal reports whether loopback endpoints are accepted.
func (s *Sender) AllowLocal() bool {
	return s.allowLocal
}

// PublicKey is the applicationServerKey of the sender's VAPID key.
func (s *Sender) PublicKey() []byte {
	return s.vapid.PublicKey()
}

// Send encrypts m for keys and POSTs it to endpoint. The error is set
// when the request could not be made at all (bad endpoint, encryption);
// answers of the push service, including failures to reach it, are
// classified in Result.
func (s *Sender) Send(ctx context.Context, endpoint string, keys Keys, m Message) (Result, error) {
	u, err := CheckEndpoint(endpoint, s.allowLocal)
	if err != nil {
		return Result{}, err
	}
	if m.Topic != "" && !topicPattern.MatchString(m.Topic) {
		return Result{}, fmt.Errorf("webpush: invalid topic %q", m.Topic)
	}
	body, err := Encrypt(m.Payload, keys, s.padTo)
	if err != nil {
		return Result{}, err
	}
	auth, err := s.vapid.Authorization(Audience(u), s.now())
	if err != nil {
		return Result{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return Result{}, fmt.Errorf("webpush: request: %w", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("TTL", strconv.Itoa(int(max(m.TTL, 0)/time.Second)))
	if m.Urgency != "" {
		req.Header.Set("Urgency", m.Urgency)
	}
	if m.Topic != "" && !strings.HasSuffix(u.Hostname(), appleHost) {
		req.Header.Set("Topic", m.Topic)
	}
	req.Header.Set("Authorization", auth)
	resp, err := s.client.Do(req)
	if err != nil {
		return Result{Outcome: Failed}, nil
	}
	res := Result{Outcome: classify(resp.StatusCode), Status: resp.StatusCode}
	if res.Outcome != Delivered {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, reasonMax))
		res.Reason = strings.TrimSpace(string(body))
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, discardMax))
	_ = resp.Body.Close()
	return res, nil
}

func classify(status int) Outcome {
	switch {
	case status >= 200 && status < 300:
		return Delivered
	case status == http.StatusNotFound || status == http.StatusGone:
		return Gone
	case status == http.StatusTooManyRequests:
		return Throttled
	case status >= 400 && status < 500:
		return Rejected
	default:
		return Failed
	}
}
