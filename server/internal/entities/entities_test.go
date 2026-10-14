package entities

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

type vectors struct {
	Lengths []struct {
		Name       string `json:"name"`
		Text       string `json:"text"`
		UTF16      int    `json:"utf16"`
		CodePoints int    `json:"codePoints"`
	} `json:"lengths"`
	Entities []struct {
		Name     string `json:"name"`
		Text     string `json:"text"`
		Entities []struct {
			Offset json.Number `json:"offset"`
			Length json.Number `json:"length"`
		} `json:"entities"`
		Errors []struct {
			Index int    `json:"index"`
			Code  string `json:"code"`
		} `json:"errors"`
	} `json:"entities"`
	URLs []struct {
		URL       string `json:"url"`
		AppScheme string `json:"appScheme"`
		Allowed   bool   `json:"allowed"`
	} `json:"urls"`
	LinkTexts []struct {
		Text      string  `json:"text"`
		AppScheme string  `json:"appScheme"`
		URL       *string `json:"url"` // nil when the text is rejected
	} `json:"linkTexts"`
	WebURLs []struct {
		URL     string `json:"url"`
		Allowed bool   `json:"allowed"`
	} `json:"webUrls"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "spec", "entities", "test-vectors.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	dec.DisallowUnknownFields()
	var v vectors
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("decode vectors: %v", err)
	}
	if total := len(v.Lengths) + len(v.Entities) + len(v.URLs); total < 40 {
		t.Fatalf("expected at least 40 vectors, got %d", total)
	}
	return v
}

func TestLengthVectors(t *testing.T) {
	for _, c := range loadVectors(t).Lengths {
		if got := UTF16Length(c.Text); got != c.UTF16 {
			t.Errorf("%s: UTF16Length = %d, want %d", c.Name, got, c.UTF16)
		}
		if got := CodePointLength(c.Text); got != c.CodePoints {
			t.Errorf("%s: CodePointLength = %d, want %d", c.Name, got, c.CodePoints)
		}
	}
}

// toInt converts a vector number to int. Fractional values cannot reach the Go
// API (proto fields are integers), so those vectors only run in TypeScript.
func toInt(n json.Number) (int, bool) {
	f, err := n.Float64()
	if err != nil || f != math.Trunc(f) {
		return 0, false
	}
	return int(f), true
}

func TestEntityVectors(t *testing.T) {
	ran := 0
cases:
	for _, c := range loadVectors(t).Entities {
		spans := make([]Span, 0, len(c.Entities))
		for _, e := range c.Entities {
			offset, okOffset := toInt(e.Offset)
			length, okLength := toInt(e.Length)
			if !okOffset || !okLength {
				continue cases
			}
			spans = append(spans, Span{Offset: offset, Length: length})
		}
		want := make([]Error, 0, len(c.Errors))
		for _, e := range c.Errors {
			want = append(want, Error{Index: e.Index, Code: ErrorCode(e.Code)})
		}
		if got := Validate(c.Text, spans); !slices.Equal(got, want) {
			t.Errorf("%s: Validate = %v, want %v", c.Name, got, want)
		}
		ran++
	}
	if ran < 30 {
		t.Fatalf("only %d entity vectors ran", ran)
	}
}

func TestURLVectors(t *testing.T) {
	for _, c := range loadVectors(t).URLs {
		if got := IsAllowedURL(c.URL, c.AppScheme); got != c.Allowed {
			t.Errorf("IsAllowedURL(%q, %q) = %v, want %v", c.URL, c.AppScheme, got, c.Allowed)
		}
	}
}

func TestLinkTextVectors(t *testing.T) {
	cases := loadVectors(t).LinkTexts
	if len(cases) == 0 {
		t.Fatal("no linkTexts vectors")
	}
	for _, c := range cases {
		got, ok := NormalizeLinkURL(c.Text, c.AppScheme)
		switch {
		case c.URL == nil && ok:
			t.Errorf("NormalizeLinkURL(%q) = %q, want rejection", c.Text, got)
		case c.URL != nil && (!ok || got != *c.URL):
			t.Errorf("NormalizeLinkURL(%q) = %q, %v; want %q", c.Text, got, ok, *c.URL)
		}
	}
}

func TestWebURLVectors(t *testing.T) {
	cases := loadVectors(t).WebURLs
	if len(cases) == 0 {
		t.Fatal("no webUrls vectors")
	}
	for _, c := range cases {
		if got := IsAllowedWebURL(c.URL); got != c.Allowed {
			t.Errorf("IsAllowedWebURL(%q) = %v, want %v", c.URL, got, c.Allowed)
		}
	}
}

func TestInvalidUTF8(t *testing.T) {
	bad := "a\xffb"
	if got := UTF16Length(bad); got != 3 {
		t.Errorf("UTF16Length(invalid) = %d, want 3", got)
	}
	if IsAllowedURL("https://example.com/\xff", "app") {
		t.Errorf("invalid UTF-8 URL must be rejected")
	}
	if IsAllowedWebURL("https://example.com/\xff") {
		t.Errorf("invalid UTF-8 web URL must be rejected")
	}
	if url, ok := NormalizeLinkURL("example.com/\xff", "app"); ok {
		t.Errorf("invalid UTF-8 link text normalized to %q", url)
	}
}

func TestValidateLargeInputIsLinearithmic(t *testing.T) {
	// 100k nested spans would take ~10^10 steps with a pairwise check.
	const n = 100_000
	text := string(bytes.Repeat([]byte("a"), 2*n))
	spans := make([]Span, n)
	for i := range spans {
		spans[i] = Span{Offset: i, Length: 2*n - 2*i}
	}
	if errs := Validate(text, spans); len(errs) != 0 {
		t.Fatalf("nested spans reported %d errors", len(errs))
	}
}
