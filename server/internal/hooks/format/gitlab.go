package format

import (
	"fmt"
	"strings"
	"time"

	appv1 "app.local/server/gen/app/v1"
)

// gitlabEvent is the subset of GitLab project webhook payloads the mapper
// reads (push, tag_push, merge_request, pipeline, deployment, issue, note,
// release). Other event kinds are accepted and ignored, because GitLab
// disables a webhook that keeps failing.
type gitlabEvent struct {
	ObjectKind        string         `json:"object_kind"`
	UserName          string         `json:"user_name"`
	User              gitlabUser     `json:"user"`
	Ref               string         `json:"ref"`
	After             string         `json:"after"`
	TotalCommitsCount int            `json:"total_commits_count"`
	Commits           []gitlabCommit `json:"commits"`
	Project           gitlabProject  `json:"project"`
	ObjectAttributes  gitlabAttrs    `json:"object_attributes"`
	MergeRequest      *gitlabRef     `json:"merge_request"`
	Issue             *gitlabRef     `json:"issue"`
	Commit            *gitlabRef     `json:"commit"`
	// deployment
	Status          string `json:"status"`
	DeploymentID    int64  `json:"deployment_id"`
	Environment     string `json:"environment"`
	DeployableURL   string `json:"deployable_url"`
	ShortSHA        string `json:"short_sha"`
	StatusChangedAt string `json:"status_changed_at"`
	// release
	Name   string `json:"name"`
	Tag    string `json:"tag"`
	URL    string `json:"url"`
	Action string `json:"action"`
}

type gitlabUser struct {
	Name     string `json:"name"`
	Username string `json:"username"`
}

type gitlabCommit struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

type gitlabProject struct {
	ID                int64  `json:"id"`
	Name              string `json:"name"`
	PathWithNamespace string `json:"path_with_namespace"`
	WebURL            string `json:"web_url"`
}

type gitlabAttrs struct {
	ID           int64  `json:"id"`
	IID          int64  `json:"iid"`
	Title        string `json:"title"`
	URL          string `json:"url"`
	State        string `json:"state"`
	Action       string `json:"action"`
	Status       string `json:"status"`
	Ref          string `json:"ref"`
	SourceBranch string `json:"source_branch"`
	TargetBranch string `json:"target_branch"`
	Note         string `json:"note"`
	NoteableType string `json:"noteable_type"`
	Duration     *int64 `json:"duration"`
	CreatedAt    string `json:"created_at"`
	FinishedAt   string `json:"finished_at"`
}

