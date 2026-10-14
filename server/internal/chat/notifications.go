package chat

import (
	"context"
	"fmt"

	appv1 "app.local/server/gen/app/v1"
)

// notifySettingsRow is a user's notification settings as stored.
type notifySettingsRow struct {
	PrivateEnabled, PrivatePreview   bool
	GroupsEnabled, GroupsPreview     bool
	ChannelsEnabled, ChannelsPreview bool
	Sound                            int16
	BadgeMuted                       bool
}

// defaultNotifySettings are the settings of a user without a row.
func defaultNotifySettings() notifySettingsRow {
	return notifySettingsRow{
		PrivateEnabled: true, PrivatePreview: true, GroupsEnabled: true, GroupsPreview: true,
		ChannelsEnabled: true, ChannelsPreview: true, Sound: int16(appv1.NotificationSound_NOTIFICATION_SOUND_DEFAULT),
	}
}

func (n notifySettingsRow) render() *appv1.NotificationSettings {
	return &appv1.NotificationSettings{
		PrivateEnabled: n.PrivateEnabled, PrivatePreview: n.PrivatePreview,
		GroupsEnabled: n.GroupsEnabled, GroupsPreview: n.GroupsPreview,
		ChannelsEnabled: n.ChannelsEnabled, ChannelsPreview: n.ChannelsPreview,
		Sound: appv1.NotificationSound(n.Sound), BadgeMuted: n.BadgeMuted,
	}
}

// loadNotifySettings reads a user's settings.
func loadNotifySettings(ctx context.Context, q querier, me int64) (notifySettingsRow, error) {
	n := defaultNotifySettings()
	err := q.QueryRow(ctx, `
		SELECT private_enabled, private_preview, groups_enabled, groups_preview, channels_enabled, channels_preview,
			sound, badge_muted FROM notification_settings WHERE user_id = $1`, me).Scan(&n.PrivateEnabled, &n.PrivatePreview, &n.GroupsEnabled, &n.GroupsPreview,
		&n.ChannelsEnabled, &n.ChannelsPreview, &n.Sound, &n.BadgeMuted)
	if err != nil && !isNoRows(err) {
		return n, fmt.Errorf("chat: load notification settings: %w", err)
	}
	return n, nil
}

// GetNotificationSettings returns my notification settings.
func (s *Service) GetNotificationSettings(ctx context.Context, me int64) (*appv1.NotificationSettings, error) {
	n, err := loadNotifySettings(ctx, s.pool, me)
	if err != nil {
		return nil, err
	}
	return n.render(), nil
}

// SetNotificationSettings changes the given settings; my sessions get the
// complete settings as notification_settings.
func (s *Service) SetNotificationSettings(ctx context.Context, me int64, req *appv1.SetNotificationSettingsRequest) (*appv1.SetNotificationSettingsResponse, error) {
	if req.Sound != nil {
		if v := req.GetSound(); v < appv1.NotificationSound_NOTIFICATION_SOUND_DEFAULT || v > appv1.NotificationSound_NOTIFICATION_SOUND_OFF {
			return nil, errInvalid("unknown notification sound")
		}
	}
	if err := s.allow(limitWrite, "write", me); err != nil {
		return nil, err
	}
	var out notifySettingsRow
	t, err := s.inTx(ctx, func(t *txn) error {
		// Serializes concurrent changes of one user (with or without a row).
		if _, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('chat:notify_settings:' || $1::bigint, 0))`, me); err != nil {
			return fmt.Errorf("chat: lock notification settings: %w", err)
		}
		n, err := loadNotifySettings(ctx, t.tx, me)
		if err != nil {
			return err
		}
		before := n
		for _, f := range []struct {
			dst *bool
			v   *bool
		}{
			{&n.PrivateEnabled, req.PrivateEnabled}, {&n.PrivatePreview, req.PrivatePreview},
			{&n.GroupsEnabled, req.GroupsEnabled}, {&n.GroupsPreview, req.GroupsPreview},
			{&n.ChannelsEnabled, req.ChannelsEnabled}, {&n.ChannelsPreview, req.ChannelsPreview},
			{&n.BadgeMuted, req.BadgeMuted},
		} {
			if f.v != nil {
				*f.dst = *f.v
			}
		}
		if req.Sound != nil {
			n.Sound = int16(req.GetSound())
		}
		out = n
		if n == before {
			return nil
		}
		if _, err := t.tx.Exec(ctx, `
			INSERT INTO notification_settings (user_id, private_enabled, private_preview, groups_enabled, groups_preview,
				channels_enabled, channels_preview, sound, badge_muted, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
			ON CONFLICT (user_id) DO UPDATE SET private_enabled = excluded.private_enabled,
				private_preview = excluded.private_preview, groups_enabled = excluded.groups_enabled,
				groups_preview = excluded.groups_preview, channels_enabled = excluded.channels_enabled,
				channels_preview = excluded.channels_preview, sound = excluded.sound,
				badge_muted = excluded.badge_muted, updated_at = now()`,
			me, n.PrivateEnabled, n.PrivatePreview, n.GroupsEnabled, n.GroupsPreview, n.ChannelsEnabled,
			n.ChannelsPreview, n.Sound, n.BadgeMuted); err != nil {
			return fmt.Errorf("chat: set notification settings: %w", err)
		}
		ev := t.event(kindNotifySettings, 0, me)
		t.toUsers(ev, []int64{me}, &appv1.Update{Kind: &appv1.Update_NotificationSettings{
			NotificationSettings: &appv1.UpdateNotificationSettings{Settings: n.render()},
		}})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &appv1.SetNotificationSettingsResponse{Settings: out.render(), Ack: t.ack(me, 0)}, nil
}
