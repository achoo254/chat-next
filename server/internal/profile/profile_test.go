package profile

import (
	"errors"
	"strings"
	"testing"
)

func TestValidUsername(t *testing.T) {
	for _, u := range []string{"abc", "user_1", strings.Repeat("a", 32)} {
		if !ValidUsername(u) {
			t.Errorf("ValidUsername(%q) = false", u)
		}
	}
	for _, u := range []string{"", "ab", "Abc", "a-b", "a.b", "ab c", strings.Repeat("a", 33), "tên"} {
		if ValidUsername(u) {
			t.Errorf("ValidUsername(%q) = true", u)
		}
	}
}

func TestUsernameBase(t *testing.T) {
	cases := map[string]string{
		"Dat.Tran":              "dat_tran",
		"hoan-dat":              "hoan_dat",
		"x":                     "x",
		"an":                    "an",
		"Trần":                  "trn",
		"!!":                    "",
		strings.Repeat("a", 40): strings.Repeat("a", 32),
	}
	for in, want := range cases {
		if got := UsernameBase(in); got != want {
			t.Errorf("UsernameBase(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUsernameCandidate(t *testing.T) {
	if got := UsernameCandidate("dat", 0); got != "dat" {
		t.Fatalf("attempt 0 = %q", got)
	}
	if got := UsernameCandidate("dat", 1); got != "dat2" {
		t.Fatalf("attempt 1 = %q", got)
	}
	if got := UsernameCandidate("dat", 9); got != "dat10" {
		t.Fatalf("attempt 9 = %q", got)
	}
	long := strings.Repeat("a", 32)
	for attempt := range 15 {
		if c := UsernameCandidate(long, attempt); !ValidUsername(c) {
			t.Fatalf("attempt %d produced invalid %q", attempt, c)
		}
	}
	if got := UsernameCandidate("dat", 10); len(got) != 9 || !ValidUsername(got) {
		t.Fatalf("random candidate = %q", got)
	}
}

func TestUsernameCandidateShortBase(t *testing.T) {
	cases := []struct {
		base    string
		attempt int
		want    string
	}{
		{"an", 0, "an1"},
		{"an", 1, "an2"},
		{"an", 8, "an9"},
		{"an", 9, "an10"},
		{"x", 0, "x01"},
		{"x", 1, "x02"},
		{"x", 9, "x10"},
		{"", 0, "001"},
		{"", 9, "010"},
	}
	for _, c := range cases {
		if got := UsernameCandidate(c.base, c.attempt); got != c.want {
			t.Errorf("UsernameCandidate(%q, %d) = %q, want %q", c.base, c.attempt, got, c.want)
		}
	}
	for _, base := range []string{"", "x", "an"} {
		for attempt := range 15 {
			c := UsernameCandidate(base, attempt)
			if !ValidUsername(c) {
				t.Fatalf("UsernameCandidate(%q, %d) produced invalid %q", base, attempt, c)
			}
			if c == "user" || !strings.HasPrefix(c, base) {
				t.Fatalf("UsernameCandidate(%q, %d) = %q drops the name part", base, attempt, c)
			}
		}
	}
}

func TestCleanName(t *testing.T) {
	if got, err := CleanName("  Trần Đạt "); err != nil || got != "Trần Đạt" {
		t.Fatalf("CleanName = %q, %v", got, err)
	}
	if _, err := CleanName(strings.Repeat("ạ", 64)); err != nil {
		t.Fatalf("64 code points rejected: %v", err)
	}
	for in, want := range map[string]error{
		"   ":                   ErrNameEmpty,
		strings.Repeat("ạ", 65): ErrNameTooLong,
		"a\nb":                  ErrControlCharacter,
	} {
		if _, err := CleanName(in); !errors.Is(err, want) {
			t.Errorf("CleanName(%q) err = %v, want %v", in, err, want)
		}
	}
}

func TestCleanBio(t *testing.T) {
	if got, err := CleanBio(" hai\ndòng "); err != nil || got != "hai\ndòng" {
		t.Fatalf("CleanBio = %q, %v", got, err)
	}
	if got, err := CleanBio(""); err != nil || got != "" {
		t.Fatalf("empty bio = %q, %v", got, err)
	}
	if _, err := CleanBio(strings.Repeat("a", 141)); !errors.Is(err, ErrBioTooLong) {
		t.Fatalf("long bio err = %v", err)
	}
	if _, err := CleanBio("a\x00b"); !errors.Is(err, ErrControlCharacter) {
		t.Fatalf("control err = %v", err)
	}
}

func TestInitialName(t *testing.T) {
	if got := InitialName("", "dat", "user"); got != "dat" {
		t.Fatalf("got %q", got)
	}
	if got := InitialName(" A\tB ", "dat", "user"); got != "A B" {
		t.Fatalf("got %q", got)
	}
	if got := InitialName(strings.Repeat("x", 80), "", ""); len(got) != NameMaxLen {
		t.Fatalf("len = %d", len(got))
	}
	if got := InitialName("", "", ""); got != "user" {
		t.Fatalf("got %q", got)
	}
}
