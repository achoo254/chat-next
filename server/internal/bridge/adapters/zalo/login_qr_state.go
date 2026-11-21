package zalo

import (
	"bytes"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"app.local/server/internal/bridge"
)

// maxQRRefresh is how many times an expired QR code (about 100 s each) is
// replaced by a new one before the login gives up.
const maxQRRefresh = 3

// maxQRImageBytes bounds a decoded QR image.
const maxQRImageBytes = 256 << 10

var pngMagic = []byte("\x89PNG\r\n\x1a\n")

// qrLogin is a QR login between two Login calls: its sidecar waits for the
// phone to scan and confirm. The engine calls Login for one login at a time;
// mu also guards against the expiry timer.
type qrLogin struct {
	mu        sync.Mutex
	side      *sidecar
	image     string // data: URL of the current QR code
	scanned   bool
	session   []byte // set by logged_in, canonical
	refreshes int
	timer     *time.Timer
}

func (l *qrLogin) close() {
	if l.timer != nil {
		l.timer.Stop()
	}
	if l.side != nil {
		l.side.stop()
	}
}

// step is what the user sees while nothing new happened.
func (l *qrLogin) step(id string) bridge.LoginStep {
	if l.scanned || l.session != nil {
		return bridge.LoginStep{Kind: bridge.StepConfirm, Token: id, Prompt: "Confirm the login in Zalo on your phone."}
	}
	return bridge.LoginStep{Kind: bridge.StepQR, Token: id, Prompt: l.image}
}

// qrDataURL checks the QR image (base64 PNG, bounded) and returns it as a
// data: URL the client can show as is.
func qrDataURL(b64 string) (string, error) {
	if len(b64) == 0 || base64.StdEncoding.DecodedLen(len(b64)) > maxQRImageBytes {
		return "", errors.New("zalo: QR image missing or too large")
	}
	img, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || !bytes.HasPrefix(img, pngMagic) {
		return "", errors.New("zalo: QR image is not a PNG")
	}
	return "data:image/png;base64," + b64, nil
}
