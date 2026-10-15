package botadmin

import "time"

// SetClock replaces the service's clock; call it before the service is used.
func (s *Service) SetClock(now func() time.Time) { s.now = now }
