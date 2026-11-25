package feature

import "slices"

// telegramReactions are the emoji Telegram lets a person react with (its Bot API
// documents the same list). Telegram refuses any other emoji, and a group may allow
// fewer; Chat only offers and accepts these on a chat synced with Telegram.
var telegramReactions = []string{
	"❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊",
	"🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾",
	"💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅",
	"🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
}

// ReactionsOf lists the emoji the app named app accepts as a reaction, and false
// when it accepts any (or is not known to restrict them).
func ReactionsOf(app string) ([]string, bool) {
	if app == "telegram" {
		return telegramReactions, true
	}
	return nil, false
}

// ReactionAllowed says whether the app named app takes emoji as a reaction. The
// variation selector Chat's picker may add ("❤️" for "❤") does not count.
func ReactionAllowed(app, emoji string) bool {
	list, restricted := ReactionsOf(app)
	if !restricted {
		return true
	}
	bare := stripVariation(emoji)
	return slices.Contains(list, bare)
}

func stripVariation(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r != 0xFE0F {
			out = append(out, r)
		}
	}
	return string(out)
}
