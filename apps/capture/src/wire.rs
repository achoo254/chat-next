//! What tunelo and tunelo-capture say to each other (docs/capture-wire.md):
//! one JSON object per line, commands on the capture's stdin, events on its
//! stdout. Only tunelo, its parent, holds those pipes. No picture travels on
//! them: a capture is a PNG file in the folder tunelo named at start.

use serde::{Deserialize, Serialize};

/// Bumped when a command or an event changes shape; tunelo checks it in `ready`.
pub const WIRE_VERSION: u32 = 1;

/// Where an interactive capture was asked from: it decides the main button.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// The capture's own shortcut: the main button sends to a chat.
    Hotkey,
    /// The Chat composer's button: the main button puts the picture in its tray.
    Chat,
    /// An AI tool (capture_interactive): the main button gives the picture to the AI.
    Ai,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    /// The user picks a region on the screen and annotates it.
    CaptureInteractive {
        id: String,
        origin: Origin,
    },
    /// A whole monitor, no interface (tunelo asked the user first).
    CaptureScreen {
        id: String,
        display: Option<u32>,
    },
    /// The monitors, for the AI to pick one.
    ListDisplays {
        id: String,
    },
    /// The global shortcut, as "Ctrl+Alt+A"; empty turns it off.
    SetHotkey {
        capture: String,
    },
    Quit,
}

/// What the user did with the picture.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    /// The main button: send (hotkey), tray (chat) or give to the AI (ai).
    Main,
    /// Ask the AI about it (a chat with the AI).
    AskAi,
    /// Copied to the clipboard only.
    Copy,
    /// Saved to the Pictures folder (`file` is that copy).
    Save,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Display {
    pub index: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    /// `version`: tunelo-capture's; `wire`: WIRE_VERSION; `hotkey`: the shortcut registered, empty when none.
    Ready {
        version: String,
        wire: u32,
        hotkey: String,
    },
    /// The overlay is up for `capture_interactive` `id` (empty for the shortcut's).
    Opened {
        id: String,
    },
    /// A picture: `id` answers a command, empty for one taken with the shortcut.
    Captured {
        id: String,
        origin: Origin,
        action: Action,
        file: String,
        width: u32,
        height: u32,
    },
    /// The user closed the overlay without a picture.
    Cancelled {
        id: String,
    },
    Displays {
        id: String,
        displays: Vec<Display>,
    },
    /// `code`: hotkey_taken, no_display, busy, capture_failed, bad_command.
    Error {
        id: String,
        code: String,
        message: String,
    },
}

/// One command line; an error names what was wrong without echoing the line.
pub fn parse_command(line: &str) -> Result<Command, String> {
    serde_json::from_str(line.trim()).map_err(|e| format!("not a command: {}", e.classify_str()))
}

trait Classify {
    fn classify_str(&self) -> &'static str;
}

impl Classify for serde_json::Error {
    fn classify_str(&self) -> &'static str {
        match self.classify() {
            serde_json::error::Category::Io => "io",
            serde_json::error::Category::Syntax => "syntax",
            serde_json::error::Category::Data => "unknown command or field",
            serde_json::error::Category::Eof => "truncated",
        }
    }
}

/// One event line, newline included.
pub fn event_line(event: &Event) -> String {
    let mut s = serde_json::to_string(event).unwrap_or_else(|_| String::from(r#"{"event":"error","id":"","code":"bad_command","message":"encode"}"#));
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_read_from_tunelo() {
        assert_eq!(
            parse_command(r#"{"cmd":"capture_interactive","id":"c1","origin":"chat"}"#),
            Ok(Command::CaptureInteractive {
                id: "c1".into(),
                origin: Origin::Chat
            })
        );
        assert_eq!(
            parse_command(r#"{"cmd":"capture_screen","id":"c2","display":null}"#),
            Ok(Command::CaptureScreen {
                id: "c2".into(),
                display: None
            })
        );
        assert_eq!(
            parse_command(r#"{"cmd":"set_hotkey","capture":"Ctrl+Alt+A"}"#),
            Ok(Command::SetHotkey { capture: "Ctrl+Alt+A".into() })
        );
        assert_eq!(parse_command("{\"cmd\":\"quit\"}\n"), Ok(Command::Quit));
    }

    #[test]
    fn a_bad_line_is_refused_without_echoing_it() {
        let err = parse_command(r#"{"cmd":"format_disk","secret":"hunter2"}"#).unwrap_err();
        assert!(!err.contains("hunter2"));
        assert!(parse_command("not json").is_err());
    }

    #[test]
    fn events_are_one_line_each() {
        let line = event_line(&Event::Captured {
            id: "c1".into(),
            origin: Origin::Chat,
            action: Action::Main,
            file: "/x/a.png".into(),
            width: 10,
            height: 20,
        });
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.starts_with(r#"{"event":"captured","id":"c1","origin":"chat","action":"main""#));
    }
}
