package webpush

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"app.local/server/internal/webpush/webpushtest"
)

func b64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.RawURLEncoding.DecodeString(strings.ReplaceAll(s, " ", ""))
	if err != nil {
		t.Fatalf("decode %q: %v", s, err)
	}
	return b
}

// TestEncryptRFC8291Example reproduces the example of RFC 8291 section 5
// and Appendix A byte for byte.
func TestEncryptRFC8291Example(t *testing.T) {
	asPrivate, err := ecdh.P256().NewPrivateKey(b64(t, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"))
	if err != nil {
		t.Fatal(err)
	}
	keys := Keys{
		P256DH: b64(t, "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
		Auth:   b64(t, "BTBZMqHH6r4Tts7J_aSIgg"),
	}
	got, err := encrypt(b64(t, "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"), keys, asPrivate,
		b64(t, "DGv6ra1nlYgDCS1FRnbzlw"), 0)
	if err != nil {
		t.Fatal(err)
	}
	header := b64(t, "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8")
	ciphertext := b64(t, "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ")
	if want := append(header, ciphertext...); !bytes.Equal(got, want) {
		t.Fatalf("message differs from RFC 8291:\n got %x\nwant %x", got, want)
	}
}

// browser is the receiving side of a subscription, as a test decrypts.
type browser struct {
	webpushtest.Browser
	keys Keys
}

func newBrowser(t *testing.T) browser {
	t.Helper()
	b, err := webpushtest.NewBrowser()
	if err != nil {
		t.Fatal(err)
	}
	return browser{Browser: b, keys: Keys{P256DH: b.P256DH, Auth: b.Auth}}
}

// decrypt returns the payload of message, checking the header Encrypt writes.
func (b browser) decrypt(t *testing.T, message []byte) []byte {
	t.Helper()
	payload, header, err := b.Decrypt(message)
	if err != nil {
		t.Fatal(err)
	}
	if header.RecordSize != MessageMax || header.KeyIDLen != PublicKeyLen {
		t.Fatalf("header %+v", header)
	}
	return payload
}

func TestEncryptRoundTripAndPadding(t *testing.T) {
	b := newBrowser(t)
	payload := []byte(`{"title":"Lan Anh","body":"Mình gửi file thiết kế rồi nhé"}`)
	plainLen := func(m []byte) int { return len(m) - headerLen - tagLen }
	unpadded, err := Encrypt(payload, b.keys, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := b.decrypt(t, unpadded); !bytes.Equal(got, payload) {
		t.Fatalf("payload %q", got)
	}
	if plainLen(unpadded) != len(payload)+1 {
		t.Fatalf("unpadded record of %d bytes", plainLen(unpadded))
	}
	padded, err := Encrypt(payload, b.keys, 128)
	if err != nil {
		t.Fatal(err)
	}
	if plainLen(padded)%128 != 0 {
		t.Fatalf("padded record of %d bytes", plainLen(padded))
	}
	if got := b.decrypt(t, padded); !bytes.Equal(got, payload) {
		t.Fatalf("padded payload %q", got)
	}
	// Two encryptions of the same payload differ (fresh key and salt).
	again, _ := Encrypt(payload, b.keys, 0)
	if bytes.Equal(again, unpadded) {
		t.Fatal("encryption is not randomized")
	}
	largest, err := Encrypt(make([]byte, PayloadMax), b.keys, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(largest) != MessageMax {
		t.Fatalf("largest message is %d bytes, want %d", len(largest), MessageMax)
	}
	if _, err := Encrypt(make([]byte, PayloadMax+1), b.keys, 0); err != ErrPayloadTooLarge {
		t.Fatalf("oversized payload: %v", err)
	}
}

func TestKeysValidate(t *testing.T) {
	good := newBrowser(t).keys
	if err := good.Validate(); err != nil {
		t.Fatal(err)
	}
	notOnCurve := bytes.Clone(good.P256DH)
	notOnCurve[64] ^= 1
	for name, k := range map[string]Keys{
		"short auth":   {P256DH: good.P256DH, Auth: good.Auth[:15]},
		"short key":    {P256DH: good.P256DH[:33], Auth: good.Auth},
		"not on curve": {P256DH: notOnCurve, Auth: good.Auth},
	} {
		if err := k.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func newTestVAPID(t *testing.T) *VAPID {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	v, err := NewVAPID(key, "https://chat.example.test")
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// verifyVAPID checks an Authorization header against the key and returns
// its claims.
func verifyVAPID(t *testing.T, header string, publicKey []byte) map[string]any {
	t.Helper()
	rest, ok := strings.CutPrefix(header, "vapid t=")
	if !ok {
		t.Fatalf("header %q", header)
	}
	jwt, k, ok := strings.Cut(rest, ", k=")
	if !ok || k != base64.RawURLEncoding.EncodeToString(publicKey) {
		t.Fatalf("header key: %q", header)
	}
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("jwt %q", jwt)
	}
	if string(b64(t, parts[0])) != `{"typ":"JWT","alg":"ES256"}` {
		t.Fatalf("jwt header %s", b64(t, parts[0]))
	}
	pub, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), publicKey)
	if err != nil {
		t.Fatal(err)
	}
	sig := b64(t, parts[2])
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if len(sig) != 64 || !ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("VAPID signature does not verify")
	}
	var claims map[string]any
	if err = json.Unmarshal(b64(t, parts[1]), &claims); err != nil {
		t.Fatal(err)
	}
	return claims
}

func TestVAPID(t *testing.T) {
	v := newTestVAPID(t)
	now := time.Unix(1_800_000_000, 0)
	h, err := v.Authorization("https://fcm.googleapis.com", now)
	if err != nil {
		t.Fatal(err)
	}
	claims := verifyVAPID(t, h, v.PublicKey())
	if claims["aud"] != "https://fcm.googleapis.com" || claims["sub"] != "https://chat.example.test" ||
		claims["exp"] != float64(now.Add(tokenTTL).Unix()) {
		t.Fatalf("claims %v", claims)
	}
	if again, _ := v.Authorization("https://fcm.googleapis.com", now.Add(time.Hour)); again != h {
		t.Fatal("token not reused while fresh")
	}
	if later, _ := v.Authorization("https://fcm.googleapis.com", now.Add(tokenTTL-tokenRenew/2)); later == h {
		t.Fatal("token reused close to its expiry")
	}
	if other, _ := v.Authorization("https://web.push.apple.com", now); other == h {
		t.Fatal("token shared between audiences")
	}
}

func TestParseVAPIDKey(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := key.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	for _, encoded := range []string{base64.RawURLEncoding.EncodeToString(raw), base64.URLEncoding.EncodeToString(raw) + "\n"} {
		parsed, err := ParseVAPIDKey(encoded)
		if err != nil {
			t.Fatal(err)
		}
		if !parsed.Equal(key) {
			t.Fatal("parsed key differs")
		}
	}
	secret := base64.RawURLEncoding.EncodeToString(raw)
	for _, bad := range []string{"", "not base64!", base64.RawURLEncoding.EncodeToString(raw[:31]), secret + "AAAA"} {
		_, err := ParseVAPIDKey(bad)
		if err == nil {
			t.Errorf("%q accepted", bad)
			continue
		}
		if strings.Contains(err.Error(), secret) {
			t.Error("error contains the key")
		}
	}
	if _, err := NewVAPID(key, "chat.example.test"); err == nil {
		t.Error("subject without scheme accepted")
	}
}

func TestCheckEndpoint(t *testing.T) {
	ok := []string{
		"https://fcm.googleapis.com/fcm/send/abc:APA91b",
		"https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
		"https://web.push.apple.com/QGuQyavXutnMH",
		"https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
		"https://FCM.googleapis.com:443/fcm/send/x",
	}
	for _, raw := range ok {
		if _, err := CheckEndpoint(raw, false); err != nil {
			t.Errorf("%s refused: %v", raw, err)
		}
	}
	bad := []string{
		"",
		"http://fcm.googleapis.com/fcm/send/x",
		"https://fcm.googleapis.com:8443/fcm/send/x",
		"https://user:pw@fcm.googleapis.com/fcm/send/x",
		"https://fcm.googleapis.com.evil.test/x",
		"https://fcm.googleapis.com./x",
		"https://evil.test/fcm.googleapis.com",
		"https://notify.windows.com/x",
		"https://a.b.notify.windows.com/x",
		"https://127.0.0.1/x",
		"https://169.254.169.254/latest/meta-data",
		"https://fcm.googleapis.com/x#frag",
		"https://" + strings.Repeat("a", EndpointMax),
		"http://127.0.0.1:9000/push",
	}
	for _, raw := range bad {
		if _, err := CheckEndpoint(raw, false); err == nil {
			t.Errorf("%s accepted", raw)
		}
	}
	for _, raw := range []string{"http://127.0.0.1:9000/push", "http://localhost:9000/push", "http://[::1]:9000/p"} {
		if _, err := CheckEndpoint(raw, true); err != nil {
			t.Errorf("%s refused with local endpoints allowed: %v", raw, err)
		}
	}
	if _, err := CheckEndpoint("http://10.0.0.1:9000/push", true); err == nil {
		t.Error("private address accepted as local")
	}
}

// pushService is a TLS server answering for the push service hosts.
type pushService struct {
	mu       sync.Mutex
	requests []*http.Request
	bodies   [][]byte
	status   int
}

func (p *pushService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	p.mu.Lock()
	p.requests = append(p.requests, r)
	p.bodies = append(p.bodies, body)
	status := p.status
	p.mu.Unlock()
	if status == http.StatusFound {
		http.Redirect(w, r, "https://fcm.googleapis.com/elsewhere", status)
		return
	}
	w.WriteHeader(status)
}

// routedClient trusts srv and dials it for every host, so requests keep
// the push service's URL and the allowlist stays in force.
func routedClient(srv *httptest.Server) *http.Client {
	transport := srv.Client().Transport.(*http.Transport).Clone()
	addr := srv.Listener.Addr().String()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}
	transport.TLSClientConfig = &tls.Config{RootCAs: srv.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs,
		ServerName: "example.com"}
	return &http.Client{Transport: transport}
}

func TestSender(t *testing.T) {
	ps := &pushService{status: http.StatusCreated}
	srv := httptest.NewTLSServer(ps)
	defer srv.Close()
	v := newTestVAPID(t)
	sender, err := NewSender(v, SenderOptions{Client: routedClient(srv), PadTo: 64})
	if err != nil {
		t.Fatal(err)
	}
	b := newBrowser(t)
	ctx := context.Background()
	endpoint := "https://fcm.googleapis.com/fcm/send/sub-1"
	msg := Message{Payload: []byte(`{"chat_id":1}`), TTL: 24 * time.Hour, Urgency: UrgencyHigh, Topic: "c1"}
	res, err := sender.Send(ctx, endpoint, b.keys, msg)
	if err != nil || res.Outcome != Delivered || res.Status != http.StatusCreated {
		t.Fatalf("send: %+v, %v", res, err)
	}
	req, body := ps.requests[0], ps.bodies[0]
	if req.URL.Path != "/fcm/send/sub-1" || req.Header.Get("Content-Encoding") != "aes128gcm" || req.Header.Get("TTL") != "86400" ||
		req.Header.Get("Urgency") != "high" || req.Header.Get("Topic") != "c1" {
		t.Fatalf("request %s %v", req.URL, req.Header)
	}
	claims := verifyVAPID(t, req.Header.Get("Authorization"), v.PublicKey())
	if claims["aud"] != "https://fcm.googleapis.com" {
		t.Fatalf("aud %v", claims["aud"])
	}
	if got := b.decrypt(t, body); string(got) != `{"chat_id":1}` {
		t.Fatalf("payload %q", got)
	}

	for status, want := range map[int]Outcome{
		http.StatusNotFound: Gone, http.StatusGone: Gone, http.StatusForbidden: Rejected, http.StatusBadRequest: Rejected,
		http.StatusTooManyRequests: Throttled, http.StatusServiceUnavailable: Failed, http.StatusFound: Failed,
	} {
		ps.mu.Lock()
		ps.status = status
		ps.mu.Unlock()
		res, err := sender.Send(ctx, endpoint, b.keys, msg)
		if err != nil || res.Outcome != want {
			t.Errorf("status %d: %+v, %v", status, res, err)
		}
	}
	ps.mu.Lock()
	sent := len(ps.requests)
	ps.mu.Unlock()
	if sent != 8 {
		t.Fatalf("%d requests; a redirect must not be followed", sent)
	}

	if _, err := sender.Send(ctx, "https://evil.test/push", b.keys, msg); err == nil {
		t.Fatal("sent to an unknown host")
	}
	if _, err := sender.Send(ctx, endpoint, b.keys, Message{Topic: "chat:1"}); err == nil {
		t.Fatal("invalid topic accepted")
	}
	srv.Close()
	res, err = sender.Send(ctx, endpoint, b.keys, msg)
	if err != nil || res.Outcome != Failed || res.Status != 0 {
		t.Fatalf("unreachable push service: %+v, %v", res, err)
	}
}
