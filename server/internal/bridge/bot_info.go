package bridge

import "context"

// BotCommand is one entry of a bot's command menu.
type BotCommand struct {
	Command     string
	Description string
}

// BotInfo is what a bot of the other app says about itself, as its own app shows it in an
// empty chat with the bot and on its profile.
type BotInfo struct {
	// Username is the bot's @name in the other app, without the @; "" when unknown.
	Username string
	// Description is the text above "start" in an empty chat; About the short text of the profile.
	Description string
	About       string
	Commands    []BotCommand
	// OpensApp says the bot has a button that opens a web app of its own in the other
	// app (Chat cannot run it, so it offers the bot's page in the other app instead).
	OpensApp bool
	// PhotoID names the picture shown above the description and changes when it does; empty
	// when the bot has none. PhotoRef is the FetchMedia ref of its bytes; it is meant to be
	// fetched right away, as such refs expire.
	PhotoID  string
	PhotoRef string
}

// BotInfoReader is implemented by an adapter that can read what a bot says about itself.
type BotInfoReader interface {
	// BotInfo reads the info of the bot the participant id names. A participant that is
	// not a bot, or that is not known to the account, returns ok false.
	BotInfo(ctx context.Context, acct Account, participant string) (info BotInfo, ok bool, err error)
}
