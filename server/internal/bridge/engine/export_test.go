package engine

import "time"

// SetMaxInlineWait lets a test make a short wait count as a long one. Call it before the
// engine starts and restore after it stopped (register it as the first cleanup).
func SetMaxInlineWait(d time.Duration) (restore func()) {
	old := maxInlineWait
	maxInlineWait = d
	return func() { maxInlineWait = old }
}
