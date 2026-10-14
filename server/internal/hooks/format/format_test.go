package format

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/entities"
)

var testOpts = Options{AppScheme: "com.example.chat", MaxLength: 4096, Location: time.FixedZone("ICT", 7*3600)}

// span is an entity as the text it covers.
type span struct {
	typ  appv1.EntityType
	text string
	url  string
	lang string
}

func spans(t *testing.T, text string, ents []*appv1.MessageEntity) []span {
	t.Helper()
	units := utf16.Encode([]rune(text))
	ss := make([]entities.Span, len(ents))
	out := make([]span, len(ents))
	for i, e := range ents {
		ss[i] = entities.Span{Offset: int(e.GetOffset()), Length: int(e.GetLength())}
		end := int(e.GetOffset() + e.GetLength())
		if end > len(units) {
			t.Fatalf("entity %d ends at %d past the text (%d units)", i, end, len(units))
		}
		out[i] = span{e.GetType(), string(utf16.Decode(units[e.GetOffset():end])), e.GetUrl(), e.GetLanguage()}
	}
	if errs := entities.Validate(text, ss); len(errs) > 0 {
		t.Fatalf("invalid entities %v in %q", errs, text)
	}
	return out
}

func hasSpan(list []span, want span) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

const (
	bold     = appv1.EntityType_ENTITY_TYPE_BOLD
	italic   = appv1.EntityType_ENTITY_TYPE_ITALIC
	code     = appv1.EntityType_ENTITY_TYPE_CODE
	pre      = appv1.EntityType_ENTITY_TYPE_PRE
	textLink = appv1.EntityType_ENTITY_TYPE_TEXT_LINK
	urlType  = appv1.EntityType_ENTITY_TYPE_URL
)

func TestSlackMrkdwn(t *testing.T) {
	cases := []struct {
		name, in, text string
		want           []span
	}{
		{"bold and code", "*Firing* Ổ đĩa sắp đầy trên db-02\n🖥️ Máy chủ: `db-02.example.invalid`",
			"Firing Ổ đĩa sắp đầy trên db-02\n🖥️ Máy chủ: db-02.example.invalid",
			[]span{{typ: bold, text: "Firing"}, {typ: code, text: "db-02.example.invalid"}}},
		{"links, broadcasts and escapes", "<https://runbook.example.invalid/disk|Mở runbook> <!here> &lt;b&gt; &amp;",
			"Mở runbook @here <b> &", []span{{typ: textLink, text: "Mở runbook", url: "https://runbook.example.invalid/disk"}}},
		{"no emphasis inside words", "snake_case_name and 2*3*4", "snake_case_name and 2*3*4", nil},
		{"code block with a title", "Run:\n```Kiểm tra nhanh\ndf -h /var/lib/postgresql\n```",
			"Run:\ndf -h /var/lib/postgresql", []span{{typ: pre, text: "df -h /var/lib/postgresql", lang: "Kiểm tra nhanh"}}},
		{"disallowed link scheme", "<javascript:alert(1)|click>", "click", nil},
		{"mattermost markdown", "[ops/deploy](https://gitlab.example.invalid/ops/deploy) **ok** ~gone~",
			"ops/deploy ok gone", []span{
				{typ: textLink, text: "ops/deploy", url: "https://gitlab.example.invalid/ops/deploy"},
				{typ: bold, text: "ok"}, {typ: appv1.EntityType_ENTITY_TYPE_STRIKE, text: "gone"}}},
		{"nested link in bold", "*see <https://a.example.invalid|this>*", "see this",
			[]span{{typ: bold, text: "see this"}, {typ: textLink, text: "this", url: "https://a.example.invalid"}}},
		{"bare url", "see https://example.invalid/x.", "see https://example.invalid/x.",
			[]span{{typ: urlType, text: "https://example.invalid/x"}}},
		{"utf-16 offsets after emoji", "😀 *a*", "😀 a", []span{{typ: bold, text: "a"}}},
		{"unclosed markers stay", "*not closed and _also", "*not closed and _also", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b := newBuilder(testOpts)
			b.markup(c.in, dialectSlack)
			text, ents, err := b.finish(false)
			if err != nil {
				t.Fatal(err)
			}
			if text != c.text {
				t.Fatalf("text %q, want %q", text, c.text)
			}
			got := spans(t, text, ents)
			if len(got) != len(c.want) {
				t.Fatalf("entities %+v, want %+v", got, c.want)
			}
			for _, w := range c.want {
				if !hasSpan(got, w) {
					t.Fatalf("entities %+v miss %+v", got, w)
				}
			}
		})
	}
	if spans(t, "😀 a", []*appv1.MessageEntity{{Type: bold, Offset: 3, Length: 1}})[0].text != "a" {
		t.Fatal("helper")
	}
}

