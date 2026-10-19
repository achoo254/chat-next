package api_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/api"
	"app.local/server/internal/config"
	"app.local/server/internal/media"
	"app.local/server/internal/media/s3test"
	"connectrpc.com/connect"
)

const (
	mediaHost = "media.test"
	gpsMarker = "GPS-21.0285N-105.8542E-marker"
)

type mediaEnv struct {
	*env
	s3   *s3test.Server // nil with filesystem storage
	root string         // filesystem storage root
}

// newMediaEnv is an env with media on a temporary directory (the
// production setup), or with storage "s3" on an in-process S3 fake.
func newMediaEnv(t *testing.T, storage string, mod func(*config.Media), more ...func(*config.Config, *api.Options)) *mediaEnv {
	t.Helper()
	me := &mediaEnv{}
	var objects media.Objects
	if storage == config.StorageS3 {
		me.s3 = s3test.New(t, "chat-media")
		s3, err := media.NewS3(media.S3Config{
			Endpoint: mustURL(t, me.s3.URL), Region: "hn-storage", Bucket: "chat-media", AccessKey: "k", SecretKey: "s", PathStyle: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		objects = s3
	} else {
		me.root = t.TempDir()
		fsys, err := media.NewFilesystem(me.root)
		if err != nil {
			t.Fatal(err)
		}
		objects = fsys
	}
	me.env = newEnv(t, func(c *config.Config, o *api.Options) {
		c.Media = &config.Media{
			Storage: storage, Root: me.root, PublicURL: mustURL(t, "https://"+mediaHost), UploadMaxBytes: 64 << 20,
			UserQuotaBytes: 128 << 20, UploadMode: config.UploadProxy,
		}
		if storage == config.StorageS3 {
			c.Media.UploadMode = config.UploadDirect
		}
		if mod != nil {
			mod(c.Media)
		}
		o.MediaObjects = objects
		for _, m := range more {
			m(c, o)
		}
	})
	return me
}

// objects returns every stored object by key.
func (e *mediaEnv) objects(t *testing.T) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	if e.s3 != nil {
		for _, k := range e.s3.Keys() {
			out[k], _ = e.s3.Object(k)
		}
		return out
	}
	base := filepath.Join(e.root, "objects")
	err := filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(base, path)
		out[filepath.ToSlash(rel)] = b
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Mode().Perm()&0o007 != 0 {
			t.Errorf("%s is world-accessible: %v", rel, info.Mode())
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func (m *chatClients) media(e *env) appv1connect.MediaServiceClient {
	return appv1connect.NewMediaServiceClient(m.http, e.srv.URL+"/rpc", withOrigin(e.srv.URL))
}

// fetch sends a request for a media-host URL to the test server with the
// media host's name, like nginx does.
func (e *mediaEnv) fetch(t *testing.T, method, rawURL string, header http.Header, body []byte) *http.Response {
	t.Helper()
	u := mustURL(t, rawURL)
	if u.Host != mediaHost {
		t.Fatalf("URL %s is not on the media host", rawURL)
	}
	req, err := http.NewRequestWithContext(t.Context(), method, e.srv.URL+u.Path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Host = mediaHost
	for k, v := range header {
		req.Header[k] = v
	}
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func hashOf(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// upload runs CreateUpload, PUTs every part to its URL and completes.
func (e *mediaEnv) upload(t *testing.T, m *chatClients, kind appv1.MediaKind, name string, data []byte, thumb []byte) (*appv1.MediaRef, error) {
	t.Helper()
	ctx := t.Context()
	cl := m.media(e.env)
	created, err := cl.CreateUpload(ctx, connect.NewRequest(&appv1.CreateUploadRequest{
		Kind: kind, FileName: name, Size: int64(len(data)), FileHash: hashOf(data), InlineThumb: thumb,
	}))
	if err != nil {
		return nil, err
	}
	if ex := created.Msg.GetExisting(); ex != nil {
		return ex, nil
	}
	session := created.Msg.GetUpload()
	var parts []*appv1.CompletedPart
	for _, p := range session.GetParts() {
		start := int64(p.GetPartNumber()-1) * session.GetPartSize()
		end := min(start+session.GetPartSize(), int64(len(data)))
		etag := e.putPart(t, p.GetUrl(), data[start:end])
		parts = append(parts, &appv1.CompletedPart{PartNumber: p.GetPartNumber(), Etag: etag})
	}
	done, err := cl.CompleteUpload(ctx, connect.NewRequest(&appv1.CompleteUploadRequest{UploadId: session.GetUploadId(), Parts: parts}))
	if err != nil {
		return nil, err
	}
	return done.Msg.GetMedia(), nil
}

// putPart uploads one part like a browser: plain PUT, ETag from the
// response.
func (e *mediaEnv) putPart(t *testing.T, rawURL string, body []byte) string {
	t.Helper()
	var resp *http.Response
	if strings.Contains(rawURL, mediaHost) {
		resp = e.fetch(t, http.MethodPut, rawURL, nil, body)
	} else {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPut, rawURL, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if resp, err = http.DefaultClient.Do(req); err != nil {
			t.Fatal(err)
		}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("ETag") == "" {
		t.Fatalf("PUT part: %d %s", resp.StatusCode, readBody(t, resp))
	}
	return resp.Header.Get("ETag")
}

// photoWithGPS is a JPEG with EXIF (orientation 6 and secret text) and
// bytes appended after its end.
func photoWithGPS(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 90, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	desc := []byte(gpsMarker + "\x00")
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8, 0, 2, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0x01, 0x0E, 0, 2}
	tiff = binary.BigEndian.AppendUint32(tiff, uint32(len(desc)))
	tiff = binary.BigEndian.AppendUint32(tiff, 38)
	tiff = append(append(tiff, 0, 0, 0, 0), desc...)
	payload := append([]byte("Exif\x00\x00"), tiff...)
	seg := binary.BigEndian.AppendUint16([]byte{0xFF, 0xE1}, uint16(len(payload)+2))
	b := buf.Bytes()
	out := append(append(append([]byte{}, b[:2]...), seg...), payload...)
	return append(append(out, b[2:]...), gpsMarker...)
}

func pngChunk(typ string, data []byte) []byte {
	c := binary.BigEndian.AppendUint32(nil, uint32(len(data)))
	c = append(append(c, typ...), data...)
	return binary.BigEndian.AppendUint32(c, crc32.ChecksumIEEE(append([]byte(typ), data...)))
}

func pngBomb() []byte {
	ihdr := binary.BigEndian.AppendUint32(binary.BigEndian.AppendUint32(nil, 40000), 40000)
	out := append([]byte("\x89PNG\r\n\x1a\n"), pngChunk("IHDR", append(ihdr, 8, 6, 0, 0, 0))...)
	out = append(out, pngChunk("IDAT", []byte{0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01})...)
	return append(out, pngChunk("IEND", nil)...)
}

func privateChat(t *testing.T, a, b *chatClients) int64 {
	t.Helper()
	resp, err := a.chats.CreatePrivate(t.Context(), connect.NewRequest(&appv1.CreatePrivateRequest{UserId: b.userID}))
	if err != nil {
		t.Fatal(err)
	}
	return resp.Msg.GetChat().GetId()
}

func fileURL(t *testing.T, m *chatClients, e *env, ref *appv1.MediaRef, chatID, seq int64, size appv1.MediaSizeType) *appv1.FileUrlResult {
	t.Helper()
	resp, err := m.media(e).GetFileUrls(t.Context(), connect.NewRequest(&appv1.GetFileUrlsRequest{Requests: []*appv1.GetFileUrlRequest{{
		FileId: ref.GetFileId(), Size: size,
		Context: &appv1.GetFileUrlRequest_Message{Message: &appv1.MessageFileContext{ChatId: chatID, Seq: seq}},
	}}}))
	if err != nil {
		t.Fatal(err)
	}
	return resp.Msg.GetResults()[0]
}

func TestMediaPhotoUploadSendDownloadRevoke(t *testing.T) {
	e := newMediaEnv(t, config.StorageFilesystem, nil)
	alice, bob, carol := e.member(t, "alice"), e.member(t, "bob"), e.member(t, "carol")
	ctx := t.Context()
	cfg, err := alice.config.GetAppConfig(ctx, connect.NewRequest(&appv1.GetAppConfigRequest{}))
	if err != nil || cfg.Msg.GetConfig().GetUploadSizeMaxBytes() != 64<<20 {
		t.Fatalf("app config: %v %v", cfg, err)
	}

	photo := photoWithGPS(t, 1600, 900)
	ref, err := e.upload(t, alice, appv1.MediaKind_MEDIA_KIND_PHOTO, "IMG_0001.jpg", photo, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Orientation 6: displayed portrait.
	if ref.GetWidth() != 900 || ref.GetHeight() != 1600 || ref.GetMimeType() != "image/jpeg" || len(ref.GetSizes()) != 3 ||
		len(ref.GetInlineThumb()) == 0 || ref.GetFileName() != "IMG_0001.jpg" {
		t.Fatalf("ref = %+v", ref)
	}
	if ref.GetFileHash() == hashOf(photo) {
		t.Fatal("hash of the unstripped upload")
	}
	// Nothing left in staging; the stored original has no metadata.
	stored := e.objects(t)
	if len(stored) != 4 {
		t.Fatalf("stored %d objects, want original and 3 renditions", len(stored))
	}
	for k, obj := range stored {
		if strings.HasPrefix(k, "staging/") {
			t.Fatalf("staging object left: %s", k)
		}
		if bytes.Contains(obj, []byte(gpsMarker)) {
			t.Fatalf("object %s still holds the metadata", k)
		}
	}
	// Dedupe: the same content again needs no upload.
	again, err := alice.media(e.env).CreateUpload(ctx, connect.NewRequest(&appv1.CreateUploadRequest{
		Kind: appv1.MediaKind_MEDIA_KIND_PHOTO, Size: int64(len(photo)), FileHash: hashOf(photo)}))
	if err != nil || again.Msg.GetExisting().GetFileId() != ref.GetFileId() {
		t.Fatalf("dedupe: %v %v", again, err)
	}
	// Bob uploading the same bytes gets his own file (no cross-owner dedupe).
	bobRef, err := e.upload(t, bob, appv1.MediaKind_MEDIA_KIND_PHOTO, "", photo, nil)
	if err != nil || bobRef.GetFileId() == ref.GetFileId() {
		t.Fatalf("cross-owner dedupe: %v %v", bobRef, err)
	}

	chatID := privateChat(t, alice, bob)
	sent, err := alice.messages.SendMedia(ctx, connect.NewRequest(&appv1.SendMediaRequest{
		ChatId: chatID, FileId: ref.GetFileId(), Text: "Hà Nội", RandomId: 77}))
	if err != nil {
		t.Fatal(err)
	}
	msg := sent.Msg.GetMessage()
	if msg.GetMedia().GetFileId() != ref.GetFileId() || msg.GetText() != "Hà Nội" {
		t.Fatalf("sent = %+v", msg)
	}
	// Retry with the same random_id: same message.
	retry, err := alice.messages.SendMedia(ctx, connect.NewRequest(&appv1.SendMediaRequest{
		ChatId: chatID, FileId: ref.GetFileId(), Text: "Hà Nội", RandomId: 77}))
	if err != nil || retry.Msg.GetMessage().GetSeq() != msg.GetSeq() {
		t.Fatalf("retry: %v %v", retry, err)
	}

	// Carol is not in the chat: no URL, and she cannot send alice's file.
	if r := fileURL(t, carol, e.env, ref, chatID, msg.GetSeq(), 0); !r.GetUnavailable() {
		t.Fatal("non-member got a URL")
	}
	carolChat := privateChat(t, carol, bob)
	if _, err := carol.messages.SendMedia(ctx, connect.NewRequest(&appv1.SendMediaRequest{
		ChatId: carolChat, FileId: ref.GetFileId()})); codeOf(err) != connect.CodeNotFound {
		t.Fatalf("foreign file_id: %v", err)
	}

	// Bob downloads the M rendition and ranges of the original.
	m := fileURL(t, bob, e.env, ref, chatID, msg.GetSeq(), appv1.MediaSizeType_MEDIA_SIZE_TYPE_M)
	if m.GetUnavailable() || m.GetSize() != appv1.MediaSizeType_MEDIA_SIZE_TYPE_M || m.GetExpiresAt() <= time.Now().Unix() {
		t.Fatalf("url = %+v", m)
	}
	resp := e.fetch(t, http.MethodGet, m.GetUrl(), nil, nil)
	body := readBody(t, resp)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "image/jpeg" ||
		resp.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.HasPrefix(resp.Header.Get("Content-Disposition"), "inline") ||
		resp.Header.Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(resp.Header.Get("Cache-Control"), "s-maxage=50") {
		t.Fatalf("download: %d %v", resp.StatusCode, resp.Header)
	}
	if cfgM, err := jpeg.DecodeConfig(strings.NewReader(body)); err != nil || cfgM.Width != 450 || cfgM.Height != 800 {
		t.Fatalf("M rendition: %v %v", cfgM, err)
	}
	orig := fileURL(t, bob, e.env, ref, chatID, msg.GetSeq(), 0)
	resp = e.fetch(t, http.MethodGet, orig.GetUrl(), http.Header{"Range": {"bytes=0-99"}}, nil)
	part := readBody(t, resp)
	if resp.StatusCode != http.StatusPartialContent || len(part) != 100 ||
		resp.Header.Get("Content-Range") != "bytes 0-99/"+strconv.FormatInt(ref.GetSize(), 10) {
		t.Fatalf("range: %d %q", resp.StatusCode, resp.Header.Get("Content-Range"))
	}
	resp = e.fetch(t, http.MethodGet, orig.GetUrl(), http.Header{"Range": {"bytes=999999999-"}}, nil)
	if _ = readBody(t, resp); resp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("bad range: %d", resp.StatusCode)
	}
	// A media URL on the app's host does not exist; the app on the media
	// host neither.
	appResp, err := e.srv.Client().Get(e.srv.URL + mustURL(t, orig.GetUrl()).Path)
	if err != nil {
		t.Fatal(err)
	}
	if _ = readBody(t, appResp); appResp.StatusCode == http.StatusOK {
		t.Fatal("media served on the app host")
	}
	if resp := e.fetch(t, http.MethodGet, "https://"+mediaHost+"/healthz", nil, nil); readBody(t, resp) == "" || resp.StatusCode != 200 {
		t.Fatalf("media healthz: %d", resp.StatusCode)
	}
	if resp := e.fetch(t, http.MethodGet, "https://"+mediaHost+"/rpc/app.v1.UsersService/GetSelf", nil, nil); resp.StatusCode != http.StatusNotFound &&
		resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("app route on media host: %d", resp.StatusCode)
	}
	// A tampered token is unknown.
	tampered := orig.GetUrl()[:len(orig.GetUrl())-3] + "AAA"
	if resp := e.fetch(t, http.MethodGet, tampered, nil, nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("tampered: %d", resp.StatusCode)
	}

	// Bob forwards it to carol: no re-upload, carol may read it there.
	fwd, err := bob.messages.ForwardMessages(ctx, connect.NewRequest(&appv1.ForwardMessagesRequest{
		FromChatId: chatID, Seqs: []int64{msg.GetSeq()}, ToChatId: carolChat}))
	if err != nil {
		t.Fatal(err)
	}
	fm := fwd.Msg.GetMessages()[0]
	if fm.GetMedia().GetFileId() != ref.GetFileId() {
		t.Fatal("forward lost the file")
	}
	if r := fileURL(t, carol, e.env, ref, carolChat, fm.GetSeq(), 0); r.GetUnavailable() {
		t.Fatal("carol cannot read the forwarded file")
	}

	// Recall: the URL stops working (authorizations are cached 5 s).
	if _, err := alice.messages.DeleteMessages(ctx, connect.NewRequest(&appv1.DeleteMessagesRequest{
		ChatId: chatID, Seqs: []int64{msg.GetSeq()}, ForEveryone: true})); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for {
		resp := e.fetch(t, http.MethodHead, orig.GetUrl(), nil, nil)
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("URL still works after recall: %d", resp.StatusCode)
		}
		time.Sleep(250 * time.Millisecond)
	}
	if r := fileURL(t, bob, e.env, ref, chatID, msg.GetSeq(), 0); !r.GetUnavailable() {
		t.Fatal("URL issued for a recalled message")
	}
	// The forwarded copy keeps working.
	if r := fileURL(t, carol, e.env, ref, carolChat, fm.GetSeq(), 0); r.GetUnavailable() {
		t.Fatal("recall revoked the forwarded copy")
	}
}

func TestMediaRefusesSpoofingBombsAndQuota(t *testing.T) {
	// S3 with presigned parts straight to the storage.
	e := newMediaEnv(t, config.StorageS3, func(m *config.Media) { m.UserQuotaBytes = 3 << 20 })
	alice := e.member(t, "alice")
	ctx := t.Context()
	html := []byte("<!DOCTYPE html><html><script>alert(document.cookie)</script></html>")
	if _, err := e.upload(t, alice, appv1.MediaKind_MEDIA_KIND_PHOTO, "x.jpg", html, nil); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("html as photo: %v", err)
	}
	if _, err := e.upload(t, alice, appv1.MediaKind_MEDIA_KIND_VIDEO, "v.mp4", photoWithGPS(t, 10, 10), nil); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("jpeg as video: %v", err)
	}
	if _, err := e.upload(t, alice, appv1.MediaKind_MEDIA_KIND_PHOTO, "bomb.png", pngBomb(), nil); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bomb: %v", err)
	}
	if n := e.s3.PendingUploads(); n != 0 || len(e.s3.Keys()) != 0 {
		t.Fatalf("refused uploads left %d uploads, objects %v", n, e.s3.Keys())
	}
	// HTML as a document is accepted but served as a binary attachment.
	doc, err := e.upload(t, alice, appv1.MediaKind_MEDIA_KIND_DOCUMENT, "page.html", html, nil)
	if err != nil || doc.GetMimeType() != "application/octet-stream" {
		t.Fatalf("document: %v %v", doc, err)
	}
	// Quota: 3 MiB in all.
	_, err = alice.media(e.env).CreateUpload(ctx, connect.NewRequest(&appv1.CreateUploadRequest{
		Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, Size: 4 << 20, FileHash: strings.Repeat("a", 64)}))
	if codeOf(err) != connect.CodeResourceExhausted {
		t.Fatalf("quota: %v", err)
	}
	// Size above the configured maximum.
	_, err = alice.media(e.env).CreateUpload(ctx, connect.NewRequest(&appv1.CreateUploadRequest{
		Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, Size: 65 << 20, FileHash: strings.Repeat("a", 64)}))
	if codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("max size: %v", err)
	}
	// Completing with a part missing asks to resume.
	created, err := alice.media(e.env).CreateUpload(ctx, connect.NewRequest(&appv1.CreateUploadRequest{
		Kind: appv1.MediaKind_MEDIA_KIND_DOCUMENT, Size: 10, FileHash: hashOf([]byte("0123456789"))}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = alice.media(e.env).CompleteUpload(ctx, connect.NewRequest(&appv1.CompleteUploadRequest{UploadId: created.Msg.GetUpload().GetUploadId()}))
	if codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("incomplete: %v", err)
	}
	// Wrong etag: the storage refuses, the client resumes.
	_, err = alice.media(e.env).CompleteUpload(ctx, connect.NewRequest(&appv1.CompleteUploadRequest{
		UploadId: created.Msg.GetUpload().GetUploadId(), Parts: []*appv1.CompletedPart{{PartNumber: 1, Etag: `"nope"`}}}))
	if codeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("bad etag: %v", err)
	}
	if _, err := alice.media(e.env).AbortUpload(ctx, connect.NewRequest(&appv1.AbortUploadRequest{
		UploadId: created.Msg.GetUpload().GetUploadId()})); err != nil {
		t.Fatal(err)
	}
}

