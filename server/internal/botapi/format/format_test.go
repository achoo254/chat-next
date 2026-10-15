package format

import (
	"strings"
	"testing"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/entities"
)

var opts = Options{AppScheme: "com.example.chat"}

type ent struct {
	t      appv1.EntityType
	off, n int32
	url    string
	lang   string
}

func check(t *testing.T, name, gotText string, got []*appv1.MessageEntity, err error, wantText string, want []ent) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if gotText != wantText {
		t.Fatalf("%s: text %q, want %q", name, gotText, wantText)
	}
	if len(got) != len(want) {
		t.Fatalf("%s: entities %v, want %v", name, got, want)
	}
	for i, w := range want {
		g := got[i]
		if g.GetType() != w.t || g.GetOffset() != w.off || g.GetLength() != w.n || g.GetUrl() != w.url || g.GetLanguage() != w.lang {
			t.Fatalf("%s: entity %d = %v, want %+v", name, i, g, w)
		}
	}
}

const (
	bold      = appv1.EntityType_ENTITY_TYPE_BOLD
	italic    = appv1.EntityType_ENTITY_TYPE_ITALIC
	underline = appv1.EntityType_ENTITY_TYPE_UNDERLINE
	strike    = appv1.EntityType_ENTITY_TYPE_STRIKE
	spoiler   = appv1.EntityType_ENTITY_TYPE_SPOILER
	code      = appv1.EntityType_ENTITY_TYPE_CODE
	pre       = appv1.EntityType_ENTITY_TYPE_PRE
	link      = appv1.EntityType_ENTITY_TYPE_TEXT_LINK
)

