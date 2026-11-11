package chat

import (
	"context"

	appv1 "app.local/server/gen/app/v1"
)

// AnnounceAgentProjectsChanged tells every session of userID that the
// user's AI Agent projects or workspaces changed (AgentProjectsService), so
// other devices list them again. The update is a hint without content; it
// goes through the user's log, so a session that was offline learns it with
// GetDifference.
func (s *Service) AnnounceAgentProjectsChanged(ctx context.Context, userID int64) error {
	_, err := s.inTx(ctx, func(t *txn) error {
		t.toUsers(t.event(kindAgentProjectsChanged, 0, userID), []int64{userID}, &appv1.Update{
			Kind: &appv1.Update_AgentProjectsChanged{AgentProjectsChanged: &appv1.UpdateAgentProjectsChanged{}},
		})
		return nil
	})
	return err
}
