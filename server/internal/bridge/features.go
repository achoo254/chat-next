package bridge

import "app.local/server/internal/bridge/feature"

// Featured is implemented by an adapter that says, feature by feature, what it
// can read from the other app and what Chat can change in it. An adapter that
// does not implement it gets its features worked out from its capabilities and
// the interfaces it implements (FeaturesOf), which is how the adapters written
// before features were named keep working.
type Featured interface {
	Features() map[feature.Feature]feature.Support
}

// FeaturesOf returns what the adapter supports, by feature. A feature that is
// not in the map is not supported in either direction.
func FeaturesOf(a Adapter) map[feature.Feature]feature.Support {
	if f, ok := a.(Featured); ok {
		return f.Features()
	}
	caps := a.Capabilities()
	_, sender := a.(Sender)
	_, pinReader := a.(PinReader)
	_, pinner := a.(Pinner)
	_, topicReader := a.(TopicReader)
	out := map[feature.Feature]feature.Support{
		feature.Messages: {In: caps.Has(CapHistory) || caps.Has(CapLive), Out: caps.Has(CapSend) && sender},
		// What the other app says is read, for the chats where it says it.
		feature.Read: {In: caps.Has(CapLive)},
	}
	if caps.Has(CapPins) && pinReader {
		out[feature.Pins] = feature.Support{In: true, Out: caps.Has(CapSend) && pinner}
	}
	if caps.Has(CapTopics) && topicReader {
		// Out is the pin of a topic: the rest of a topic's structure is not sent yet.
		out[feature.Topics] = feature.Support{In: true, Out: caps.Has(CapSend) && caps.Has(CapPins) && pinner}
	}
	return out
}