func TestMarkdown(t *testing.T) {
	cases := []struct {
		src, text string
		ents      []ent
	}{
		{"plain", "plain", nil},
		{"*đậm* và _nghiêng_", "đậm và nghiêng", []ent{{t: bold, off: 0, n: 3}, {t: italic, off: 7, n: 7}}},
		{"__gạch__ ~xoá~ ||ẩn||", "gạch xoá ẩn", []ent{{t: underline, n: 4}, {t: strike, off: 5, n: 3}, {t: spoiler, off: 9, n: 2}}},
		{"*a _b_ c*", "a b c", []ent{{t: italic, off: 2, n: 1}, {t: bold, n: 5}}},
		{"`x*y` ok", "x*y ok", []ent{{t: code, n: 3}}},
		{"```go\nfmt.Println(1)\n```", "fmt.Println(1)\n", []ent{{t: pre, n: 15, lang: "go"}}},
		{"```\nraw```", "raw", []ent{{t: pre, n: 3}}},
		{"[trang *chủ*](https://hoandat.com/a\\)b)", "trang chủ", []ent{{t: bold, off: 6, n: 3}, {t: link, n: 9, url: "https://hoandat.com/a)b"}}},
		{`\*not bold\* a\\b`, `*not bold* a\b`, nil},
		{"😀*x*", "😀x", []ent{{t: bold, off: 2, n: 1}}},
		{"a ] b ( c )", "a ] b ( c )", nil},
		{"**", "", nil},
		{`trailing \`, `trailing \`, nil},
		// The example of spec/bot-api/format.md.
		{"*Đơn* #42 đã giao, xem [chi tiết](https://shop.example/o/42)", "Đơn #42 đã giao, xem chi tiết",
			[]ent{{t: bold, n: 3}, {t: link, off: 21, n: 8, url: "https://shop.example/o/42"}}},
	}
	for _, c := range cases {
		text, ents, err := Markdown(c.src, opts)
		check(t, c.src, text, ents, err, c.text, c.ents)
	}
}

func TestMarkdownErrors(t *testing.T) {
	for _, src := range []string{
		"*open", "_a *b_ c*", "`open", "```open", "[text](https://x", "[text] (https://x)",
		"[x](javascript:alert(1))", "[x](file:///etc/passwd)", "[x](ms-msdt:foo)", "[](https://x)",
		"[a [b](https://x)](https://y)", "bad\xffutf8", "nul\x00",
		strings.Repeat("[", 17),
	} {
		if _, _, err := Markdown(src, opts); err == nil {
			t.Errorf("Markdown(%q) succeeded", src)
		}
	}
}

func TestHTML(t *testing.T) {
	cases := []struct {
		src, text string
		ents      []ent
	}{
		{"<b>đậm</b> <i>x</i> <u>u</u> <s>s</s>", "đậm x u s", []ent{{t: bold, n: 3}, {t: italic, off: 4, n: 1}, {t: underline, off: 6, n: 1}, {t: strike, off: 8, n: 1}}},
		{`<span class="spoiler">ẩn</span><spoiler>b</spoiler>`, "ẩnb", []ent{{t: spoiler, n: 2}, {t: spoiler, off: 2, n: 1}}},
		{"a &lt;b&gt; &amp; &quot;c&quot; &#39;&#x1F600;", `a <b> & "c" '😀`, nil},
		{`<a href="https://hoandat.com/?a=1&amp;b=2">trang <b>chủ</b></a>`, "trang chủ", []ent{{t: bold, off: 6, n: 3}, {t: link, n: 9, url: "https://hoandat.com/?a=1&b=2"}}},
		{`<pre><code class="language-go">x := 1</code></pre>`, "x := 1", []ent{{t: pre, n: 6, lang: "go"}}},
		{"<pre>a\nb</pre> <code>c</code>", "a\nb c", []ent{{t: pre, n: 3}, {t: code, off: 4, n: 1}}},
		{"<B>x</B>", "x", []ent{{t: bold, n: 1}}},
		// The example of spec/bot-api/format.md.
		{"<b>Đơn</b> #42 &amp; <code>ok</code>", "Đơn #42 & ok", []ent{{t: bold, n: 3}, {t: code, off: 10, n: 2}}},
		// A bare & that cannot read as a reference is itself, as in browsers.
		{"AT&T & co &; &", "AT&T & co &; &", nil},
		{`<a href="https://hoandat.com/?a=1&b=2">x</a>`, "x", []ent{{t: link, n: 1, url: "https://hoandat.com/?a=1&b=2"}}},
	}
	for _, c := range cases {
		text, ents, err := HTML(c.src, opts)
		check(t, c.src, text, ents, err, c.text, c.ents)
	}
}

func TestHTMLErrors(t *testing.T) {
	for _, src := range []string{
		"<b>open", "<b><i>x</b></i>", "a < b", "a > b", "<script>x</script>", "<b onclick=\"x\">y</b>",
		`<a href="javascript:alert(1)">x</a>`, `<a href="file:///x">y</a>`, "<a>x</a>", `<a href="https://x"></a>`,
		"<code><b>x</b></code>", "<b><b>x</b></b>", "&nbsp;", "&#0;", "a &copy; b", "&#xZZ;", `<span class="x">y</span>`, "</b>",
		`<a href="https://x" href="https://y">z</a>`,
	} {
		if _, _, err := HTML(src, opts); err == nil {
			t.Errorf("HTML(%q) succeeded", src)
		}
	}
}

// checkOutput is the invariant of every successful parse: valid text,
// valid entity spans (ADR 0004) and only allowed link URLs.
func checkOutput(t *testing.T, src, text string, ents []*appv1.MessageEntity) {
	t.Helper()
	if !utf8.ValidString(text) {
		t.Fatalf("%q: output is not UTF-8", src)
	}
	spans := make([]entities.Span, len(ents))
	for i, e := range ents {
		spans[i] = entities.Span{Offset: int(e.GetOffset()), Length: int(e.GetLength())}
		if e.GetType() == link && !entities.IsAllowedURL(e.GetUrl(), opts.AppScheme) {
			t.Fatalf("%q: link to %q", src, e.GetUrl())
		}
	}
	if errs := entities.Validate(text, spans); len(errs) > 0 {
		t.Fatalf("%q: invalid entities %v: %v", src, ents, errs)
	}
}

func FuzzMarkdown(f *testing.F) {
	for _, s := range []string{"*a _b_*", "[x](https://a)", "```go\nx```", "`c`", "||s||", "\\*", "😀__u__"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, src string) {
		text, ents, err := Markdown(src, opts)
		if err == nil {
			checkOutput(t, src, text, ents)
		}
	})
}

func FuzzHTML(f *testing.F) {
	for _, s := range []string{"<b>a<i>b</i></b>", `<a href="https://a">x</a>`, "<pre><code class=\"language-go\">x</code></pre>", "&amp;&#128512;"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, src string) {
		text, ents, err := HTML(src, opts)
		if err == nil {
			checkOutput(t, src, text, ents)
		}
	})
}
