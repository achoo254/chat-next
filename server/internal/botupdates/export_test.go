package botupdates

import "time"

// SetBeforeAck makes the dispatcher abandon a request after its answer's
// action and before the acknowledgement whenever fn returns true, as if
// the process died there. Call it before the bot's webhook is set.
func SetBeforeAck(s *Service, fn func(botID, updateID int64) bool) {
	s.webhooks.beforeAck = fn
}

// SetRetryFloor shortens the minimum wait before another attempt (the
// Retry-After floor); call it before the bot's webhook is set.
func SetRetryFloor(s *Service, d time.Duration) {
	s.webhooks.retryFloor = d
}

// HeadsQuery is the dispatcher's read of the queue heads ($1 bot, $2 limit).
const HeadsQuery = headsQuery

// WorkerReads is how many rounds of database reads the webhook workers did.
func WorkerReads(s *Service) int64 {
	return s.webhooks.reads.Load()
}