type gitlabRef struct {
	IID   int64  `json:"iid"`
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

const (
	gitlabCommitsShown = 5
	gitlabNoteMax      = 300
	zeroSHA            = "0000000000000000000000000000000000000000"
)

var gitlabActions = map[string]string{
	"open": "đã mở", "reopen": "đã mở lại", "close": "đã đóng", "update": "đã cập nhật", "merge": "đã merge",
	"approved": "đã duyệt", "approval": "đã duyệt", "unapproved": "đã bỏ duyệt", "unapproval": "đã bỏ duyệt",
	"create": "đã tạo",
}

func parseGitLab(body []byte, opts Options) (*Notification, error) {
	var e gitlabEvent
	if err := decodeJSON(body, &e); err != nil {
		return nil, err
	}
	if e.ObjectKind == "" {
		return nil, errorf("invalid_payload", "not a GitLab webhook payload (no object_kind)")
	}
	b := newBuilder(opts)
	n := &Notification{}
	user := cleanText(firstNonEmpty(e.User.Name, e.UserName, e.User.Username, "Ai đó"))
	project := func() {
		b.link(cleanText(firstNonEmpty(e.Project.PathWithNamespace, e.Project.Name)), e.Project.WebURL)
	}
	branch := strings.TrimPrefix(strings.TrimPrefix(e.Ref, "refs/heads/"), "refs/tags/")
	a := e.ObjectAttributes

	switch e.ObjectKind {
	case "push":
		b.styled(appv1.EntityType_ENTITY_TYPE_BOLD, user)
		switch {
		case e.After == zeroSHA:
			b.write(" đã xoá nhánh ")
		case e.TotalCommitsCount == 0:
			b.write(" đã tạo nhánh ")
		default:
			b.write(fmt.Sprintf(" đã push %d commit vào ", e.TotalCommitsCount))
		}
		b.styled(appv1.EntityType_ENTITY_TYPE_CODE, cleanText(branch))
		b.write(" của ")
		project()
		for i, c := range e.Commits {
			if i == gitlabCommitsShown {
				b.newline()
				b.write(fmt.Sprintf("… và %d commit khác", len(e.Commits)-gitlabCommitsShown))
				break
			}
			b.newline()
			b.write("• ")
			b.link(shortSHA(c.ID), c.URL)
			b.write(" " + cleanText(c.Title))
		}
	case "tag_push":
		b.styled(appv1.EntityType_ENTITY_TYPE_BOLD, user)
		if e.After == zeroSHA {
			b.write(" đã xoá tag ")
		} else {
			b.write(" đã đẩy tag ")
		}
		b.styled(appv1.EntityType_ENTITY_TYPE_CODE, cleanText(branch))
		b.write(" lên ")
		project()
	case "merge_request":
		b.styled(appv1.EntityType_ENTITY_TYPE_BOLD, user)
		b.write(" " + gitlabAction(a.Action) + " merge request ")
		b.link(fmt.Sprintf("!%d %s", a.IID, cleanText(a.Title)), a.URL)
		b.write(" trong ")
		project()
		if a.SourceBranch != "" && a.TargetBranch != "" {
			b.newline()
			b.styled(appv1.EntityType_ENTITY_TYPE_CODE, cleanText(a.SourceBranch))
			b.write(" → ")
			b.styled(appv1.EntityType_ENTITY_TYPE_CODE, cleanText(a.TargetBranch))
		}
		n.GroupKey = fmt.Sprintf("gitlab:mr:%d:%d", e.Project.ID, a.IID)
		n.Status = a.State
		n.Buttons = [][]Button{{{Text: "Mở trên GitLab", URL: a.URL}}}
	case "pipeline":
		url := firstNonEmpty(a.URL, fmt.Sprintf("%s/-/pipelines/%d", e.Project.WebURL, a.ID))
		b.write("Pipeline ")
		b.link(fmt.Sprintf("#%d", a.ID), url)
		b.write(" ")
		b.styled(appv1.EntityType_ENTITY_TYPE_BOLD, cleanText(firstNonEmpty(a.Status, "unknown")))
		b.write(" trên ")
		b.styled(appv1.EntityType_ENTITY_TYPE_CODE, cleanText(a.Ref))
		b.write(" của ")
		project()
		b.newline()
		b.write("Chạy bởi " + user)
		if a.Duration != nil && *a.Duration > 0 {
			b.write(fmt.Sprintf(" · %s", time.Duration(*a.Duration)*time.Second))
		}
		n.GroupKey = fmt.Sprintf("gitlab:pipeline:%d:%d", e.Project.ID, a.ID)
		n.Status = a.Status
		n.SourceTime = gitlabTime(firstNonEmpty(a.FinishedAt, a.CreatedAt))
		n.Buttons = [][]Button{{{Text: "Mở pipeline", URL: url}}}
	case "deployment":
		b.write("Deploy ")
		b.styled(appv1.EntityType_ENTITY_TYPE_BOLD, cleanText(firstNonEmpty(e.Status, "unknown")))
		b.write(" lên ")
		b.styled(appv1.EntityType_ENTITY_TYPE_CODE, cleanText(e.Environment))
		b.write(" của ")
		project()
		if e.ShortSHA != "" {
			b.write(" (" + cleanText(e.ShortSHA) + ")")
		}
		n.GroupKey = fmt.Sprintf("gitlab:deployment:%d:%d", e.Project.ID, e.DeploymentID)
		n.Status = e.Status
		n.SourceTime = gitlabTime(e.StatusChangedAt)
		n.Buttons = [][]Button{{{Text: "Mở job", URL: e.DeployableURL}}}
	case "issue":
		b.styled(appv1.EntityType_ENTITY_TYPE_BOLD, user)
		b.write(" " + gitlabAction(a.Action) + " issue ")
		b.link(fmt.Sprintf("#%d %s", a.IID, cleanText(a.Title)), a.URL)
		b.write(" trong ")
		project()
	case "note":
		b.styled(appv1.EntityType_ENTITY_TYPE_BOLD, user)
		b.write(" đã bình luận ở ")
		b.link(noteTarget(e), a.URL)
		b.write(" trong ")
		project()
		if note := strings.TrimSpace(cleanText(a.Note)); note != "" {
			if r := []rune(note); len(r) > gitlabNoteMax {
				note = string(r[:gitlabNoteMax]) + "…"
			}
			b.newline()
			b.styled(appv1.EntityType_ENTITY_TYPE_ITALIC, note)
		}
	case "release":
		b.write("Phát hành ")
		b.link(cleanText(firstNonEmpty(e.Name, e.Tag)), e.URL)
		if e.Tag != "" && e.Tag != e.Name {
			b.write(" (")
			b.styled(appv1.EntityType_ENTITY_TYPE_CODE, cleanText(e.Tag))
			b.write(")")
		}
		b.write(" trong ")
		project()
	default:
		return &Notification{Ignored: true}, nil
	}
	text, ents, err := b.finish(false)
	if err != nil {
		return nil, err
	}
	n.Text, n.Entities, n.Buttons = text, ents, keepButtons(n.Buttons, opts)
	n.Status = strings.ToLower(n.Status)
	return n, nil
}

func gitlabAction(action string) string {
	if v, ok := gitlabActions[action]; ok {
		return v
	}
	if action == "" {
		return "đã cập nhật"
	}
	return "đã " + cleanText(action)
}

func noteTarget(e gitlabEvent) string {
	switch e.ObjectAttributes.NoteableType {
	case "MergeRequest":
		if e.MergeRequest != nil {
			return fmt.Sprintf("merge request !%d %s", e.MergeRequest.IID, cleanText(e.MergeRequest.Title))
		}
	case "Issue":
		if e.Issue != nil {
			return fmt.Sprintf("issue #%d %s", e.Issue.IID, cleanText(e.Issue.Title))
		}
	case "Commit":
		if e.Commit != nil {
			return "commit " + shortSHA(e.Commit.ID)
		}
	default:
	}
	return "một mục"
}

func shortSHA(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// gitlabTime reads GitLab's "2026-10-14 09:42:00 UTC" or RFC 3339; zero
// when absent or unreadable.
func gitlabTime(s string) time.Time {
	for _, layout := range []string{"2006-01-02 15:04:05 MST", "2006-01-02 15:04:05 -0700", time.RFC3339Nano} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}
