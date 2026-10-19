package chat

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/logging/redact"
)

// Errors the web app caught (FeedbackService.ReportClientError) are kept
// as a count per kind of error and day, for the operators' daily digest.
// Nothing of what the user typed or saw is stored: the message is scrubbed
// of secrets, email addresses, URLs and numbers, the location is a path in
// the app's bundle, the route a bare name.

// Saigon is the time zone of the operators' days (Asia/Saigon, no DST).
var Saigon = time.FixedZone("ICT", 7*60*60)

// SaigonDay is the Asia/Saigon date of t, as a date column holds it
// (midnight UTC of that date).
func SaigonDay(t time.Time) time.Time {
	y, m, d := t.In(Saigon).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// Client error limits.
const (
	clientErrorMessageMax = 300
	// clientErrorKindsPerDay bounds the distinct errors kept per tenant and
	// day; later new ones only count when already known.
	clientErrorKindsPerDay = 500
)

var clientErrorKinds = map[appv1.ClientErrorKind]string{
	appv1.ClientErrorKind_CLIENT_ERROR_KIND_ERROR:               "error",
	appv1.ClientErrorKind_CLIENT_ERROR_KIND_UNHANDLED_REJECTION: "rejection",
	appv1.ClientErrorKind_CLIENT_ERROR_KIND_RENDER:              "render",
}

var (
	clientErrorLocation = regexp.MustCompile(`^[A-Za-z0-9_./-]{1,160}:[0-9]{1,7}(:[0-9]{1,7})?$`)
	clientErrorRelease  = regexp.MustCompile(`^[A-Za-z0-9._-]{0,64}$`)
	clientErrorRoute    = regexp.MustCompile(`^[A-Za-z0-9_-]{0,32}$`)
	// Scrubbing, after redact.String: URLs (they may carry tokens or ids),
	// phone numbers, long hex (keys, hashes) and any other number (ids,
	// sizes), so equal errors share one fingerprint.
	scrubURL    = regexp.MustCompile(`(?i)\b(?:https?|wss?|blob|data|file):\S*`)
	scrubPhone  = regexp.MustCompile(`\+?[0-9][0-9 ().-]{7,}[0-9]`)
	scrubHex    = regexp.MustCompile(`\b[0-9A-Fa-f]{16,}\b`)
	scrubNumber = regexp.MustCompile(`[0-9]+`)
)

// ScrubContacts masks secrets, email addresses and phone numbers in text
// a user wrote (the excerpt of feedback in the operators' group).
func ScrubContacts(text string) string {
	return scrubPhone.ReplaceAllString(redact.String(text), redact.Mask)
}

// ScrubClientErrorMessage returns an error message without personal data
// or secrets, on one line, at most clientErrorMessageMax characters.
func ScrubClientErrorMessage(message string) string {
	message = strings.ToValidUTF8(message, "")
	message = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, message)
	message = redact.String(message)
	message = scrubURL.ReplaceAllString(message, "[url]")
	message = scrubPhone.ReplaceAllString(message, "[number]")
	message = scrubHex.ReplaceAllString(message, "[hex]")
	message = scrubNumber.ReplaceAllString(message, "0")
	message = strings.Join(strings.Fields(message), " ")
	if runes := []rune(message); len(runes) > clientErrorMessageMax {
		message = string(runes[:clientErrorMessageMax])
	}
	return message
}

// RecordClientError counts one error the web app of a user (or of a
// signed-out page, keyed by address) reported. rateKey names the caller
// for the rate limit; a report over it is dropped without an error.
func (s *Service) RecordClientError(ctx context.Context, rateKey string, req *appv1.ReportClientErrorRequest) error {
	kind, ok := clientErrorKinds[req.GetKind()]
	if !ok {
		return errInvalid("unknown client error kind")
	}
	message := ScrubClientErrorMessage(req.GetMessage())
	if message == "" {
		return errInvalid("message is required")
	}
	location := req.GetLocation()
	if !clientErrorLocation.MatchString(location) {
		location = ""
	}
	release := req.GetRelease()
	if !clientErrorRelease.MatchString(release) {
		release = ""
	}
	route := req.GetRoute()
	if !clientErrorRoute.MatchString(route) {
		route = ""
	}
	if !s.limiter.Allow(limitClientError, "client_error:"+rateKey) {
		return nil
	}
	sum := sha256.Sum256([]byte(kind + "\n" + message + "\n" + location))
	fingerprint := hex.EncodeToString(sum[:8])
	day := SaigonDay(time.Now())
	tag, err := s.pool.Exec(ctx, `
		UPDATE client_errors SET count = count + 1, last_seen = now(), release = $4, route = $5
		WHERE tenant_id = $1 AND day = $2 AND fingerprint = $3`, s.cfg.TenantID, day, fingerprint, release, route)
	if err != nil {
		return fmt.Errorf("chat: count client error: %w", err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO client_errors (tenant_id, day, fingerprint, kind, message, location, release, route)
		SELECT $1, $2, $3, $4, $5, $6, $7, $8
		WHERE (SELECT count(*) FROM client_errors WHERE tenant_id = $1 AND day = $2) < $9
		ON CONFLICT (tenant_id, day, fingerprint) DO UPDATE SET count = client_errors.count + 1, last_seen = now(),
			release = excluded.release, route = excluded.route`,
		s.cfg.TenantID, day, fingerprint, kind, message, location, release, route, clientErrorKindsPerDay); err != nil {
		return fmt.Errorf("chat: record client error: %w", err)
	}
	return nil
}
