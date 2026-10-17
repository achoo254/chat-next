package chatbot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// downloadMax bounds DownloadFile; the server stores files of at most 50 MiB.
const downloadMax = 64 << 20

// InputFile is a file to upload: the name becomes the part's filename (and
// the message's file_name), Data is read once when the request is built.
type InputFile struct {
	Name string
	Data io.Reader
}

// SendMediaUpload uploads one file as a photo, video, audio, voice message or
// document (multipart/form-data: the file in the part "file", the other
// fields as form fields, entities as a JSON string).
func (c *Client) SendMediaUpload(ctx context.Context, req SendMediaUpload) (*Message, error) {
	if req.File == nil || req.File.Data == nil {
		return nil, errors.New("chatbot: SendMediaUpload needs File with Data")
	}
	var out Message
	if err := c.multipart(ctx, "/messages:sendMedia", req, map[string]*InputFile{"file": req.File}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SendAlbumUpload uploads 2 to 10 files as one album. req.Items is the JSON
// string of the AlbumItem list (see AlbumItems); each item with Attach names
// a key of files, sent as the part of that name.
func (c *Client) SendAlbumUpload(ctx context.Context, req SendAlbumUpload, files map[string]*InputFile) ([]Message, error) {
	for name, f := range files {
		if name == "" || f == nil || f.Data == nil {
			return nil, fmt.Errorf("chatbot: SendAlbumUpload file %q needs a part name and Data", name)
		}
	}
	var out []Message
	if err := c.multipart(ctx, "/messages:sendAlbum", req, files, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AlbumItems encodes album items as the JSON string SendAlbumUpload.Items
// expects.
func AlbumItems(items []AlbumItem) (string, error) {
	b, err := json.Marshal(items)
	if err != nil {
		return "", fmt.Errorf("chatbot: encode album items: %w", err)
	}
	return string(b), nil
}

// DownloadFile reads the file at file.URL (from GetFile). The URL carries its
// own authorization, so the bot token is never sent.
func (c *Client) DownloadFile(ctx context.Context, file *File) ([]byte, error) {
	if file == nil || file.URL == "" {
		return nil, errors.New("chatbot: DownloadFile needs a File with a URL")
	}
	target, err := c.resolve(file.URL)
	if err != nil {
		return nil, fmt.Errorf("chatbot: download %s: %w", file.FileID, err)
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, fmt.Errorf("chatbot: download %s: %w", file.FileID, err)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("chatbot: download %s: %w", file.FileID, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("chatbot: download %s: HTTP %d", file.FileID, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, downloadMax+1))
	if err != nil {
		return nil, fmt.Errorf("chatbot: download %s: %w", file.FileID, err)
	}
	if len(data) > downloadMax {
		return nil, fmt.Errorf("chatbot: download %s: larger than %d MiB", file.FileID, downloadMax>>20)
	}
	return data, nil
}

// resolve makes a download URL absolute: a server without a configured
// public origin answers a path, which lives on the API's host.
func (c *Client) resolve(raw string) (string, error) {
	ref, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if ref.IsAbs() {
		return raw, nil
	}
	base, err := url.Parse(c.baseURL)
	if err != nil {
		return "", err
	}
	return base.ResolveReference(ref).String(), nil
}

// multipart builds a multipart/form-data body from the JSON-tagged fields of
// form (zero omitempty fields left out) plus one part per file, sorted by
// name, and sends it. The body is buffered so a rate-limited request can be
// retried.
func (c *Client) multipart(ctx context.Context, path string, form any, files map[string]*InputFile, out any) error {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if err := writeFormFields(w, form); err != nil {
		return err
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f := files[name]
		filename := f.Name
		if filename == "" {
			filename = name
		}
		part, err := w.CreateFormFile(name, filename)
		if err != nil {
			return fmt.Errorf("chatbot: multipart part %q: %w", name, err)
		}
		if _, err := io.Copy(part, f.Data); err != nil {
			return fmt.Errorf("chatbot: read file %q: %w", filename, err)
		}
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("chatbot: multipart body: %w", err)
	}
	return c.do(ctx, http.MethodPost, path, nil, w.FormDataContentType(), buf.Bytes(), out)
}

// writeFormFields writes the exported fields of a struct as form fields named
// by their json tags. Strings, integers and booleans are written as text;
// fields tagged "-" (the files) are skipped.
func writeFormFields(w *multipart.Writer, form any) error {
	v := reflect.ValueOf(form)
	t := v.Type()
	for i := range t.NumField() {
		field := t.Field(i)
		tag := field.Tag.Get("json")
		name, opts, _ := strings.Cut(tag, ",")
		if name == "-" || name == "" || !field.IsExported() {
			continue
		}
		fv := v.Field(i)
		if strings.Contains(opts, "omitempty") && fv.IsZero() {
			continue
		}
		var text string
		switch fv.Kind() {
		case reflect.String:
			text = fv.String()
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			text = strconv.FormatInt(fv.Int(), 10)
		case reflect.Bool:
			text = strconv.FormatBool(fv.Bool())
		default:
			return fmt.Errorf("chatbot: form field %q has unsupported type %s", name, fv.Type())
		}
		if err := w.WriteField(name, text); err != nil {
			return fmt.Errorf("chatbot: form field %q: %w", name, err)
		}
	}
	return nil
}
