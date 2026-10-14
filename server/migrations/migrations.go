// Package migrations embeds the SQL migrations applied by `server -role
// migrate` (goose format, one numbered file per step).
package migrations

import "embed"

// FS holds every *.sql migration of the schema.
//
//go:embed *.sql
var FS embed.FS
