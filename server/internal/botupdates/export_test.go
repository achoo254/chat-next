package botupdates

// SetBeforeAck makes the dispatcher abandon a request after its answer's
// action and before the acknowledgement whenever fn returns true, as if
// the process died there. Call it before the bot's webhook is set.
func SetBeforeAck(s *Service, fn func(botID, updateID int64) bool) {
	s.webhooks.beforeAck = fn
}
