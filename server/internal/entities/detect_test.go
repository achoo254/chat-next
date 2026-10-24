package entities

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"unicode/utf16"
	"unicode/utf8"
)

type detectVectors struct {
	TLDs  []string `json:"tlds"`
	Cases []struct {
		Name     string `json:"name"`
		Text     string `json:"text"`
		Entities []struct {
			Type   string `json:"type"`
			Offset int    `json:"offset"`
			Length int    `json:"length"`
		} `json:"entities"`
		Limit *int `json:"limit"`
		Found []struct {
			Type   string `json:"type"`
			Offset int    `json:"offset"`
			Length int    `json:"length"`
			Text   string `json:"text"`
		} `json:"found"`
	} `json:"cases"`
}

func loadDetectVectors(t testing.TB) detectVectors {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "spec", "entities", "detect-vectors.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var v detectVectors
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("decode vectors: %v", err)
	}
	return v
}

// containerTypes mirrors the style entities the chat service marks as
// containers when it calls Detect.
var containerTypes = map[string]bool{"bold": true, "italic": true, "underline": true, "strike": true, "spoiler": true}

func TestDetectVectors(t *testing.T) {
	v := loadDetectVectors(t)
	if len(v.Cases) == 0 {
		t.Fatal("no detect vectors")
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			taken := make([]Taken, len(c.Entities))
			for i, e := range c.Entities {
				taken[i] = Taken{Span: Span{Offset: e.Offset, Length: e.Length}, Container: containerTypes[e.Type]}
			}
			limit := 100
			if c.Limit != nil {
				limit = *c.Limit
			}
			got := Detect(c.Text, taken, "com.hoandat.chat", limit)
			if len(got) != len(c.Found) {
				t.Fatalf("found %+v, want %+v", got, c.Found)
			}
			units := utf16.Encode([]rune(c.Text))
			for i, want := range c.Found {
				g := got[i]
				if string(g.Kind) != want.Type || g.Offset != want.Offset || g.Length != want.Length {
					t.Errorf("entity %d = %+v, want %+v", i, g, want)
				}
				if s := string(utf16.Decode(units[want.Offset : want.Offset+want.Length])); s != want.Text {
					t.Errorf("vector %d: span text %q, want %q", i, s, want.Text)
				}
			}
		})
	}
}

func TestKnownTLDsMatchVectors(t *testing.T) {
	v := loadDetectVectors(t)
	got := make([]string, 0, len(knownTLDs))
	for tld := range knownTLDs {
		got = append(got, tld)
	}
	slices.Sort(got)
	if !slices.Equal(got, v.TLDs) {
		t.Fatalf("knownTLDs differs from spec/entities/detect-vectors.json tlds:\n got %v\nwant %v", got, v.TLDs)
	}
}

func TestDetectFoundPassesValidate(t *testing.T) {
	text := "**Xem** https://hoandat.com, @tieude_bot #vui 😀 an@hoandat.vn"
	taken := []Taken{{Span: Span{Offset: 0, Length: 7}, Container: true}}
	found := Detect(text, taken, "", 100)
	if len(found) != 4 {
		t.Fatalf("found %+v", found)
	}
	spans := []Span{taken[0].Span}
	for _, f := range found {
		spans = append(spans, f.Span)
	}
	if errs := Validate(text, spans); len(errs) != 0 {
		t.Fatalf("detected spans do not validate: %+v", errs)
	}
}

func TestDetectEdgeInputs(t *testing.T) {
	if got := Detect("", nil, "", 10); got != nil {
		t.Fatalf("empty text: %+v", got)
	}
	if got := Detect("#a #b", nil, "", 0); got != nil {
		t.Fatalf("zero limit: %+v", got)
	}
	long := bytes.Repeat([]byte("a"), 300)
	if got := Detect(string(long)+".com", nil, "", 10); len(got) != 0 {
		t.Fatalf("host longer than 253 characters: %+v", got)
	}
}

// FuzzDetect: whatever the text, Detect does not panic, stays within the
// limit, and its spans validate together with a style and a code entity.
func FuzzDetect(f *testing.F) {
	for _, c := range loadDetectVectors(f).Cases {
		f.Add(c.Text)
	}
	f.Fuzz(func(t *testing.T, text string) {
		if !utf8.ValidString(text) {
			return
		}
		n := UTF16Length(text)
		var taken []Taken
		if errs := Validate(text, []Span{{Offset: 0, Length: n}}); n > 0 && len(errs) == 0 {
			taken = append(taken, Taken{Span: Span{Offset: 0, Length: n}, Container: true})
		}
		if errs := Validate(text, []Span{{Offset: 0, Length: min(n, 4)}}); n > 0 && len(errs) == 0 {
			taken = append(taken, Taken{Span: Span{Offset: 0, Length: min(n, 4)}})
		}
		found := Detect(text, taken, "com.hoandat.chat", 7)
		if len(found) > 7 {
			t.Fatalf("%d entities over the limit", len(found))
		}
		spans := make([]Span, 0, len(taken)+len(found))
		for _, tk := range taken {
			spans = append(spans, tk.Span)
		}
		for _, d := range found {
			spans = append(spans, d.Span)
		}
		if errs := Validate(text, spans); len(errs) != 0 {
			t.Fatalf("Detect(%q) = %+v does not validate: %+v", text, found, errs)
		}
	})
}
