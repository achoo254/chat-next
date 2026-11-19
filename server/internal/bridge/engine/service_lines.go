package engine

import (
	"context"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"app.local/server/internal/chat"
)

// keepServiceLines drops the system lines of a batch when the service feature does
// not receive for the chat; the other messages stay in order.
func (r *runner) keepServiceLines(ctx context.Context, l *chatLink, msgs []bridge.Message) ([]bridge.Message, error) {
	has := false
	for _, m := range msgs {
		if m.Service != nil {
			has = true
			break
		}
	}
	if !has {
		return msgs, nil
	}
	dir, err := r.e.db.featureDirection(ctx, r.account.ID, l.ExternalChat, feature.Service)
	if err != nil || dir.Receives() {
		return msgs, err
	}
	out := msgs[:0:0]
	for _, m := range msgs {
		if m.Service == nil {
			out = append(out, m)
		}
	}
	return out, nil
}

// serviceAction turns a system line of the other app into Chat's action. ok is false
// for a line that cannot be shown: a pin of a message Chat does not have.
func (r *runner) serviceAction(ctx context.Context, it *chat.ImportTx, l *chatLink, s *bridge.ServiceAction, from int64) (*appv1.MessageAction, bool, error) {
	users := func() ([]int64, error) {
		ids := make([]int64, 0, len(s.People))
		for _, p := range s.People {
			id, err := r.e.db.ensurePuppet(ctx, r.account, p)
			if err != nil {
				return nil, err
			}
			ids = append(ids, id)
		}
		return ids, nil
	}
	switch s.Kind {
	case bridge.ServiceChatCreated:
		return &appv1.MessageAction{Kind: &appv1.MessageAction_ChatCreated{ChatCreated: &appv1.ActionChatCreated{Title: s.Title}}}, true, nil
	case bridge.ServiceMembersAdded:
		ids, err := users()
		if err != nil || len(ids) == 0 {
			return nil, false, err
		}
		return &appv1.MessageAction{Kind: &appv1.MessageAction_MembersAdded{MembersAdded: &appv1.ActionMembersAdded{UserIds: ids}}}, true, nil
	case bridge.ServiceMemberLeft:
		return &appv1.MessageAction{Kind: &appv1.MessageAction_MemberLeft{MemberLeft: &appv1.ActionMemberLeft{}}}, true, nil
	case bridge.ServiceMemberRemoved:
		ids, err := users()
		if err != nil || len(ids) == 0 {
			return nil, false, err
		}
		return &appv1.MessageAction{Kind: &appv1.MessageAction_MemberRemoved{MemberRemoved: &appv1.ActionMemberRemoved{UserId: ids[0], By: from}}}, true, nil
	case bridge.ServiceJoinedByLink:
		return &appv1.MessageAction{Kind: &appv1.MessageAction_JoinedByInvite{JoinedByInvite: &appv1.ActionJoinedByInvite{}}}, true, nil
	case bridge.ServiceTitleChanged:
		return &appv1.MessageAction{Kind: &appv1.MessageAction_TitleChanged{TitleChanged: &appv1.ActionTitleChanged{Title: s.Title}}}, true, nil
	case bridge.ServicePhotoChanged:
		return &appv1.MessageAction{Kind: &appv1.MessageAction_PhotoChanged{PhotoChanged: &appv1.ActionPhotoChanged{}}}, true, nil
	case bridge.ServicePhotoRemoved:
		return &appv1.MessageAction{Kind: &appv1.MessageAction_PhotoRemoved{PhotoRemoved: &appv1.ActionPhotoRemoved{}}}, true, nil
	case bridge.ServiceMessagePinned:
		target, err := lookupMessage(ctx, it.Tx(), r.account.ID, l.ExternalChat, s.MessageID)
		if err != nil || target == nil {
			return nil, false, err
		}
		return &appv1.MessageAction{Kind: &appv1.MessageAction_MessagePinned{MessagePinned: &appv1.ActionMessagePinned{Seq: target.Seq}}}, true, nil
	}
	return nil, false, nil
}
