// Package s3test is an in-process fake of the S3 API subset the media
// service uses (path-style addressing, one bucket): objects with Range
// reads, copies, multipart uploads with part copies, presigned part PUTs.
// Signatures are not verified. Like the production identity it denies
// listing parts and multipart uploads unless AllowListing is set.
package s3test

import (
	"bufio"
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Server is a running fake.
type Server struct {
	*httptest.Server
	Bucket string

	mu      sync.Mutex
	objects map[string][]byte
	uploads map[string]*upload
	next    int
	// AllowListing permits ListParts and ListMultipartUploads.
	AllowListing bool
	// Requests counts requests per "METHOD kind" (e.g. "PUT part").
	Requests map[string]int
}

type upload struct {
	key       string
	parts     map[int][]byte
	initiated time.Time
}

// New starts a fake serving bucket; it is closed with the test.
func New(t interface{ Cleanup(func()) }, bucket string) *Server {
	s := &Server{Bucket: bucket, objects: map[string][]byte{}, uploads: map[string]*upload{}, Requests: map[string]int{}}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.Close)
	return s
}

// Object returns a stored object.
func (s *Server) Object(key string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.objects[key]
	return bytes.Clone(b), ok
}

// Keys lists stored object keys, sorted.
func (s *Server) Keys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := make([]string, 0, len(s.objects))
	for k := range s.objects {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// PendingUploads counts multipart uploads not completed or aborted.
func (s *Server) PendingUploads() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.uploads)
}

// Count returns how many requests of a kind were served.
func (s *Server) Count(kind string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Requests[kind]
}

type s3Error struct {
	XMLName xml.Name `xml:"Error"`
	Code    string
	Message string
}

func fail(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_ = xml.NewEncoder(w).Encode(s3Error{Code: code, Message: code})
}

func writeXML(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/xml")
	_, _ = w.Write([]byte(xml.Header))
	_ = xml.NewEncoder(w).Encode(v)
}

func etagOf(b []byte) string {
	sum := md5.Sum(b)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

// body reads a request body, decoding aws-chunked streaming uploads.
func body(r *http.Request) ([]byte, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(r.Header.Get("X-Amz-Content-Sha256"), "STREAMING-") {
		return raw, nil
	}
	var out bytes.Buffer
	br := bufio.NewReader(bytes.NewReader(raw))
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return nil, fmt.Errorf("aws-chunked: %w", err)
		}
		sizeHex, _, _ := strings.Cut(strings.TrimSpace(line), ";")
		n, err := strconv.ParseInt(sizeHex, 16, 64)
		if err != nil {
			return nil, fmt.Errorf("aws-chunked size: %w", err)
		}
		if n == 0 {
			return out.Bytes(), nil
		}
		if _, err := io.CopyN(&out, br, n); err != nil {
			return nil, err
		}
		if _, err := br.ReadString('\n'); err != nil {
			return nil, err
		}
	}
}

