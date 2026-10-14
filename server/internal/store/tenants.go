package store

import (
	"context"
	"fmt"
)

// EnsureTenant creates the tenant row, or updates its domain and display
// name when it already exists. The API role calls it at start for the
// statically configured tenant.
func (s *Store) EnsureTenant(ctx context.Context, id, domain, displayName string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO tenants (id, domain, display_name) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET domain = EXCLUDED.domain, display_name = EXCLUDED.display_name`,
		id, domain, displayName)
	if err != nil {
		return fmt.Errorf("store: ensure tenant: %w", err)
	}
	return nil
}