// testMovie is ftyp, moov (12.5 s, a 1920x1080 track rotated 90 degrees,
// udta with a location) and an mdat of mdat bytes.
func testMovie(mdat int) []byte {
	b := func(typ string, parts ...[]byte) []byte {
		body := bytes.Join(parts, nil)
		return append(binary.BigEndian.AppendUint32(nil, uint32(8+len(body))), append([]byte(typ), body...)...)
	}
	mvhd := make([]byte, 100)
	binary.BigEndian.PutUint32(mvhd[12:], 1000)
	binary.BigEndian.PutUint32(mvhd[16:], 12500)
	tkhd := make([]byte, 84)
	binary.BigEndian.PutUint32(tkhd[44:], 0x00010000)
	binary.BigEndian.PutUint32(tkhd[52:], 0xFFFF0000)
	binary.BigEndian.PutUint32(tkhd[76:], 1920<<16)
	binary.BigEndian.PutUint32(tkhd[80:], 1080<<16)
	hdlr := make([]byte, 24)
	copy(hdlr[8:], "vide")
	moov := b("moov", b("mvhd", mvhd), b("trak", b("tkhd", tkhd), b("mdia", b("hdlr", hdlr))),
		b("udta", b("\xa9xyz", []byte(gpsMarker))))
	return append(append(b("ftyp", []byte("isom\x00\x00\x02\x00isomiso2mp41")), moov...), b("mdat", make([]byte, mdat))...)
}