func (s *Server) count(kind string) {
	s.Requests[kind]++
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, "/")
	bucket, key, _ := strings.Cut(path, "/")
	if bucket != s.Bucket {
		fail(w, http.StatusNotFound, "NoSuchBucket")
		return
	}
	q := r.URL.Query()
	if key == "" {
		switch {
		case r.Method == http.MethodHead:
			s.count("HEAD bucket")
		case r.Method == http.MethodGet && q.Has("uploads"):
			s.count("GET uploads")
			s.listUploads(w, q.Get("prefix"))
		case r.Method == http.MethodGet && q.Has("location"):
			writeXML(w, struct {
				XMLName xml.Name `xml:"LocationConstraint"`
			}{})
		default:
			fail(w, http.StatusNotImplemented, "NotImplemented")
		}
		return
	}
	key, _ = url.PathUnescape(key)
	uploadID := q.Get("uploadId")
	switch {
	case r.Method == http.MethodPost && q.Has("uploads"):
		s.count("POST create")
		s.next++
		id := fmt.Sprintf("upload-%d", s.next)
		s.uploads[id] = &upload{key: key, parts: map[int][]byte{}, initiated: time.Now()}
		writeXML(w, struct {
			XMLName  xml.Name `xml:"InitiateMultipartUploadResult"`
			Bucket   string
			Key      string
			UploadId string
		}{Bucket: bucket, Key: key, UploadId: id})
	case r.Method == http.MethodPut && uploadID != "":
		s.putPart(w, r, key, uploadID, q.Get("partNumber"))
	case r.Method == http.MethodGet && uploadID != "":
		s.count("GET parts")
		s.listParts(w, key, uploadID)
	case r.Method == http.MethodPost && uploadID != "":
		s.count("POST complete")
		s.complete(w, r, key, uploadID)
	case r.Method == http.MethodDelete && uploadID != "":
		s.count("DELETE upload")
		if u, ok := s.uploads[uploadID]; !ok || u.key != key {
			fail(w, http.StatusNotFound, "NoSuchUpload")
			return
		}
		delete(s.uploads, uploadID)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPut && r.Header.Get("X-Amz-Copy-Source") != "":
		s.count("PUT copy")
		src, ok := s.copySource(r)
		if !ok {
			fail(w, http.StatusNotFound, "NoSuchKey")
			return
		}
		s.objects[key] = bytes.Clone(src)
		writeXML(w, struct {
			XMLName      xml.Name `xml:"CopyObjectResult"`
			ETag         string
			LastModified string
		}{ETag: etagOf(src), LastModified: time.Now().UTC().Format(time.RFC3339)})
	case r.Method == http.MethodPut:
		s.count("PUT object")
		b, err := body(r)
		if err != nil {
			fail(w, http.StatusBadRequest, "IncompleteBody")
			return
		}
		s.objects[key] = b
		w.Header().Set("ETag", etagOf(b))
	case r.Method == http.MethodGet || r.Method == http.MethodHead:
		s.count(r.Method + " object")
		s.get(w, r, key)
	case r.Method == http.MethodDelete:
		s.count("DELETE object")
		delete(s.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		fail(w, http.StatusNotImplemented, "NotImplemented")
	}
}

func (s *Server) copySource(r *http.Request) ([]byte, bool) {
	src, _ := url.PathUnescape(strings.TrimPrefix(r.Header.Get("X-Amz-Copy-Source"), "/"))
	_, srcKey, _ := strings.Cut(src, "/")
	b, ok := s.objects[srcKey]
	return b, ok
}

func (s *Server) putPart(w http.ResponseWriter, r *http.Request, key, uploadID, number string) {
	u, ok := s.uploads[uploadID]
	if !ok || u.key != key {
		fail(w, http.StatusNotFound, "NoSuchUpload")
		return
	}
	n, err := strconv.Atoi(number)
	if err != nil || n < 1 || n > 10000 {
		fail(w, http.StatusBadRequest, "InvalidArgument")
		return
	}
	if r.Header.Get("X-Amz-Copy-Source") != "" {
		s.count("PUT copy part")
		src, ok := s.copySource(r)
		if !ok {
			fail(w, http.StatusNotFound, "NoSuchKey")
			return
		}
		var from, to int64
		if _, err := fmt.Sscanf(r.Header.Get("X-Amz-Copy-Source-Range"), "bytes=%d-%d", &from, &to); err != nil ||
			from < 0 || to < from || to >= int64(len(src)) {
			fail(w, http.StatusBadRequest, "InvalidRange")
			return
		}
		data := bytes.Clone(src[from : to+1])
		u.parts[n] = data
		writeXML(w, struct {
			XMLName      xml.Name `xml:"CopyPartResult"`
			ETag         string
			LastModified string
		}{ETag: etagOf(data), LastModified: time.Now().UTC().Format(time.RFC3339)})
		return
	}
	s.count("PUT part")
	b, err := body(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "IncompleteBody")
		return
	}
	u.parts[n] = b
	w.Header().Set("ETag", etagOf(b))
}

