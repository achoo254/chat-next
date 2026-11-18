package engine

import (
	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
	"encoding/json"
)

// featureOfOp is the feature an op that acts on people belongs to, for the audit log
// (a table, not the handlers: the handlers refer to the code that writes the log).
func featureOfOp(op string) string {
	switch op {
	case "invite_create", "invite_revoke":
		return string(feature.Invites)
	case "group_leave", "group_delete":
		return string(feature.Lifecycle)
	}
	return string(feature.Members)
}

var permBits = []struct {
	bit uint32
	get func(*bridge.Perms) *bool
}{
	{uint32(appv1.ChatPermission_CHAT_PERMISSION_SEND_MESSAGES), func(p *bridge.Perms) *bool { return &p.Send }},
	{uint32(appv1.ChatPermission_CHAT_PERMISSION_SEND_MEDIA), func(p *bridge.Perms) *bool { return &p.Media }},
	{uint32(appv1.ChatPermission_CHAT_PERMISSION_ADD_MEMBERS), func(p *bridge.Perms) *bool { return &p.AddMembers }},
	{uint32(appv1.ChatPermission_CHAT_PERMISSION_PIN_MESSAGES), func(p *bridge.Perms) *bool { return &p.Pin }},
	{uint32(appv1.ChatPermission_CHAT_PERMISSION_CHANGE_INFO), func(p *bridge.Perms) *bool { return &p.ChangeInfo }},
	{uint32(appv1.ChatPermission_CHAT_PERMISSION_MANAGE_TOPICS), func(p *bridge.Perms) *bool { return &p.ManageTopics }},
}

// permsOfBits turns the permissions of Chat (a bit set) into what an adapter takes.
func permsOfBits(bits uint32) bridge.Perms {
	var p bridge.Perms
	for _, b := range permBits {
		*b.get(&p) = bits&b.bit != 0
	}
	return p
}

// bitsOfPerms is the other way.
func bitsOfPerms(p bridge.Perms) uint32 {
	var bits uint32
	for _, b := range permBits {
		if *b.get(&p) {
			bits |= b.bit
		}
	}
	return bits
}

func jsonBytes(v any) ([]byte, error) { return json.Marshal(v) }
