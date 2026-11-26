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

// zaloReactions are the emoji Chat sends Zalo as a reaction, one for each reaction
// code of Zalo's set (server/internal/bridge/adapters/zalo/reactions.go checks the two agree).
var zaloReactions = []string{
	"❤", "👍", "😆", "😮", "😢", "😡", "😘", "😂", "💩", "🌹", "💔", "👎", "😍", "😕", "😉", "🥀", "☀", "🎂", "💣", "👌", "✌", "🤝", "👊", "🔗", "🙏", "🙅", "🤏", "🤟", "😔", "😭", "😎", "🤓", "😁", "😐", "😞", "👋", "😴", "😅", "🤦", "😫", "👏", "😠", "🤐", "😲", "😳", "😨", "😟", "🤣", "🤑", "🍺",
}

// ReactionsOf lists the emoji the app named app accepts as a reaction, and false
// when it accepts any (or is not known to restrict them).
func ReactionsOf(app string) ([]string, bool) {
	switch app {
	case "telegram":
		return telegramReactions, true
	case "zalo":
		return zaloReactions, true
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

// textDefault are the code points of the reaction lists that show as text unless a
// variation selector asks for the emoji (Unicode Emoji_Presentation=No).
var textDefault = map[rune]bool{0x2600: true, 0x2603: true, 0x2640: true, 0x2642: true, 0x270C: true, 0x270D: true, 0x2764: true, 0x1F54A: true}

// CanonicalEmoji is the form Chat keeps a reaction in: as its picker writes it, with the
// variation selector after a code point that would otherwise show as text ("❤" is "❤️"),
// so a reaction of another app and the same one picked in Chat are one reaction, drawn
// in colour. An emoji already in that form is returned as it is.
func CanonicalEmoji(emoji string) string {
	runes := []rune(emoji)
	out := make([]rune, 0, len(runes)+2)
	for i, r := range runes {
		out = append(out, r)
		if textDefault[r] && (i+1 == len(runes) || runes[i+1] != 0xFE0F) {
			out = append(out, 0xFE0F)
		}
	}
	return string(out)
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