func TestMarkdownDialect(t *testing.T) {
	b := newBuilder(testOpts)
	b.markup(`__u__ ||s|| \*not\* *b* _i_`, dialectMarkdown)
	text, ents, err := b.finish(true)
	if err != nil {
		t.Fatal(err)
	}
	if text != "u s *not* b i" {
		t.Fatalf("text %q", text)
	}
	got := spans(t, text, ents)
	for _, w := range []span{{typ: appv1.EntityType_ENTITY_TYPE_UNDERLINE, text: "u"},
		{typ: appv1.EntityType_ENTITY_TYPE_SPOILER, text: "s"}, {typ: bold, text: "b"}, {typ: italic, text: "i"}} {
		if !hasSpan(got, w) {
			t.Fatalf("entities %+v miss %+v", got, w)
		}
	}
}

func TestNative(t *testing.T) {
	n, err := Parse(Native, "application/json", []byte(`{
		"text": "Build #318 lỗi", "entities": [{"type": "bold", "offset": 0, "length": 10}],
		"buttons": [{"text": "Mở job", "url": "https://ci.example.invalid/318"}],
		"silent": true, "idempotency_key": "build-318", "group_key": "build", "status": "Failed",
		"priority": "alert", "timestamp": "2026-10-14T09:42:00+07:00"}`), testOpts)
	if err != nil {
		t.Fatal(err)
	}
	if n.Text != "Build #318 lỗi" || !hasSpan(spans(t, n.Text, n.Entities), span{typ: bold, text: "Build #318"}) {
		t.Fatalf("text %q entities %v", n.Text, n.Entities)
	}
	if len(n.Buttons) != 1 || n.Buttons[0][0].URL != "https://ci.example.invalid/318" || !n.Silent ||
		n.IdempotencyKey != "build-318" || n.GroupKey != "build" || n.Status != "failed" || n.Priority != PriorityAlert ||
		!n.SourceTime.Equal(time.Date(2026, 10, 14, 2, 42, 0, 0, time.UTC)) {
		t.Fatalf("controls %+v", n)
	}

	n, err = Parse(Native, "", []byte(`{"text": "*x* [doc](https://d.example.invalid)", "parse_mode": "markdown",
		"buttons": [[{"text": "a", "url": "https://a.example.invalid"}], [{"text": "b", "url": "mailto:ops@example.invalid"}]],
		"timestamp": 1760409600}`), testOpts)
	if err != nil {
		t.Fatal(err)
	}
	if n.Text != "x doc" || len(n.Buttons) != 2 || n.SourceTime.Unix() != 1760409600 || n.Priority != PriorityTransactional {
		t.Fatalf("markdown payload %+v", n)
	}

	long := `{"text": "` + strings.Repeat("a", 4097) + `"}`
	for name, tc := range map[string]struct{ body, reason string }{
		"bad json":       {`{"text": `, "invalid_json"},
		"empty text":     {`{"text": "  "}`, "text_empty"},
		"too long":       {long, "text_too_long"},
		"bad button url": {`{"text": "x", "buttons": [{"text": "x", "url": "javascript:alert(1)"}]}`, "url_not_allowed"},
		"bad link":       {`{"text": "x", "entities": [{"type": "text_link", "offset": 0, "length": 1, "url": "ftp://x"}]}`, "url_not_allowed"},
		"bad parse mode": {`{"text": "x", "parse_mode": "html"}`, "invalid_payload"},
		"bad priority":   {`{"text": "x", "priority": "urgent"}`, "invalid_payload"},
		"bad timestamp":  {`{"text": "x", "timestamp": "yesterday"}`, "invalid_payload"},
	} {
		_, err := Parse(Native, "application/json", []byte(tc.body), testOpts)
		fe, ok := AsError(err)
		if !ok || fe.Reason != tc.reason {
			t.Errorf("%s: err %v, want %s", name, err, tc.reason)
		}
	}
}

