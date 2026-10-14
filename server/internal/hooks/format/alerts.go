package format

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	appv1 "app.local/server/gen/app/v1"
)

// alertGroup is an Alertmanager webhook notification (version 4); Grafana
// sends the same shape plus title, message and per-alert links.
type alertGroup struct {
	GroupKey          string            `json:"groupKey"`
	Status            string            `json:"status"`
	ExternalURL       string            `json:"externalURL"`
	TruncatedAlerts   int               `json:"truncatedAlerts"`
	GroupLabels       map[string]string `json:"groupLabels"`
	CommonLabels      map[string]string `json:"commonLabels"`
	CommonAnnotations map[string]string `json:"commonAnnotations"`
	Alerts            []alert           `json:"alerts"`
	// Grafana.
	Title   string `json:"title"`
	Message string `json:"message"`
}

type alert struct {
	Status       string            `json:"status"`
	Labels       map[string]string `json:"labels"`
	Annotations  map[string]string `json:"annotations"`
	StartsAt     time.Time         `json:"startsAt"`
	EndsAt       time.Time         `json:"endsAt"`
	GeneratorURL string            `json:"generatorURL"`
	// Grafana.
	DashboardURL string `json:"dashboardURL"`
	PanelURL     string `json:"panelURL"`
	SilenceURL   string `json:"silenceURL"`
	ValueString  string `json:"valueString"`
}

// alertsShownMax bounds the alerts listed in one message.
const alertsShownMax = 10

var grafanaTitlePrefix = regexp.MustCompile(`^\[(?i:firing|resolved)(:\d+)?\]\s*`)

// hostLabels name the machine an alert is about, in order of preference.
var hostLabels = []string{"instance", "host", "hostname", "node", "pod"}

// parseAlertmanager maps an Alertmanager (or Grafana) group notification.
// The group key updates one message in place; status firing/resolved and
// the newest startsAt/endsAt order the updates.
func parseAlertmanager(body []byte, opts Options, grafana bool) (*Notification, error) {
	var g alertGroup
	if err := decodeJSON(body, &g); err != nil {
		return nil, err
	}
	if len(g.Alerts) == 0 && g.Message == "" {
		return nil, errorf("invalid_payload", "no alerts in the payload")
	}
	status := strings.ToLower(firstNonEmpty(g.Status, "firing"))
	// Senders that omit the group's common labels (hand-written payloads):
	// a single alert's labels are the common ones.
	if len(g.Alerts) == 1 {
		if len(g.CommonLabels) == 0 {
			g.CommonLabels = g.Alerts[0].Labels
		}
		if len(g.CommonAnnotations) == 0 {
			g.CommonAnnotations = g.Alerts[0].Annotations
		}
	}
	b := newBuilder(opts)

	// Headline: status, alert name, host, count.
	b.styled(appv1.EntityType_ENTITY_TYPE_BOLD, statusWord(status))
	b.write(" " + cleanText(alertTitle(g, grafana)))
	if host := commonHost(g); host != "" {
		b.write(" trên " + cleanText(host))
	}
	if len(g.Alerts) > 1 {
		b.write(fmt.Sprintf(" (%d)", len(g.Alerts)))
	}
	if s := g.CommonAnnotations["summary"]; s != "" {
		b.newline()
		b.write(cleanText(s))
	}
	if d := g.CommonAnnotations["description"]; d != "" {
		b.newline()
		b.write(cleanText(d))
	}
	if labels := labelText(g.CommonLabels, nil); labels != "" {
		b.newline()
		b.write("🏷️ Nhãn: ")
		b.styled(appv1.EntityType_ENTITY_TYPE_CODE, labels)
	}

	for i, a := range g.Alerts {
		if i == alertsShownMax {
			b.newline()
			b.write(fmt.Sprintf("… và %d cảnh báo khác", len(g.Alerts)-alertsShownMax))
			break
		}
		b.alertLines(g, a, status, len(g.Alerts) > 1)
	}
	if g.TruncatedAlerts > 0 {
		b.newline()
		b.write(fmt.Sprintf("… Alertmanager đã lược %d cảnh báo", g.TruncatedAlerts))
	}
	if len(g.Alerts) == 0 && g.Message != "" {
		b.newline()
		b.write(cleanText(g.Message))
	}

	text, ents, err := b.finish(false)
	if err != nil {
		return nil, err
	}
	return &Notification{
		Text: text, Entities: ents, Buttons: keepButtons(alertButtons(g, grafana), opts),
		GroupKey: g.GroupKey, Status: status, SourceTime: alertSourceTime(g, status),
	}, nil
}

