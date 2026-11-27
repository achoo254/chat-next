//! The toolbar under the picked region (variant A of the design): the five
//! tools, the four colours, undo, then copy, save, ask AI, the main button and
//! close. The main button's words follow where the capture was asked from.
//! Laid out in toolbar pixels from its left edge; the overlay places it with
//! `geometry::toolbar_rect` and asks `hit` which button a click is on.

use crate::annotate::{Tool, COLORS};
use crate::wire::{Action, Origin};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Tool(Tool),
    Color(usize),
    Undo,
    Act(Action),
    Close,
}

/// The overlay's words, in the system's language (tunelo passes it).
pub struct Words {
    pub copy: &'static str,
    pub save: &'static str,
    pub ask_ai: &'static str,
    pub send: &'static str,
    pub to_tray: &'static str,
    pub to_ai: &'static str,
    pub hint: &'static str,
}

pub const VI: Words = Words {
    copy: "Sao chép",
    save: "Lưu",
    ask_ai: "Hỏi AI",
    send: "Gửi",
    to_tray: "Thêm vào khay",
    to_ai: "Gửi cho AI",
    hint: "Kéo để chọn vùng · Esc để thoát",
};

pub const EN: Words = Words {
    copy: "Copy",
    save: "Save",
    ask_ai: "Ask AI",
    send: "Send",
    to_tray: "Add to tray",
    to_ai: "Give to AI",
    hint: "Drag to pick a region · Esc to close",
};

pub const ZH: Words = Words {
    copy: "复制",
    save: "保存",
    ask_ai: "问 AI",
    send: "发送",
    to_tray: "加入待发送",
    to_ai: "交给 AI",
    hint: "拖动选择区域 · Esc 退出",
};

/// The words for a language tag ("vi", "en-US", "zh-CN"…); Vietnamese by default.
pub fn words_for(lang: &str) -> &'static Words {
    let lang = lang.to_ascii_lowercase();
    if lang.starts_with("zh") {
        &ZH
    } else if lang.starts_with("en") {
        &EN
    } else {
        &VI
    }
}

impl Words {
    pub fn main_label(&self, origin: Origin) -> &'static str {
        match origin {
            Origin::Hotkey => self.send,
            Origin::Chat => self.to_tray,
            Origin::Ai => self.to_ai,
        }
    }
}

/// Height of the bar and of an icon button, in toolbar pixels at scale 1.
pub const BAR_H: f32 = 40.0;
pub const ICON_W: f32 = 34.0;
pub const GAP: f32 = 4.0;
pub const SEP: f32 = 10.0;
pub const PAD: f32 = 6.0;

/// One laid-out button: where it is in the bar and what it shows.
#[derive(Clone, Debug, PartialEq)]
pub struct Slot {
    pub button: Button,
    pub x: f32,
    pub w: f32,
    /// The words of a text button; none for an icon.
    pub label: Option<&'static str>,
}

/// The buttons from left to right; `measure` gives a label's width at scale 1.
pub fn layout(origin: Origin, words: &Words, measure: impl Fn(&str) -> f32) -> (Vec<Slot>, f32) {
    let mut slots = Vec::new();
    let mut x = PAD;
    let icon = |slots: &mut Vec<Slot>, x: &mut f32, button| {
        slots.push(Slot {
            button,
            x: *x,
            w: ICON_W,
            label: None,
        });
        *x += ICON_W + GAP;
    };
    for tool in Tool::ALL {
        icon(&mut slots, &mut x, Button::Tool(tool));
    }
    x += SEP;
    for i in 0..COLORS.len() {
        icon(&mut slots, &mut x, Button::Color(i));
    }
    x += SEP;
    icon(&mut slots, &mut x, Button::Undo);
    x += SEP;
    let text = |slots: &mut Vec<Slot>, x: &mut f32, button, label: &'static str| {
        let w = (measure(label) + 24.0).max(ICON_W);
        slots.push(Slot {
            button,
            x: *x,
            w,
            label: Some(label),
        });
        *x += w + GAP;
    };
    text(&mut slots, &mut x, Button::Act(Action::Copy), words.copy);
    text(&mut slots, &mut x, Button::Act(Action::Save), words.save);
    // The AI's own capture has no "ask AI": the picture goes to it anyway.
    if origin != Origin::Ai {
        text(&mut slots, &mut x, Button::Act(Action::AskAi), words.ask_ai);
    }
    text(&mut slots, &mut x, Button::Act(Action::Main), words.main_label(origin));
    icon(&mut slots, &mut x, Button::Close);
    (slots, x - GAP + PAD)
}

/// The button under a point given in toolbar pixels.
pub fn hit(slots: &[Slot], x: f32, y: f32) -> Option<Button> {
    if !(0.0..BAR_H).contains(&y) {
        return None;
    }
    slots.iter().find(|s| x >= s.x && x < s.x + s.w).map(|s| s.button)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MEASURE: fn(&str) -> f32 = |s| s.chars().count() as f32 * 8.0;

    #[test]
    fn the_bar_has_the_five_tools_four_colours_undo_and_the_actions_in_order() {
        let (slots, width) = layout(Origin::Hotkey, &VI, MEASURE);
        let buttons: Vec<Button> = slots.iter().map(|s| s.button).collect();
        assert_eq!(&buttons[..5], &Tool::ALL.map(Button::Tool));
        assert_eq!(&buttons[5..9], &[Button::Color(0), Button::Color(1), Button::Color(2), Button::Color(3)]);
        assert_eq!(buttons[9], Button::Undo);
        assert_eq!(
            &buttons[10..],
            &[
                Button::Act(Action::Copy),
                Button::Act(Action::Save),
                Button::Act(Action::AskAi),
                Button::Act(Action::Main),
                Button::Close
            ]
        );
        let last = slots.last().unwrap();
        assert!((width - (last.x + last.w + PAD)).abs() < 0.01);
    }

    #[test]
    fn the_main_button_says_where_the_picture_goes() {
        let label = |o| {
            layout(o, &VI, MEASURE)
                .0
                .into_iter()
                .find(|s| s.button == Button::Act(Action::Main))
                .and_then(|s| s.label)
        };
        assert_eq!(label(Origin::Hotkey), Some("Gửi"));
        assert_eq!(label(Origin::Chat), Some("Thêm vào khay"));
        assert_eq!(label(Origin::Ai), Some("Gửi cho AI"));
        let ai = layout(Origin::Ai, &VI, MEASURE).0;
        assert!(!ai.iter().any(|s| s.button == Button::Act(Action::AskAi)));
    }

    #[test]
    fn a_click_finds_its_button_and_the_gaps_find_none() {
        let (slots, _) = layout(Origin::Chat, &EN, MEASURE);
        let first = &slots[0];
        assert_eq!(hit(&slots, first.x + 1.0, 10.0), Some(Button::Tool(Tool::Frame)));
        assert_eq!(hit(&slots, first.x + first.w + GAP / 2.0, 10.0), None);
        assert_eq!(hit(&slots, first.x + 1.0, BAR_H + 1.0), None);
        let close = slots.last().unwrap();
        assert_eq!(hit(&slots, close.x + 2.0, 20.0), Some(Button::Close));
    }

    #[test]
    fn the_language_picks_the_words() {
        assert_eq!(words_for("en-US").send, "Send");
        assert_eq!(words_for("zh-CN").send, "发送");
        assert_eq!(words_for("vi").send, "Gửi");
        assert_eq!(words_for("").send, "Gửi");
    }
}