func TestAlertmanager(t *testing.T) {
	firing, err := Parse(Alertmanager, "application/json", fixture(t, "alertmanager-firing.json"), testOpts)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(firing.Text, "Firing DiskFull trên db-02\nỔ đĩa sắp đầy trên db-02\nused: 94% (ngưỡng 90%)") {
		t.Fatalf("firing text %q", firing.Text)
	}
	got := spans(t, firing.Text, firing.Entities)
	if !hasSpan(got, span{typ: bold, text: "Firing"}) || !hasSpan(got, span{typ: code, text: "env=prod job=node mountpoint=/var/lib/postgresql severity=critical"}) {
		t.Fatalf("firing entities %+v", got)
	}
	if !strings.Contains(firing.Text, "🕘 Bắt đầu: 09:42, 14/10") {
		t.Fatalf("firing time missing: %q", firing.Text)
	}
	if firing.GroupKey == "" || firing.Status != "firing" || !firing.SourceTime.Equal(time.Date(2026, 10, 14, 2, 42, 0, 0, time.UTC)) {
		t.Fatalf("firing controls %+v", firing)
	}
	if len(firing.Buttons) != 1 || len(firing.Buttons[0]) != 2 || firing.Buttons[0][1].Text != "Alertmanager" {
		t.Fatalf("firing buttons %+v", firing.Buttons)
	}

	resolved, err := Parse(Alertmanager, "application/json", fixture(t, "alertmanager-resolved.json"), testOpts)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(resolved.Text, "Resolved DiskFull trên db-02") || !strings.Contains(resolved.Text, "firing 09:42, 14/10 → resolved 10:05, 14/10") {
		t.Fatalf("resolved text %q", resolved.Text)
	}
	if resolved.GroupKey != firing.GroupKey || resolved.Status != "resolved" || !resolved.SourceTime.After(firing.SourceTime) {
		t.Fatalf("resolved controls %+v", resolved)
	}

	if _, err := Parse(Alertmanager, "", []byte(`{"status": "firing"}`), testOpts); err == nil {
		t.Fatal("a payload without alerts was accepted")
	}
}

func TestGrafana(t *testing.T) {
	n, err := Parse(Grafana, "application/json", fixture(t, "grafana-webhook.json"), testOpts)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(n.Text, "Firing HighCPU Lab (lab-174) trên lab-174") || !strings.Contains(n.Text, "📊 Giá trị: [ var='A'") {
		t.Fatalf("text %q", n.Text)
	}
	texts := []string{}
	for _, b := range n.Buttons[0] {
		texts = append(texts, b.Text)
	}
	if strings.Join(texts, ",") != "Mở nguồn,Dashboard,Panel,Tắt tiếng" || n.GroupKey == "" {
		t.Fatalf("buttons %v group %q", texts, n.GroupKey)
	}
}

