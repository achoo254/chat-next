// Package vifold folds text for Vietnamese-aware search (ADR 0005).
//
// The normative algorithm and the shared test vectors live in spec/vi-fold;
// the TypeScript twin is packages/core/src/vifold. Both must return identical
// results for every vector.
package vifold

import (
	"strings"
	"unicode"

	"github.com/rivo/uniseg"
	"golang.org/x/text/unicode/norm"
)

// Fold lowercases text, strips every nonspacing mark (tones, circumflex,
// breve, horn), maps đ to d and final sigma to sigma, and collapses
// whitespace runs to a single space.
//
// strings.ToLower applies the simple case mapping. It differs from the full
// default mapping only for U+0130 (İ → i + U+0307) and final sigma; the extra
// U+0307 is a nonspacing mark removed below and every sigma is mapped to σ, so
// the result equals the full-mapping algorithm in SPEC.md.
func Fold(text string) string {
	s := norm.NFC.String(text)
	s = strings.ToLower(s)
	s = norm.NFD.String(s)
	s = strings.Map(func(r rune) rune {
		switch {
		case unicode.Is(unicode.Mn, r):
			return -1
		case r == '\u0111': // đ
			return 'd'
		case r == '\u03C2': // final sigma ς
			return '\u03C3' // σ
		}
		return r
	}, s)
	s = norm.NFC.String(s)
	return collapseWhiteSpace(s)
}

// Tokens returns the words of Fold(text) that contain a letter or a number.
// Words follow UAX #29 with the isolating-class tailoring of SPEC.md.
func Tokens(text string) []string {
	folded := Fold(text)

	// isBoundary is indexed by byte offset into folded.
	isBoundary := make([]bool, len(folded)+1)
	offset, state := 0, -1
	for rest := folded; len(rest) > 0; {
		var word string
		word, rest, state = uniseg.FirstWordInString(rest, state)
		offset += len(word)
		isBoundary[offset] = true
	}
	applyIsolatingClasses(folded, isBoundary)

	var out []string
	start := 0
	for end := 1; end <= len(folded); end++ {
		if isBoundary[end] {
			if word := folded[start:end]; hasLetterOrNumber(word) {
				out = append(out, word)
			}
			start = end
		}
	}
	return out
}

// SearchText returns the text a search engine indexes and queries: the
// tokens joined by single spaces. Engines re-tokenize what they receive, so
// both the indexed field and every query must use SearchText, not Fold.
func SearchText(text string) string {
	return strings.Join(Tokens(text), " ")
}

type isolatingClass int

const (
	classNone isolatingClass = iota
	classKatakana
	classHangul
	classSingle
)

// katakana is Word_Break=Katakana from Unicode 15.0.
var katakana = &unicode.RangeTable{
	R16: []unicode.Range16{
		{Lo: 0x3031, Hi: 0x3035, Stride: 1},
		{Lo: 0x309B, Hi: 0x309C, Stride: 1},
		{Lo: 0x30A0, Hi: 0x30FA, Stride: 1},
		{Lo: 0x30FC, Hi: 0x30FF, Stride: 1},
		{Lo: 0x31F0, Hi: 0x31FF, Stride: 1},
		{Lo: 0x32D0, Hi: 0x32FE, Stride: 1},
		{Lo: 0x3300, Hi: 0x3357, Stride: 1},
		{Lo: 0xFF66, Hi: 0xFF9D, Stride: 1},
	},
	R32: []unicode.Range32{
		{Lo: 0x1AFF0, Hi: 0x1AFF3, Stride: 1},
		{Lo: 0x1AFF5, Hi: 0x1AFFB, Stride: 1},
		{Lo: 0x1AFFD, Hi: 0x1AFFE, Stride: 1},
		{Lo: 0x1B000, Hi: 0x1B000, Stride: 1},
		{Lo: 0x1B120, Hi: 0x1B122, Stride: 1},
		{Lo: 0x1B155, Hi: 0x1B155, Stride: 1},
		{Lo: 0x1B164, Hi: 0x1B167, Stride: 1},
	},
}

