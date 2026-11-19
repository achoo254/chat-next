package contracttest

import (
	"context"
	"strconv"
	"strings"
	"time"

	"app.local/server/internal/bridge"
)

// Forwards lists the native forwards Chat asked for, as "<from>:<ids>><to>[/topic]".
func (f *Fake) Forwards() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.forwards...)
}

// ForwardMessages implements bridge.Forwarder. A repeated randomID answers what was
// forwarded already; like the other app it tells of the new messages (EchoSent).
func (f *Fake) ForwardMessages(_ context.Context, _ bridge.Account, fromConv string, ids []string, toConv, topic string, randomID int64) (bridge.SentRef, error) {
	f.mu.Lock()
	if ref, ok := f.sentByRandom[randomID]; ok && f.DedupeRandomID {
		f.mu.Unlock()
		return ref, nil
	}
	ref := bridge.SentRef{Date: time.Now()}
	var echoes []bridge.Message
	for range ids {
		f.nextID++
		id := strconv.Itoa(f.nextID)
		ref.IDs = append(ref.IDs, id)
		echoes = append(echoes, bridge.Message{Conversation: toConv, ID: id, From: bridge.Participant{ID: "self", IsSelf: true}, Date: ref.Date, Topic: topic,
			Forward: &bridge.ForwardInfo{Name: "forwarded", Date: ref.Date}})
	}
	call := fromConv + ":" + strings.Join(ids, ",") + ">" + toConv
	if topic != "" {
		call += "/" + topic
	}
	f.forwards = append(f.forwards, call)
	f.sentByRandom[randomID] = ref
	echo := f.EchoSent
	f.mu.Unlock()
	if echo {
		for i := range echoes {
			msg := echoes[i]
			f.Push(bridge.Event{Message: &msg})
		}
	}
	return ref, nil
}

var _ bridge.Forwarder = (*Fake)(nil)