func TestSlackFixtures(t *testing.T) {
	n, err := Parse(Slack, "application/json", fixture(t, "grafana-slack.json"), testOpts)
	if err != nil {
		t.Fatal(err)
	}
	got := spans(t, n.Text, n.Entities)
	for _, w := range []span{
		{typ: bold, text: "[FIRING:1] HighCPU Lab (lab-174)"},
		{typ: textLink, text: "[FIRING:1] HighCPU Lab (lab-174)", url: "https://grafana.example.invalid/alerting/list"},
		{typ: bold, text: "Alerts Firing:"},
		{typ: textLink, text: "Mở nguồn", url: "https://grafana.example.invalid/alerting/grafana/abc/view"},
		{typ: italic, text: "Grafana v11.2.0"},
	} {
		if !hasSpan(got, w) {
			t.Fatalf("grafana slack: %+v misses %+v in %q", got, w, n.Text)
		}
	}

	n, err = Parse(Slack, "application/json", fixture(t, "uptime-kuma-slack.json"), testOpts)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(n.Text, "Uptime Kuma Alert\nMessage\nconnect ECONNREFUSED") {
		t.Fatalf("uptime kuma text %q", n.Text)
	}
	if len(n.Buttons) != 1 || len(n.Buttons[0]) != 1 || n.Buttons[0][0].Text != "Visit Uptime Kuma" {
		t.Fatalf("uptime kuma buttons %+v (the javascript: one must be dropped)", n.Buttons)
	}

	n, err = Parse(Slack, "application/json", fixture(t, "gitlab-mattermost.json"), testOpts)
	if err != nil {
		t.Fatal(err)
	}
	got = spans(t, n.Text, n.Entities)
	if !hasSpan(got, span{typ: textLink, text: "ops/deploy", url: "https://gitlab.example.invalid/ops/deploy"}) ||
		!hasSpan(got, span{typ: bold, text: "nginx"}) {
		t.Fatalf("mattermost entities %+v in %q", got, n.Text)
	}

	form := url.Values{"payload": {`{"text": "*Jenkins* build ok"}`}}.Encode()
	n, err = Parse(Slack, "application/x-www-form-urlencoded", []byte(form), testOpts)
	if err != nil || n.Text != "Jenkins build ok" {
		t.Fatalf("form payload: %v %+v", err, n)
	}
}

func TestTruncation(t *testing.T) {
	long := "*" + strings.Repeat("ạ", 100) + "* " + strings.Repeat("😀", 5000)
	n, err := Parse(Slack, "application/json", []byte(`{"text": "`+long+`"}`), testOpts)
	if err != nil {
		t.Fatal(err)
	}
	if entities.CodePointLength(n.Text) != 4096 || !strings.HasSuffix(n.Text, "…") {
		t.Fatalf("length %d", entities.CodePointLength(n.Text))
	}
	spans(t, n.Text, n.Entities)
}

func TestGitLab(t *testing.T) {
	n, err := Parse(GitLab, "application/json", fixture(t, "gitlab-pipeline.json"), testOpts)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(n.Text, "Pipeline #5121 success trên main của ops/deploy\nChạy bởi Minh · 11m0s") {
		t.Fatalf("pipeline text %q", n.Text)
	}
	if n.GroupKey != "gitlab:pipeline:42:5121" || n.Status != "success" ||
		!n.SourceTime.Equal(time.Date(2026, 10, 14, 9, 12, 0, 0, time.UTC)) || n.Buttons[0][0].Text != "Mở pipeline" {
		t.Fatalf("pipeline controls %+v", n)
	}

	n, err = Parse(GitLab, "application/json", fixture(t, "gitlab-push.json"), testOpts)
	if err != nil {
		t.Fatal(err)
	}
	if n.Text != "Minh đã push 1 commit vào main của ops/deploy\n• d4e5f6a7 Fix nginx reload" || n.GroupKey != "" {
		t.Fatalf("push text %q", n.Text)
	}

	n, err = Parse(GitLab, "application/json", []byte(`{"object_kind": "build", "build_status": "running"}`), testOpts)
	if err != nil || !n.Ignored {
		t.Fatalf("job events must be ignored: %v %+v", err, n)
	}
	if _, err := Parse(GitLab, "application/json", []byte(`{"text": "x"}`), testOpts); err == nil {
		t.Fatal("a payload without object_kind was accepted")
	}
}

func TestLongGroupKeyIsHashed(t *testing.T) {
	n, err := Parse(Native, "", []byte(`{"text": "x", "group_key": "`+strings.Repeat("k", 300)+`"}`), testOpts)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(n.GroupKey, "sha256:") || len(n.GroupKey) > groupKeyMax {
		t.Fatalf("group key %q", n.GroupKey)
	}
}