func TestMediaLargeVideoProxyUploadAlbum(t *testing.T) {
	e := newMediaEnv(t, config.StorageS3, func(m *config.Media) { m.UploadMode = config.UploadProxy })
	alice, bob := e.member(t, "alice"), e.member(t, "bob")
	ctx := t.Context()
	// 17 MiB: three 8 MiB parts through the media host, and a rewrite in
	// two 16 MiB blocks (the patched one uploaded, the other copied).
	movie := testMovie(17 << 20)
	ref, err := e.upload(t, alice, appv1.MediaKind_MEDIA_KIND_VIDEO, "trip.mp4", movie, nil)
	if err != nil {
		t.Fatal(err)
	}
	if ref.GetDuration() != 12500 || ref.GetWidth() != 1080 || ref.GetHeight() != 1920 || ref.GetSize() != int64(len(movie)) {
		t.Fatalf("video ref = %+v", ref)
	}
	if e.s3.Count("PUT part") < 3 || e.s3.Count("PUT copy part") != 1 {
		t.Fatalf("parts %d, copied %d", e.s3.Count("PUT part"), e.s3.Count("PUT copy part"))
	}
	var stored []byte
	for _, k := range e.s3.Keys() {
		if obj, _ := e.s3.Object(k); len(obj) == len(movie) {
			stored = obj
		}
	}
	if stored == nil || bytes.Contains(stored, []byte("udta")) || !bytes.Equal(stored[len(stored)-1000:], movie[len(movie)-1000:]) {
		t.Fatal("stored movie wrong or metadata kept")
	}
	photo, err := e.upload(t, alice, appv1.MediaKind_MEDIA_KIND_PHOTO, "a.jpg", photoWithGPS(t, 40, 30), nil)
	if err != nil {
		t.Fatal(err)
	}
	chatID := privateChat(t, alice, bob)
	album, err := alice.messages.SendAlbum(ctx, connect.NewRequest(&appv1.SendAlbumRequest{ChatId: chatID, Items: []*appv1.AlbumItem{
		{FileId: photo.GetFileId(), Text: "one", RandomId: 1}, {FileId: ref.GetFileId(), RandomId: 2}}}))
	if err != nil {
		t.Fatal(err)
	}
	msgs := album.Msg.GetMessages()
	if len(msgs) != 2 || msgs[0].GetGroupedId() == 0 || msgs[0].GetGroupedId() != msgs[1].GetGroupedId() ||
		msgs[1].GetMedia().GetKind() != appv1.MediaKind_MEDIA_KIND_VIDEO {
		t.Fatalf("album = %v", msgs)
	}
	// Forwarded together, the copies form a new album; one forwarded alone is a single message.
	fwd, err := bob.messages.ForwardMessages(ctx, connect.NewRequest(&appv1.ForwardMessagesRequest{
		FromChatId: chatID, Seqs: []int64{msgs[0].GetSeq(), msgs[1].GetSeq()}, ToChatId: chatID}))
	if err != nil {
		t.Fatal(err)
	}
	copies := fwd.Msg.GetMessages()
	if len(copies) != 2 || copies[0].GetGroupedId() == 0 || copies[0].GetGroupedId() != copies[1].GetGroupedId() ||
		copies[0].GetGroupedId() == msgs[0].GetGroupedId() {
		t.Fatalf("forwarded album = %v", copies)
	}
	one, err := bob.messages.ForwardMessages(ctx, connect.NewRequest(&appv1.ForwardMessagesRequest{
		FromChatId: chatID, Seqs: []int64{msgs[0].GetSeq()}, ToChatId: chatID}))
	if err != nil || len(one.Msg.GetMessages()) != 1 || one.Msg.GetMessages()[0].GetGroupedId() != 0 {
		t.Fatalf("forwarded single = %v, %v", one, err)
	}
	// Bob streams the video with a Range from the middle.
	u := fileURL(t, bob, e.env, ref, chatID, msgs[1].GetSeq(), 0)
	resp := e.fetch(t, http.MethodGet, u.GetUrl(), http.Header{"Range": {"bytes=10485760-10485859"}}, nil)
	got := readBody(t, resp)
	if resp.StatusCode != http.StatusPartialContent || got != string(movie[10485760:10485860]) ||
		!strings.HasPrefix(resp.Header.Get("Content-Disposition"), "inline") {
		t.Fatalf("video range: %d", resp.StatusCode)
	}
	// Mixing a document into a photo album is refused.
	doc, err := e.upload(t, alice, appv1.MediaKind_MEDIA_KIND_DOCUMENT, "n.txt", []byte("notes"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := alice.messages.SendAlbum(ctx, connect.NewRequest(&appv1.SendAlbumRequest{ChatId: chatID, Items: []*appv1.AlbumItem{
		{FileId: photo.GetFileId()}, {FileId: doc.GetFileId()}}})); codeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("mixed album: %v", err)
	}
	// A document is an attachment.
	sent, err := alice.messages.SendMedia(ctx, connect.NewRequest(&appv1.SendMediaRequest{ChatId: chatID, FileId: doc.GetFileId()}))
	if err != nil {
		t.Fatal(err)
	}
	du := fileURL(t, bob, e.env, doc, chatID, sent.Msg.GetMessage().GetSeq(), 0)
	resp = e.fetch(t, http.MethodGet, du.GetUrl(), nil, nil)
	if body := readBody(t, resp); body != "notes" || !strings.HasPrefix(resp.Header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("document download: %q %v", body, resp.Header)
	}
	// Edit the caption to empty: allowed for media.
	if _, err := alice.messages.EditMessage(ctx, connect.NewRequest(&appv1.EditMessageRequest{ChatId: chatID, Seq: msgs[0].GetSeq()})); err != nil {
		t.Fatalf("empty caption: %v", err)
	}
}

func TestMediaWorkerWithFFmpeg(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	clip := dir + "/clip.mp4"
	voice := dir + "/voice.ogg"
	for _, args := range [][]string{
		{"-f", "lavfi", "-i", "testsrc=size=640x360:rate=10:duration=2", "-pix_fmt", "yuv420p", "-c:v", "mpeg4", clip},
		{"-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-c:a", "libopus", voice},
	} {
		cmd := exec.CommandContext(t.Context(), ffmpeg, append([]string{"-v", "error", "-y"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Skipf("ffmpeg cannot make test media: %v %s", err, out)
		}
	}
	e := newMediaEnv(t, config.StorageFilesystem, func(m *config.Media) { m.FFmpegPath = ffmpeg })
	alice, bob := e.member(t, "alice"), e.member(t, "bob")
	ctx := t.Context()
	chatID := privateChat(t, alice, bob)
	video, err := e.upload(t, alice, appv1.MediaKind_MEDIA_KIND_VIDEO, "clip.mp4", readFile(t, clip), nil)
	if err != nil {
		t.Fatal(err)
	}
	sent, err := alice.messages.SendMedia(ctx, connect.NewRequest(&appv1.SendMediaRequest{ChatId: chatID, FileId: video.GetFileId()}))
	if err != nil {
		t.Fatal(err)
	}
	voiceRef, err := e.upload(t, alice, appv1.MediaKind_MEDIA_KIND_VOICE, "", readFile(t, voice), nil)
	if err != nil {
		t.Fatal(err)
	}
	if voiceRef.GetMimeType() != "audio/ogg" {
		t.Fatalf("voice = %+v", voiceRef)
	}
	for range 2 {
		if worked, err := e.app.Media.RunJob(ctx); err != nil || !worked {
			t.Fatalf("job: %v %v", worked, err)
		}
	}
	hist, err := bob.messages.GetHistory(ctx, connect.NewRequest(&appv1.GetHistoryRequest{ChatId: chatID}))
	if err != nil {
		t.Fatal(err)
	}
	var got *appv1.MediaRef
	for _, m := range hist.Msg.GetMessages() {
		if m.GetSeq() == sent.Msg.GetMessage().GetSeq() {
			got = m.GetMedia()
		}
	}
	if got == nil || len(got.GetSizes()) == 0 || len(got.GetInlineThumb()) == 0 || got.GetWidth() != 640 || got.GetDuration() < 1900 {
		t.Fatalf("enriched video = %+v", got)
	}
	again, err := alice.media(e.env).CreateUpload(ctx, connect.NewRequest(&appv1.CreateUploadRequest{
		Kind: appv1.MediaKind_MEDIA_KIND_VOICE, Size: voiceRef.GetSize(), FileHash: hashOf(readFile(t, voice))}))
	if err != nil {
		t.Fatal(err)
	}
	if w := again.Msg.GetExisting().GetWaveform(); len(w) != 100 || again.Msg.GetExisting().GetDuration() < 1400 {
		t.Fatalf("voice waveform %d samples, %d ms", len(w), again.Msg.GetExisting().GetDuration())
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestLinkPreviewPhoto(t *testing.T) {
	jpg := photoWithGPS(t, 1000, 500)
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/og.jpg" {
			w.Header().Set("Content-Type", "image/jpeg")
			_, _ = w.Write(jpg)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, `<html><head><title>Bài viết</title><meta property="og:image" content="/og.jpg"></head></html>`)
	}))
	defer page.Close()
	addr := netip.MustParseAddrPort(mustURL(t, page.URL).Host)
	previewTarget.Store(&addr)
	defer previewTarget.Store(nil)

	e := newMediaEnv(t, config.StorageFilesystem, nil)
	alice, bob := e.member(t, "alice"), e.member(t, "bob")
	ctx := t.Context()
	chatID := privateChat(t, alice, bob)
	sent, err := alice.messages.SendMessage(ctx, connect.NewRequest(&appv1.SendMessageRequest{ChatId: chatID, Text: "xem " + page.URL + "/post"}))
	if err != nil {
		t.Fatal(err)
	}
	seq := sent.Msg.GetMessage().GetSeq()
	var photo *appv1.MediaRef
	for deadline := time.Now().Add(10 * time.Second); photo == nil; {
		hist, err := bob.messages.GetHistory(ctx, connect.NewRequest(&appv1.GetHistoryRequest{ChatId: chatID}))
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range hist.Msg.GetMessages() {
			if m.GetSeq() == seq {
				photo = m.GetLinkPreview().GetPhoto()
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("no preview photo")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if photo.GetWidth() != 500 || photo.GetHeight() != 1000 || len(photo.GetSizes()) != 2 {
		t.Fatalf("photo = %+v", photo)
	}
	u := fileURL(t, bob, e.env, photo, chatID, seq, appv1.MediaSizeType_MEDIA_SIZE_TYPE_S)
	resp := e.fetch(t, http.MethodGet, u.GetUrl(), nil, nil)
	if body := readBody(t, resp); resp.StatusCode != http.StatusOK || strings.Contains(body, gpsMarker) {
		t.Fatalf("preview photo download: %d", resp.StatusCode)
	}
}
