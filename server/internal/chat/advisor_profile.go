package chat

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	appv1 "app.local/server/gen/app/v1"
)

const (
	// advisorNameMax is the longest Advisor name, in characters.
	advisorNameMax = 32
	// defaultAdvisorLook is the look of a user who never picked one.
	defaultAdvisorLook = "owl"
)

// advisorLookPattern is the shape of a look id; which looks exist is the
// client's to say (an unknown one shows the client's first look).
var advisorLookPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// advisorProfileRow is a user's Advisor profile as stored.
type advisorProfileRow struct {
	Name   string
	LookID string
	Tone   int16
}

// defaultAdvisorProfile is the profile of a user without a row.
func defaultAdvisorProfile() advisorProfileRow {
	return advisorProfileRow{LookID: defaultAdvisorLook, Tone: int16(appv1.AdvisorTone_ADVISOR_TONE_SHORT)}
}

func (a advisorProfileRow) render() *appv1.AdvisorProfile {
	return &appv1.AdvisorProfile{Name: a.Name, LookId: a.LookID, Tone: appv1.AdvisorTone(a.Tone)}
}

// loadAdvisorProfile reads a user's profile; the defaults without a row.
func loadAdvisorProfile(ctx context.Context, q querier, me int64) (advisorProfileRow, error) {
	a := defaultAdvisorProfile()
	err := q.QueryRow(ctx, `SELECT name, look_id, tone FROM advisor_profiles WHERE user_id = $1`, me).Scan(&a.Name, &a.LookID, &a.Tone)
	if err != nil && !isNoRows(err) {
		return a, fmt.Errorf("chat: load advisor profile: %w", err)
	}
	return a, nil
}

// cleanAdvisorName trims a name and checks it; ok is false for one too long
// or with control characters.
func cleanAdvisorName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) > advisorNameMax {
		return "", false
	}
	for _, r := range name {
		if unicode.IsControl(r) || r == ' ' || r == ' ' {
			return "", false
		}
	}
	return name, true
}

// GetAdvisorProfile returns my Advisor profile.
func (s *Service) GetAdvisorProfile(ctx context.Context, me int64) (*appv1.AdvisorProfile, error) {
	a, err := loadAdvisorProfile(ctx, s.pool, me)
	if err != nil {
		return nil, err
	}
	return a.render(), nil
}

// SetAdvisorProfile changes the given fields; my sessions get the complete
// profile as advisor_profile. Nothing is written when nothing changes.
func (s *Service) SetAdvisorProfile(ctx context.Context, me int64, req *appv1.SetAdvisorProfileRequest) (*appv1.SetAdvisorProfileResponse, error) {
	var name string
	if req.Name != nil {
		cleaned, ok := cleanAdvisorName(req.GetName())
		if !ok {
			return nil, errInvalid("name must be at most %d characters without control characters", advisorNameMax)
		}
		name = cleaned
	}
	if req.LookId != nil && !advisorLookPattern.MatchString(req.GetLookId()) {
		return nil, errInvalid("look_id must be 1 to 32 lowercase letters, digits or -, starting with a letter")
	}
	if req.Tone != nil {
		if v := req.GetTone(); v < appv1.AdvisorTone_ADVISOR_TONE_SHORT || v > appv1.AdvisorTone_ADVISOR_TONE_SERIOUS {
			return nil, errInvalid("unknown advisor tone")
		}
	}
	if err := s.allow(ctx, limitWrite, "write", me); err != nil {
		return nil, err
	}
	var out advisorProfileRow
	t, err := s.inTx(ctx, func(t *txn) error {
		// Serializes concurrent changes of one user (with or without a row).
		if _, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('chat:advisor_profile:' || $1::bigint, 0))`, me); err != nil {
			return fmt.Errorf("chat: lock advisor profile: %w", err)
		}
		a, err := loadAdvisorProfile(ctx, t.tx, me)
		if err != nil {
			return err
		}
		before := a
		if req.Name != nil {
			a.Name = name
		}
		if req.LookId != nil {
			a.LookID = req.GetLookId()
		}
		if req.Tone != nil {
			a.Tone = int16(req.GetTone())
		}
		out = a
		if a == before {
			return nil
		}
		if _, err := t.tx.Exec(ctx, `
			INSERT INTO advisor_profiles (user_id, name, look_id, tone, updated_at)
			VALUES ($1, $2, $3, $4, now())
			ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, look_id = excluded.look_id,
				tone = excluded.tone, updated_at = now()`,
			me, a.Name, a.LookID, a.Tone); err != nil {
			return fmt.Errorf("chat: set advisor profile: %w", err)
		}
		t.toUsers(t.event(kindAdvisorProfile, 0, me), []int64{me}, &appv1.Update{Kind: &appv1.Update_AdvisorProfile{
			AdvisorProfile: &appv1.UpdateAdvisorProfile{Profile: a.render()},
		}})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &appv1.SetAdvisorProfileResponse{Profile: out.render(), Ack: t.ack(me, 0)}, nil
}
