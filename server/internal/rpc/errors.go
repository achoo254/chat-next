package rpc

import (
	"context"
	"errors"
	"log/slog"

	"connectrpc.com/connect"
)

// fail passes the chat service's client errors (connect errors with a
// code) through and turns anything else into an opaque Internal error.
func fail(ctx context.Context, logger *slog.Logger, procedure string, err error) error {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return ce
	}
	return internal(ctx, logger, procedure, err)
}