// middle is Word_Break MidLetter, MidNum, MidNumLet, Single_Quote and
// Double_Quote from Unicode 15.0: joiners whose UAX #29 rules look at both
// neighbours.
var middle = &unicode.RangeTable{
	R16: []unicode.Range16{
		{Lo: 0x0022, Hi: 0x0022, Stride: 1},
		{Lo: 0x0027, Hi: 0x0027, Stride: 1},
		{Lo: 0x002C, Hi: 0x002C, Stride: 1},
		{Lo: 0x002E, Hi: 0x002E, Stride: 1},
		{Lo: 0x003A, Hi: 0x003B, Stride: 1},
		{Lo: 0x00B7, Hi: 0x00B7, Stride: 1},
		{Lo: 0x037E, Hi: 0x037E, Stride: 1},
		{Lo: 0x0387, Hi: 0x0387, Stride: 1},
		{Lo: 0x055F, Hi: 0x055F, Stride: 1},
		{Lo: 0x0589, Hi: 0x0589, Stride: 1},
		{Lo: 0x05F4, Hi: 0x05F4, Stride: 1},
		{Lo: 0x060C, Hi: 0x060D, Stride: 1},
		{Lo: 0x066C, Hi: 0x066C, Stride: 1},
		{Lo: 0x07F8, Hi: 0x07F8, Stride: 1},
		{Lo: 0x2018, Hi: 0x2019, Stride: 1},
		{Lo: 0x2024, Hi: 0x2024, Stride: 1},
		{Lo: 0x2027, Hi: 0x2027, Stride: 1},
		{Lo: 0x2044, Hi: 0x2044, Stride: 1},
		{Lo: 0xFE10, Hi: 0xFE10, Stride: 1},
		{Lo: 0xFE13, Hi: 0xFE14, Stride: 1},
		{Lo: 0xFE50, Hi: 0xFE50, Stride: 1},
		{Lo: 0xFE52, Hi: 0xFE52, Stride: 1},
		{Lo: 0xFE54, Hi: 0xFE55, Stride: 1},
		{Lo: 0xFF07, Hi: 0xFF07, Stride: 1},
		{Lo: 0xFF0C, Hi: 0xFF0C, Stride: 1},
		{Lo: 0xFF0E, Hi: 0xFF0E, Stride: 1},
		{Lo: 0xFF1A, Hi: 0xFF1B, Stride: 1},
	},
	LatinOffset: 6,
}

// singleCharacterScripts are written without spaces; every character of
// them is its own word (decimal digits excepted).
var singleCharacterScripts = []*unicode.RangeTable{
	unicode.Han, unicode.Hiragana, unicode.Thai, unicode.Lao, unicode.Khmer,
	unicode.Myanmar, unicode.Tai_Le, unicode.New_Tai_Lue, unicode.Tai_Tham,
	unicode.Tai_Viet, unicode.Ahom,
}

func classOf(r rune) isolatingClass {
	switch {
	case unicode.Is(katakana, r):
		return classKatakana
	case unicode.Is(unicode.Hangul, r):
		return classHangul
	case !unicode.Is(unicode.Nd, r) && unicode.In(r, singleCharacterScripts...):
		return classSingle
	}
	return classNone
}

// attachesToPrevious approximates Word_Break Extend, Format and ZWJ (WB4):
// Grapheme_Extend (Mn, Me, Other_Grapheme_Extend), Mc, Emoji_Modifier and Cf
// except U+200B.
func attachesToPrevious(r rune) bool {
	if r == '\u200B' {
		return false
	}
	return unicode.In(r, unicode.Mn, unicode.Me, unicode.Other_Grapheme_Extend, unicode.Mc, unicode.Cf) ||
		0x1F3FB <= r && r <= 0x1F3FF
}

// base is a code point that does not attach to its predecessor under WB4.
type base struct {
	offset int
	class  isolatingClass
	middle bool
}

func basesOf(text string) []base {
	var bases []base
	for offset, r := range text {
		if len(bases) == 0 || !attachesToPrevious(r) {
			bases = append(bases, base{offset: offset, class: classOf(r), middle: unicode.Is(middle, r)})
		}
	}
	return bases
}

// applyIsolatingClasses overrides the UAX #29 boundaries wherever an
// isolating class is involved: Katakana joins only Katakana, Hangul joins
// only Hangul, single-character scripts join nothing, and a middle joiner
// next to an isolating character stands alone.
func applyIsolatingClasses(text string, isBoundary []bool) {
	bases := basesOf(text)
	for i := 1; i < len(bases); i++ {
		previous, current := bases[i-1], bases[i]
		if previous.class != classNone || current.class != classNone {
			joins := previous.class == current.class && current.class != classSingle
			isBoundary[current.offset] = !joins
		}
		if !current.middle {
			continue
		}
		hasNext := i+1 < len(bases)
		if previous.class != classNone || hasNext && bases[i+1].class != classNone {
			isBoundary[current.offset] = true
			if hasNext {
				isBoundary[bases[i+1].offset] = true
			}
		}
	}
}

// collapseWhiteSpace replaces every run of White_Space characters with one
// U+0020 and drops leading and trailing runs.
func collapseWhiteSpace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	pending := false
	for _, r := range s {
		if unicode.Is(unicode.White_Space, r) {
			pending = b.Len() > 0
			continue
		}
		if pending {
			b.WriteByte(' ')
			pending = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

func hasLetterOrNumber(word string) bool {
	for _, r := range word {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			return true
		}
	}
	return false
}
