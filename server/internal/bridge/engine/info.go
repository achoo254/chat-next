package engine

import (
	"context"
	"encoding/json"
	"time"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/chat"
)

// infoEvery: the info of a group changes rarely and costs a call per group, so it
// is read once in this many looks at the state of the chats.
const infoEvery = 5

// pollInfo reads the title and description of the synced groups and makes Chat
// match them, as pollDialogs does for the state in the list: the other app is the
// source unless Chat has a change waiting to go out.
func (r *runner) pollInfo(ctx context.Context) error {
	reader, ok := r.adapter.(bridge.InfoReader)
	if !ok || !bridge.FeaturesOf(r.adapter)[feature.Info].In {
		return nil
	}
	r.infoTick++
	if (r.infoTick-1)%infoEvery != 0 {
		return nil
	}
	var convs []string
	for conv, l := range r.links {
		if !l.BackfillDone {
			continue
		}
		dir, err := r.e.db.featureDirection(ctx, r.account.ID, l.ExternalChat, feature.Info)
		if err != nil {
			return err
		}
		if dir.Receives() {
			convs = append(convs, conv)
		}
	}
	for start := 0; start < len(convs); start += dialogBatch {
		batch := convs[start:min(start+dialogBatch, len(convs))]
		infos, err := retryRateLimit(ctx, func() (map[string]bridge.GroupInfo, error) { return reader.GroupInfos(ctx, r.acct, batch) })
		if err != nil {
			return err
		}
		for _, conv := range batch {
			info, ok := infos[conv]
			l := r.links[conv]
			if !ok || l == nil {
				continue
			}
			if pending, err := r.e.db.pendingOp(ctx, l.ChatID, "set_info"); err != nil {
				return err
			} else if pending {
				continue
			}
			if err := r.withLink(ctx, l, func(it *chat.ImportTx) error {
				_, err := it.SetInfo(ctx, info.Title, info.About)
				return err
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

// doInfo sends the title and description wanted by a row of info.
func (r *runner) doInfo(ctx context.Context, h *outboxRow) error {
	db := r.e.db
	writer, ok := r.adapter.(bridge.InfoWriter)
	if !ok {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "info_unsupported: this app cannot take this from Chat", time.Time{})
	}
	var p struct {
		Title string `json:"title"`
		About string `json:"about"`
	}
	if err := json.Unmarshal(h.Payload, &p); err != nil {
		return db.setOutbox(ctx, []int64{h.ID}, "failed", "bad payload", time.Time{})
	}
	if err := db.startSending(ctx, []int64{h.ID}); err != nil {
		return err
	}
	if err := writer.SetGroupInfo(ctx, r.acct, h.ExternalChat, bridge.GroupInfo{Title: p.Title, About: p.About}); err != nil {
		if serr := r.settleCall(ctx, []*outboxRow{h}, err); serr != nil {
			return serr
		}
		return r.putBackAfterFailure(ctx, h)
	}
	return db.setOutbox(ctx, []int64{h.ID}, "sent", "", time.Time{})
}

// putBackAfterFailure, once a row is failed for good, makes Chat show again what the
// other app has, for the features whose state is read: the next look at the other
// app does it for info, so only the failure is recorded here.
func (r *runner) putBackAfterFailure(ctx context.Context, h *outboxRow) error {
	var status string
	if err := r.e.db.pool.QueryRow(ctx, `SELECT status FROM external_outbox WHERE id = $1`, h.ID).Scan(&status); err != nil {
		return err
	}
	if status == "failed" {
		r.infoTick = 0 // the next look is now: Chat takes the other app's title back
	}
	return nil
}
