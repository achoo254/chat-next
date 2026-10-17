package chatbot

import (
	"context"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
)

// parseForm reads a recorded multipart body into its fields and files.
func parseForm(t *testing.T, req recorded) (map[string]string, map[string][2]string) {
	t.Helper()
	mt, params, err := mime.ParseMediaType(req.Header.Get("Content-Type"))
	if err != nil || mt != "multipart/form-data" {
		t.Fatalf("Content-Type = %q", req.Header.Get("Content-Type"))
	}
	fields := map[string]string{}
	files := map[string][2]string{}
	r := multipart.NewReader(strings.NewReader(string(req.Body)), params["boundary"])
	for {
		p, err := r.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("multipart: %v", err)
		}
		data, _ := io.ReadAll(p)
		if p.FileName() != "" {
			files[p.FormName()] = [2]string{p.FileName(), string(data)}
		} else {
			fields[p.FormName()] = string(data)
		}
	}
	return fields, files
}

func TestSendMediaUploadMultipart(t *testing.T) {
	f := newFakeAPI(t)
	f.ok("POST /bot/v1/messages:sendMedia", map[string]any{"chat": map[string]any{"id": 42}, "seq": 3, "date": 1})
	_, err := f.client(nil).SendMediaUpload(context.Background(), SendMediaUpload{
		ChatID:   42,
		Kind:     MediaKindDocument,
		File:     &InputFile{Name: "hello.txt", Data: strings.NewReader("xin chào")},
		Text:     "Tệp mẫu",
		Entities: `[{"type":"bold","offset":0,"length":3}]`,
	})
	if err != nil {
		t.Fatalf("SendMediaUpload: %v", err)
	}
	req := f.requests()[0]
	if req.Header.Get("Authorization") != "Bearer "+testToken {
		t.Error("missing token")
	}
	fields, files := parseForm(t, req)
	want := map[string]string{"chat_id": "42", "kind": "document", "text": "Tệp mẫu", "entities": `[{"type":"bold","offset":0,"length":3}]`}
	if len(fields) != len(want) {
		t.Errorf("fields = %v, want %v (zero omitempty fields left out)", fields, want)
	}
	for k, v := range want {
		if fields[k] != v {
			t.Errorf("field %s = %q, want %q", k, fields[k], v)
		}
	}
	file, ok := files["file"]
	if !ok || file[0] != "hello.txt" || file[1] != "xin chào" || len(file[1]) != 9 {
		t.Errorf("files = %v", files)
	}
}

func TestSendMediaUploadNeedsFile(t *testing.T) {
	f := newFakeAPI(t)
	if _, err := f.client(nil).SendMediaUpload(context.Background(), SendMediaUpload{ChatID: 1, Kind: MediaKindPhoto}); err == nil {
		t.Fatal("no error without a file")
	}
	if len(f.requests()) != 0 {
		t.Error("a request was sent")
	}
}

func TestSendAlbumUploadPartsNamedByAttach(t *testing.T) {
	f := newFakeAPI(t)
	f.ok("POST /bot/v1/messages:sendAlbum", []any{})
	items, err := AlbumItems([]AlbumItem{{Attach: "one", Kind: MediaKindDocument}, {Attach: "two", Kind: MediaKindDocument}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.client(nil).SendAlbumUpload(context.Background(), SendAlbumUpload{ChatID: 5, Items: items}, map[string]*InputFile{
		"one": {Name: "a.txt", Data: strings.NewReader("A")},
		"two": {Name: "b.txt", Data: strings.NewReader("BB")},
	})
	if err != nil {
		t.Fatalf("SendAlbumUpload: %v", err)
	}
	fields, files := parseForm(t, f.requests()[0])
	if fields["chat_id"] != "5" || fields["items"] != `[{"attach":"one","kind":"document"},{"attach":"two","kind":"document"}]` {
		t.Errorf("fields = %v", fields)
	}
	if files["one"] != [2]string{"a.txt", "A"} || files["two"] != [2]string{"b.txt", "BB"} {
		t.Errorf("files = %v", files)
	}
}

func TestUploadRetriedAfterRateLimitResendsTheFile(t *testing.T) {
	f := newFakeAPI(t)
	first := true
	f.handle("POST /bot/v1/messages:sendMedia", func(w http.ResponseWriter, _ *http.Request) {
		if first {
			first = false
			writeErr(w, http.StatusTooManyRequests, "rate_limited", 1)
			return
		}
		writeOK(w, map[string]any{"chat": map[string]any{"id": 1}, "seq": 1, "date": 1})
	})
	_, err := f.client(nil).SendMediaUpload(context.Background(), SendMediaUpload{
		ChatID: 1, Kind: MediaKindDocument, File: &InputFile{Name: "x.txt", Data: strings.NewReader("data")},
	})
	if err != nil {
		t.Fatalf("SendMediaUpload: %v", err)
	}
	reqs := f.requests()
	_, files := parseForm(t, reqs[1])
	if len(reqs) != 2 || files["file"][1] != "data" {
		t.Errorf("retry body files = %v", files)
	}
}

func TestDownloadFileSendsNoToken(t *testing.T) {
	f := newFakeAPI(t)
	f.handle("GET /f/abc", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("xin chào")) })
	c := f.client(nil)
	for _, u := range []string{f.srv.URL + "/f/abc", "/f/abc"} {
		data, err := c.DownloadFile(context.Background(), &File{FileID: "abc", URL: u})
		if err != nil || string(data) != "xin chào" {
			t.Fatalf("DownloadFile(%s) = %q, %v", u, data, err)
		}
	}
	for _, r := range f.requests() {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("download sent Authorization")
		}
	}
	if _, err := c.DownloadFile(context.Background(), &File{FileID: "x", URL: f.srv.URL + "/f/missing"}); err == nil {
		t.Error("a 404 download succeeded")
	}
}