func (s *Server) listParts(w http.ResponseWriter, key, uploadID string) {
	if !s.AllowListing {
		fail(w, http.StatusForbidden, "AccessDenied")
		return
	}
	u, ok := s.uploads[uploadID]
	if !ok || u.key != key {
		fail(w, http.StatusNotFound, "NoSuchUpload")
		return
	}
	type part struct {
		PartNumber   int
		ETag         string
		Size         int64
		LastModified string
	}
	res := struct {
		XMLName  xml.Name `xml:"ListPartsResult"`
		Bucket   string
		Key      string
		UploadId string
		Part     []part
	}{Bucket: s.Bucket, Key: key, UploadId: uploadID}
	nums := make([]int, 0, len(u.parts))
	for n := range u.parts {
		nums = append(nums, n)
	}
	sort.Ints(nums)
	for _, n := range nums {
		res.Part = append(res.Part, part{PartNumber: n, ETag: etagOf(u.parts[n]), Size: int64(len(u.parts[n])),
			LastModified: time.Now().UTC().Format(time.RFC3339)})
	}
	writeXML(w, res)
}

func (s *Server) listUploads(w http.ResponseWriter, prefix string) {
	if !s.AllowListing {
		fail(w, http.StatusForbidden, "AccessDenied")
		return
	}
	type item struct {
		Key       string
		UploadId  string
		Initiated string
	}
	res := struct {
		XMLName xml.Name `xml:"ListMultipartUploadsResult"`
		Bucket  string
		Upload  []item
	}{Bucket: s.Bucket}
	for id, u := range s.uploads {
		if strings.HasPrefix(u.key, prefix) {
			res.Upload = append(res.Upload, item{Key: u.key, UploadId: id, Initiated: u.initiated.UTC().Format(time.RFC3339)})
		}
	}
	writeXML(w, res)
}

func (s *Server) complete(w http.ResponseWriter, r *http.Request, key, uploadID string) {
	u, ok := s.uploads[uploadID]
	if !ok || u.key != key {
		fail(w, http.StatusNotFound, "NoSuchUpload")
		return
	}
	raw, err := body(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "MalformedXML")
		return
	}
	var req struct {
		Parts []struct {
			PartNumber int
			ETag       string
		} `xml:"Part"`
	}
	if err := xml.Unmarshal(raw, &req); err != nil || len(req.Parts) == 0 {
		fail(w, http.StatusBadRequest, "MalformedXML")
		return
	}
	var out bytes.Buffer
	for i, p := range req.Parts {
		data, ok := u.parts[p.PartNumber]
		if !ok || strings.Trim(p.ETag, `"`) != strings.Trim(etagOf(data), `"`) {
			fail(w, http.StatusBadRequest, "InvalidPart")
			return
		}
		if i > 0 && p.PartNumber <= req.Parts[i-1].PartNumber {
			fail(w, http.StatusBadRequest, "InvalidPartOrder")
			return
		}
		if i < len(req.Parts)-1 && len(data) < 5<<20 {
			fail(w, http.StatusBadRequest, "EntityTooSmall")
			return
		}
		out.Write(data)
	}
	s.objects[key] = out.Bytes()
	delete(s.uploads, uploadID)
	writeXML(w, struct {
		XMLName xml.Name `xml:"CompleteMultipartUploadResult"`
		Bucket  string
		Key     string
		ETag    string
	}{Bucket: s.Bucket, Key: key, ETag: etagOf(out.Bytes())})
}

func (s *Server) get(w http.ResponseWriter, r *http.Request, key string) {
	b, ok := s.objects[key]
	if !ok {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		fail(w, http.StatusNotFound, "NoSuchKey")
		return
	}
	w.Header().Set("ETag", etagOf(b))
	w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Accept-Ranges", "bytes")
	from, to := int64(0), int64(len(b))-1
	status := http.StatusOK
	if rng := r.Header.Get("Range"); rng != "" {
		spec := strings.TrimPrefix(rng, "bytes=")
		a, z, _ := strings.Cut(spec, "-")
		var err error
		if from, err = strconv.ParseInt(a, 10, 64); err != nil || from >= int64(len(b)) {
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		if z != "" {
			if to, err = strconv.ParseInt(z, 10, 64); err != nil {
				w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
				return
			}
			to = min(to, int64(len(b))-1)
		}
		status = http.StatusPartialContent
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to, len(b)))
	}
	w.Header().Set("Content-Length", strconv.FormatInt(to-from+1, 10))
	w.WriteHeader(status)
	if r.Method == http.MethodGet {
		_, _ = w.Write(b[from : to+1])
	}
}