// alertLines writes one alert: its own name and host when the group has
// several, summary and description not common to the group, value, labels
// not common to the group, and its times.
func (b *builder) alertLines(g alertGroup, a alert, groupStatus string, several bool) {
	if several {
		b.newline()
		b.write("• ")
		name := firstNonEmpty(a.Labels["alertname"], "alert")
		if a.Status != "" && a.Status != groupStatus {
			b.styled(appv1.EntityType_ENTITY_TYPE_ITALIC, statusWord(a.Status))
			b.write(" ")
		}
		b.write(cleanText(name))
		if host := hostOf(a.Labels); host != "" && host != commonHost(g) {
			b.write(" trên " + cleanText(host))
		}
	}
	if s := a.Annotations["summary"]; s != "" && s != g.CommonAnnotations["summary"] {
		b.newline()
		b.write(cleanText(s))
	}
	if d := a.Annotations["description"]; d != "" && d != g.CommonAnnotations["description"] {
		b.newline()
		b.write(cleanText(d))
	}
	b.field("📊 Giá trị", cleanText(a.ValueString))
	if labels := labelText(a.Labels, g.CommonLabels); labels != "" {
		b.newline()
		b.write("🏷️ Nhãn: ")
		b.styled(appv1.EntityType_ENTITY_TYPE_CODE, labels)
	}
	loc := b.opts.Location
	switch {
	case a.Status == "resolved" && !a.EndsAt.IsZero() && !a.StartsAt.IsZero():
		b.field("🕘 Thời gian", fmt.Sprintf("firing %s → resolved %s", clock(a.StartsAt, loc), clock(a.EndsAt, loc)))
	case !a.StartsAt.IsZero():
		b.field("🕘 Bắt đầu", clock(a.StartsAt, loc))
	}
}

func statusWord(status string) string {
	switch strings.ToLower(status) {
	case "firing", "alerting":
		return "Firing"
	case "resolved", "ok", "normal":
		return "Resolved"
	default:
		if status == "" {
			return "Alert"
		}
		r := []rune(status)
		return strings.ToUpper(string(r[:1])) + string(r[1:])
	}
}

func alertTitle(g alertGroup, grafana bool) string {
	if grafana && g.Title != "" {
		return grafanaTitlePrefix.ReplaceAllString(g.Title, "")
	}
	if name := firstNonEmpty(g.GroupLabels["alertname"], g.CommonLabels["alertname"]); name != "" {
		return name
	}
	if len(g.Alerts) > 0 {
		if name := g.Alerts[0].Labels["alertname"]; name != "" && len(g.Alerts) == 1 {
			return name
		}
	}
	return fmt.Sprintf("%d cảnh báo", len(g.Alerts))
}

func hostOf(labels map[string]string) string {
	for _, k := range hostLabels {
		if v := labels[k]; v != "" {
			return v
		}
	}
	return ""
}

func commonHost(g alertGroup) string {
	return hostOf(g.CommonLabels)
}

// labelText renders labels as "k=v k=v" (sorted), without the name and host
// shown in the headline and without the labels in common.
func labelText(labels, common map[string]string) string {
	keys := make([]string, 0, len(labels))
	for k, v := range labels {
		if k == "alertname" || slices.Contains(hostLabels, k) || (common != nil && common[k] == v) {
			continue
		}
		keys = append(keys, k)
	}
	slices.Sort(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + "=" + labels[k]
	}
	return cleanText(strings.Join(parts, " "))
}

func clock(t time.Time, loc *time.Location) string {
	return t.In(loc).Format("15:04, 02/01")
}

// alertButtons links the source of the first alert and, for Grafana, its
// dashboard, panel and silence pages; for Alertmanager its own UI.
func alertButtons(g alertGroup, grafana bool) [][]Button {
	var row []Button
	add := func(text, url string) {
		if url != "" {
			row = append(row, Button{Text: text, URL: url})
		}
	}
	if len(g.Alerts) > 0 {
		a := g.Alerts[0]
		add("Mở nguồn", a.GeneratorURL)
		if grafana {
			add("Dashboard", a.DashboardURL)
			add("Panel", a.PanelURL)
			add("Tắt tiếng", a.SilenceURL)
		}
	}
	if !grafana {
		add("Alertmanager", g.ExternalURL)
	}
	if len(row) == 0 {
		return nil
	}
	return [][]Button{row}
}

// alertSourceTime orders updates of a group: the newest end of a resolved
// group, the newest start of a firing one.
func alertSourceTime(g alertGroup, status string) time.Time {
	var newest time.Time
	for _, a := range g.Alerts {
		t := a.StartsAt
		if status == "resolved" && !a.EndsAt.IsZero() {
			t = a.EndsAt
		}
		if t.After(newest) {
			newest = t
		}
	}
	return newest
}
