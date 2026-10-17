package chatbot

import (
	"fmt"
	"net/http"
)

// APIError is an answer of the Bot API with "ok": false, or an answer that is
// not an envelope at all (a proxy error page, for example; Code is then
// empty). Branch on Code, never on Description.
//
// Use errors.As to read it:
//
//	var apiErr *chatbot.APIError
//	if errors.As(err, &apiErr) && apiErr.Code == "no_consent" { ... }
type APIError struct {
	// Status is the HTTP status code of the answer.
	Status int
	// Code is the stable error code, such as "rate_limited" or "conflict".
	Code string
	// Description is human-readable detail; do not parse it.
	Description string
	// RetryAfter is the number of seconds to wait before retrying, 0 when the
	// server gave none.
	RetryAfter int
}

// Error describes the failure without any request data (never the token).
func (e *APIError) Error() string {
	code := e.Code
	if code == "" {
		code = http.StatusText(e.Status)
	}
	if e.Description == "" {
		return fmt.Sprintf("chatbot: %d %s", e.Status, code)
	}
	return fmt.Sprintf("chatbot: %d %s: %s", e.Status, code, e.Description)
}

// retryable reports whether the contract allows retrying the request: only
// rate limits and temporary unavailability are retried.
func (e *APIError) retryable() bool {
	return (e.Status == http.StatusTooManyRequests && e.Code == "rate_limited") ||
		e.Status == http.StatusServiceUnavailable
}
