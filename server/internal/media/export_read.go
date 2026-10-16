package media

import (
	"context"
	"io"
)

// ReadOriginal opens the stored original of f (personal data exports copy
// it into the ZIP); the caller closes it.
func (s *Service) ReadOriginal(ctx context.Context, f *File) (io.ReadCloser, error) {
	return s.objects.Get(ctx, f.Key, 0, -1)
}
