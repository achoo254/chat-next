//! One monitor's part of an interactive capture: its frozen frame filling a
//! borderless window on top of everything, dimmed except the region being
//! picked; the region's size above it; the toolbar under it (variant A); and
//! the marks drawn live. Pure state and drawing into an RGBA picture: the
//! window and its buffer belong to `main.rs`.

use tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, PixmapPaint, Rect as SkRect, Stroke, Transform};
use tunelo_capture::annotate::{Mark, Tool, COLORS};
use tunelo_capture::compose::{crop, Frame, TEXT_SIZE};
use tunelo_capture::geometry::{drag_rect, toolbar_rect, Rect};
use tunelo_capture::text::{draw_text, measure};
use tunelo_capture::toolbar::{hit, layout, Button, Slot, Words, BAR_H};
use tunelo_capture::wire::{Action, Origin};

/// The page around the region: the frame darkened this much.
const DIM: f32 = 0.45;
const BAR_BG: [u8; 3] = [0x1d, 0x1a, 0x2a];
const PRIMARY: [u8; 3] = [0x7c, 0x4d, 0xff];
const TEXT: [u8; 3] = [0xec, 0xea, 0xf6];
const MUTED: [u8; 3] = [0x9a, 0x95, 0xb4];
/// The smallest region, in frame pixels.
const MIN_REGION: u32 = 6;

/// What a pointer press is doing until it is released.
#[derive(Clone, Debug, PartialEq)]
enum Drag {
    None,
    /// Picking the region from this frame point.
    Region((i32, i32)),
    /// Drawing a mark (in region pixels).
    Mark,
}

/// What the user decided, for `main.rs` to finish.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Pending,
    Cancel,
    Done(Action),
}

pub struct Overlay {
    pub frame: Frame,
    /// Frame pixels per window pixel (1 when the window has the frame's size).
    to_frame: (f32, f32),
    /// UI size factor (the monitor's scale).
    pub scale: f32,
    pub region: Option<Rect>,
    pub marks: Vec<Mark>,
    tool: Tool,
    color: usize,
    drag: Drag,
    /// The text being typed with the Text tool, at a region point.
    typing: Option<((f32, f32), String)>,
    words: &'static Words,
    slots: Vec<Slot>,
    bar_w: f32,
    dimmed: Vec<u8>,
}

impl Overlay {
    pub fn new(frame: Frame, window_size: (u32, u32), scale: f32, origin: Origin, words: &'static Words, font: Option<&fontdue::Font>) -> Self {
        let to_frame = (
            frame.width as f32 / window_size.0.max(1) as f32,
            frame.height as f32 / window_size.1.max(1) as f32,
        );
        let (slots, bar_w) = layout(origin, words, |s| font.map_or(s.chars().count() as f32 * 8.0, |f| measure(f, s, 14.0)));
        let k = 1.0 - DIM;
        let dimmed = frame
            .rgba
            .chunks_exact(4)
            .flat_map(|p| [(p[0] as f32 * k) as u8, (p[1] as f32 * k) as u8, (p[2] as f32 * k) as u8, 255])
            .collect();
        Self {
            frame,
            to_frame,
            scale,
            region: None,
            marks: Vec::new(),
            tool: Tool::Frame,
            color: 0,
            drag: Drag::None,
            typing: None,
            words,
            slots,
            bar_w,
            dimmed,
        }
    }

    pub fn outcome_for_key(&mut self, key: Key) -> Outcome {
        if let Some((_, text)) = &mut self.typing {
            match key {
                Key::Escape => self.typing = None,
                Key::Enter => self.commit_text(),
                Key::Backspace => {
                    text.pop();
                }
                Key::Char(c) => text.push(c),
                _ => {}
            }
            return Outcome::Pending;
        }
        match key {
            Key::Escape => {
                // Esc with a region drops the region first, like the design's prototype.
                if self.region.is_some() && self.marks.is_empty() {
                    self.region = None;
                    Outcome::Pending
                } else {
                    Outcome::Cancel
                }
            }
            Key::Enter if self.region.is_some() => Outcome::Done(Action::Main),
            Key::Undo => {
                self.marks.pop();
                Outcome::Pending
            }
            Key::Copy if self.region.is_some() => Outcome::Done(Action::Copy),
            _ => Outcome::Pending,
        }
    }

    fn commit_text(&mut self) {
        if let Some((at, text)) = self.typing.take() {
            if !text.trim().is_empty() {
                self.marks.push(Mark::Text {
                    at,
                    text,
                    color: COLORS[self.color],
                });
            }
        }
    }

    fn to_frame_point(&self, x: f64, y: f64) -> (i32, i32) {
        ((x as f32 * self.to_frame.0) as i32, (y as f32 * self.to_frame.1) as i32)
    }

    /// The toolbar's place, in frame pixels.
    fn bar(&self) -> Option<Rect> {
        let region = self.region?;
        let s = self.scale * self.to_frame.0;
        Some(toolbar_rect(
            region,
            (self.bar_w * s) as u32,
            (BAR_H * s) as u32,
            (8.0 * s) as u32,
            self.frame.width,
            self.frame.height,
        ))
    }

    fn bar_button(&self, p: (i32, i32)) -> Option<Button> {
        let bar = self.bar()?;
        if !bar.contains(p.0, p.1) {
            return None;
        }
        let s = self.scale * self.to_frame.0;
        hit(&self.slots, (p.0 - bar.x) as f32 / s, (p.1 - bar.y) as f32 / s)
    }

    /// A region point of a frame point.
    fn in_region(&self, p: (i32, i32)) -> Option<(f32, f32)> {
        let r = self.region?;
        Some(((p.0 - r.x) as f32, (p.1 - r.y) as f32))
    }

    pub fn press(&mut self, x: f64, y: f64) -> Outcome {
        let p = self.to_frame_point(x, y);
        if let Some(button) = self.bar_button(p) {
            return self.click(button);
        }
        self.commit_text();
        match self.region {
            Some(r) if r.contains(p.0, p.1) => {
                let Some(at) = self.in_region(p) else { return Outcome::Pending };
                let color = COLORS[self.color];
                match self.tool {
                    Tool::Text => {
                        self.typing = Some((at, String::new()));
                        return Outcome::Pending;
                    }
                    Tool::Frame => self.marks.push(Mark::Frame { from: at, to: at, color }),
                    Tool::Arrow => self.marks.push(Mark::Arrow { from: at, to: at, color }),
                    Tool::Pen => self.marks.push(Mark::Pen { points: vec![at], color }),
                    Tool::Blur => self.marks.push(Mark::Blur { from: at, to: at }),
                }
                self.drag = Drag::Mark;
            }
            // Outside the region: a new region, as long as nothing is drawn on the current one.
            _ if self.marks.is_empty() => {
                self.region = None;
                self.drag = Drag::Region(p);
            }
            _ => {}
        }
        Outcome::Pending
    }

    pub fn moved(&mut self, x: f64, y: f64) -> bool {
        let p = self.to_frame_point(x, y);
        match self.drag.clone() {
            Drag::Region(start) => {
                self.region = drag_rect(start, p, self.frame.width, self.frame.height, MIN_REGION);
                true
            }
            Drag::Mark => {
                let Some(r) = self.region else { return false };
                let at = ((p.0 - r.x).clamp(0, r.w as i32) as f32, (p.1 - r.y).clamp(0, r.h as i32) as f32);
                match self.marks.last_mut() {
                    Some(Mark::Frame { to, .. } | Mark::Arrow { to, .. } | Mark::Blur { to, .. }) => *to = at,
                    Some(Mark::Pen { points, .. }) => points.push(at),
                    _ => {}
                }
                true
            }
            Drag::None => false,
        }
    }

    pub fn released(&mut self) {
        if self.drag == Drag::Mark {
            // A click without a drag leaves no mark (except a pen dot).
            let empty = match self.marks.last() {
                Some(Mark::Frame { from, to, .. } | Mark::Arrow { from, to, .. } | Mark::Blur { from, to }) => {
                    (from.0 - to.0).abs() < 2.0 && (from.1 - to.1).abs() < 2.0
                }
                _ => false,
            };
            if empty {
                self.marks.pop();
            }
        }
        self.drag = Drag::None;
    }

    fn click(&mut self, button: Button) -> Outcome {
        self.commit_text();
        match button {
            Button::Tool(t) => self.tool = t,
            Button::Color(i) => self.color = i,
            Button::Undo => {
                self.marks.pop();
            }
            Button::Act(a) => return Outcome::Done(a),
            Button::Close => return Outcome::Cancel,
        }
        Outcome::Pending
    }

    /// The marks to export: the committed ones and the text being typed.
    pub fn final_marks(&mut self) -> Vec<Mark> {
        self.commit_text();
        self.marks.clone()
    }

    /// The whole window's picture, in frame pixels (RGBA, opaque).
    pub fn render(&self, font: Option<&fontdue::Font>) -> Pixmap {
        let (w, h) = (self.frame.width, self.frame.height);
        let mut out = Pixmap::from_vec(self.dimmed.clone(), tiny_skia::IntSize::from_wh(w.max(1), h.max(1)).expect("frame size")).expect("frame buffer");
        let s = self.scale * self.to_frame.0;
        let Some(region) = self.region else {
            if let Some(font) = font {
                let size = 16.0 * s;
                let tw = measure(font, self.words.hint, size);
                let (bx, by) = ((w as f32 - tw) / 2.0 - 14.0 * s, 24.0 * s);
                fill_round(&mut out, (bx, by, tw + 28.0 * s, size * 2.0), 8.0 * s, BAR_BG, 0.9);
                draw_text(&mut out, font, self.words.hint, bx + 14.0 * s, by + size * 1.35, size, TEXT);
            }
            return out;
        };
        // The region at full brightness with its marks.
        if let Some(mut picked) = crop(&self.frame, region) {
            tunelo_capture::annotate::draw_marks(&mut picked, &self.marks, self.to_frame.0.max(1.0));
            if let Some(font) = font {
                let size = TEXT_SIZE * self.to_frame.0.max(1.0);
                for mark in &self.marks {
                    if let Mark::Text { at, text, color } = mark {
                        draw_text(&mut picked, font, text, at.0, at.1, size, *color);
                    }
                }
                if let Some((at, text)) = &self.typing {
                    let shown = format!("{text}|");
                    draw_text(&mut picked, font, &shown, at.0, at.1, size, COLORS[self.color]);
                }
            }
            out.draw_pixmap(region.x, region.y, picked.as_ref(), &PixmapPaint::default(), Transform::identity(), None);
        }
        // Its outline.
        if let Some(r) = SkRect::from_xywh(region.x as f32, region.y as f32, region.w as f32, region.h as f32) {
            let mut paint = paint_of(PRIMARY, 1.0);
            paint.anti_alias = false;
            out.stroke_path(
                &PathBuilder::from_rect(r),
                &paint,
                &Stroke {
                    width: (2.0 * s).max(1.0),
                    ..Stroke::default()
                },
                Transform::identity(),
                None,
            );
        }
        if let Some(font) = font {
            // Its size above it.
            let label = format!("{} × {}", region.w, region.h);
            let size = 12.0 * s;
            let lw = measure(font, &label, size) + 12.0 * s;
            let ly = (region.y as f32 - size * 1.9).max(0.0);
            fill_round(&mut out, (region.x as f32, ly, lw, size * 1.7), 4.0 * s, BAR_BG, 0.9);
            draw_text(&mut out, font, &label, region.x as f32 + 6.0 * s, ly + size * 1.25, size, TEXT);
        }
        if self.drag != Drag::None && matches!(self.drag, Drag::Region(_)) {
            return out;
        }
        if let Some(bar) = self.bar() {
            self.draw_bar(&mut out, bar, s, font);
        }
        out
    }

    fn draw_bar(&self, out: &mut Pixmap, bar: Rect, s: f32, font: Option<&fontdue::Font>) {
        let (bx, by) = (bar.x as f32, bar.y as f32);
        fill_round(out, (bx, by, bar.w as f32, bar.h as f32), 10.0 * s, BAR_BG, 0.97);
        for slot in &self.slots {
            let (x, y, w, hgt) = (bx + slot.x * s, by + 4.0 * s, slot.w * s, (BAR_H - 8.0) * s);
            let on = match slot.button {
                Button::Tool(t) => t == self.tool,
                Button::Color(i) => i == self.color,
                Button::Act(Action::Main) => true,
                _ => false,
            };
            if on {
                let main = slot.button == Button::Act(Action::Main);
                fill_round(out, (x, y, w, hgt), 7.0 * s, PRIMARY, if main { 1.0 } else { 0.35 });
            }
            let (cx, cy) = (x + w / 2.0, y + hgt / 2.0);
            match (slot.button, slot.label, font) {
                (_, Some(label), Some(font)) => {
                    let size = 14.0 * s;
                    let tw = measure(font, label, size);
                    draw_text(out, font, label, cx - tw / 2.0, cy + size * 0.36, size, TEXT);
                }
                (Button::Color(i), _, _) => fill_circle(out, cx, cy, 7.0 * s, COLORS[i]),
                (button, _, _) => draw_icon(out, button, cx, cy, 8.0 * s, font),
            }
        }
    }
}

/// Keys the overlay knows, from winit's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Escape,
    Enter,
    Backspace,
    Undo,
    Copy,
    Char(char),
}

fn paint_of(color: [u8; 3], alpha: f32) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color(Color::from_rgba(color[0] as f32 / 255.0, color[1] as f32 / 255.0, color[2] as f32 / 255.0, alpha).unwrap_or(Color::BLACK));
    p.anti_alias = true;
    p
}

/// A rounded rectangle `(x, y, w, h)` with corner radius `r`.
fn fill_round(out: &mut Pixmap, (x, y, w, h): (f32, f32, f32, f32), r: f32, color: [u8; 3], alpha: f32) {
    let r = r.min(w / 2.0).min(h / 2.0);
    let mut pb = PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.quad_to(x + w, y, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.quad_to(x + w, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.quad_to(x, y + h, x, y + h - r);
    pb.line_to(x, y + r);
    pb.quad_to(x, y, x + r, y);
    pb.close();
    if let Some(path) = pb.finish() {
        out.fill_path(&path, &paint_of(color, alpha), FillRule::Winding, Transform::identity(), None);
    }
}

fn fill_circle(out: &mut Pixmap, cx: f32, cy: f32, r: f32, color: [u8; 3]) {
    if let Some(path) = PathBuilder::from_circle(cx, cy, r) {
        out.fill_path(&path, &paint_of(color, 1.0), FillRule::Winding, Transform::identity(), None);
    }
}

/// The tools', undo's and close's pictures, drawn as lines `u` wide around the centre.
fn draw_icon(out: &mut Pixmap, button: Button, cx: f32, cy: f32, u: f32, font: Option<&fontdue::Font>) {
    let stroke = Stroke {
        width: (u / 4.0).max(1.5),
        line_cap: tiny_skia::LineCap::Round,
        line_join: tiny_skia::LineJoin::Round,
        ..Stroke::default()
    };
    let mut pb = PathBuilder::new();
    match button {
        Button::Tool(Tool::Frame) => {
            if let Some(r) = SkRect::from_xywh(cx - u, cy - u * 0.75, u * 2.0, u * 1.5) {
                pb.push_rect(r);
            }
        }
        Button::Tool(Tool::Arrow) => {
            pb.move_to(cx - u, cy + u);
            pb.line_to(cx + u, cy - u);
            pb.move_to(cx + u * 0.1, cy - u);
            pb.line_to(cx + u, cy - u);
            pb.line_to(cx + u, cy - u * 0.1);
        }
        Button::Tool(Tool::Pen) => {
            pb.move_to(cx - u, cy + u * 0.3);
            pb.quad_to(cx - u * 0.4, cy - u, cx, cy);
            pb.quad_to(cx + u * 0.4, cy + u, cx + u, cy - u * 0.3);
        }
        Button::Tool(Tool::Text) => {
            if let Some(font) = font {
                let size = u * 2.2;
                draw_text(out, font, "T", cx - measure(font, "T", size) / 2.0, cy + size * 0.36, size, TEXT);
            }
            return;
        }
        Button::Tool(Tool::Blur) => {
            let q = u * 0.55;
            for (i, j) in [(0, 0), (2, 0), (1, 1), (0, 2), (2, 2)] {
                if let Some(r) = SkRect::from_xywh(cx - u + i as f32 * q * 1.2, cy - u + j as f32 * q * 1.2, q, q) {
                    let mut b = PathBuilder::new();
                    b.push_rect(r);
                    if let Some(p) = b.finish() {
                        out.fill_path(&p, &paint_of(TEXT, 0.9), FillRule::Winding, Transform::identity(), None);
                    }
                }
            }
            return;
        }
        Button::Undo => {
            pb.move_to(cx - u * 0.8, cy - u * 0.2);
            pb.quad_to(cx, cy - u * 1.1, cx + u * 0.8, cy + u * 0.2);
            pb.move_to(cx - u * 0.8, cy - u * 0.9);
            pb.line_to(cx - u * 0.8, cy - u * 0.2);
            pb.line_to(cx - u * 0.1, cy - u * 0.2);
        }
        Button::Close => {
            pb.move_to(cx - u * 0.7, cy - u * 0.7);
            pb.line_to(cx + u * 0.7, cy + u * 0.7);
            pb.move_to(cx + u * 0.7, cy - u * 0.7);
            pb.line_to(cx - u * 0.7, cy + u * 0.7);
        }
        _ => return,
    }
    if let Some(path) = pb.finish() {
        let color = if button == Button::Close { MUTED } else { TEXT };
        out.stroke_path(&path, &paint_of(color, 1.0), &stroke, Transform::identity(), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunelo_capture::toolbar::VI;

    fn overlay(origin: Origin) -> Overlay {
        let frame = Frame {
            width: 800,
            height: 600,
            rgba: vec![200; 800 * 600 * 4],
        };
        Overlay::new(frame, (800, 600), 1.0, origin, &VI, None)
    }

    #[test]
    fn a_drag_picks_the_region_and_a_drag_inside_it_draws_with_the_current_tool() {
        let mut o = overlay(Origin::Chat);
        o.press(100.0, 100.0);
        o.moved(400.0, 300.0);
        o.released();
        assert_eq!(o.region, Some(Rect::new(100, 100, 300, 200)));
        o.press(150.0, 150.0);
        o.moved(250.0, 200.0);
        o.released();
        assert_eq!(
            o.marks,
            vec![Mark::Frame {
                from: (50.0, 50.0),
                to: (150.0, 100.0),
                color: COLORS[0]
            }]
        );
        assert_eq!(o.outcome_for_key(Key::Undo), Outcome::Pending);
        assert!(o.marks.is_empty());
    }

    #[test]
    fn text_is_typed_where_clicked_and_kept_on_enter() {
        let mut o = overlay(Origin::Hotkey);
        o.press(100.0, 100.0);
        o.moved(400.0, 300.0);
        o.released();
        o.tool = Tool::Text;
        o.press(120.0, 130.0);
        for c in "Lỗi".chars() {
            o.outcome_for_key(Key::Char(c));
        }
        assert_eq!(o.outcome_for_key(Key::Enter), Outcome::Pending, "Enter ends the text, not the capture");
        assert_eq!(
            o.marks,
            vec![Mark::Text {
                at: (20.0, 30.0),
                text: "Lỗi".into(),
                color: COLORS[0]
            }]
        );
        assert_eq!(o.outcome_for_key(Key::Enter), Outcome::Done(Action::Main));
    }

    #[test]
    fn esc_drops_the_region_first_then_closes() {
        let mut o = overlay(Origin::Hotkey);
        o.press(100.0, 100.0);
        o.moved(300.0, 300.0);
        o.released();
        assert_eq!(o.outcome_for_key(Key::Escape), Outcome::Pending);
        assert_eq!(o.region, None);
        assert_eq!(o.outcome_for_key(Key::Escape), Outcome::Cancel);
    }

    #[test]
    fn the_toolbar_buttons_answer_clicks() {
        let mut o = overlay(Origin::Chat);
        o.press(100.0, 100.0);
        o.moved(700.0, 400.0);
        o.released();
        let bar = o.bar().unwrap();
        let main = o.slots.iter().find(|s| s.button == Button::Act(Action::Main)).unwrap().clone();
        let at = |slot: &Slot| ((bar.x as f32 + slot.x + slot.w / 2.0) as f64, (bar.y as f32 + BAR_H / 2.0) as f64);
        let arrow = o.slots[1].clone();
        let (ax, ay) = at(&arrow);
        assert_eq!(o.press(ax, ay), Outcome::Pending);
        assert_eq!(o.tool, Tool::Arrow);
        let (mx, my) = at(&main);
        assert_eq!(o.press(mx, my), Outcome::Done(Action::Main));
    }

    #[test]
    fn the_frame_is_rendered_dimmed_with_the_region_bright() {
        let mut o = overlay(Origin::Chat);
        o.press(100.0, 100.0);
        o.moved(300.0, 300.0);
        o.released();
        let picture = o.render(None);
        assert!(picture.pixel(50, 50).unwrap().red() < 150, "outside is dimmed");
        assert_eq!(picture.pixel(200, 200).unwrap().red(), 200, "inside is as captured");
    }

    #[test]
    fn a_window_smaller_than_the_frame_maps_its_points_to_frame_pixels() {
        let frame = Frame {
            width: 1600,
            height: 1200,
            rgba: vec![0; 1600 * 1200 * 4],
        };
        let mut o = Overlay::new(frame, (800, 600), 1.0, Origin::Chat, &VI, None);
        o.press(100.0, 100.0);
        o.moved(200.0, 200.0);
        o.released();
        assert_eq!(o.region, Some(Rect::new(200, 200, 200, 200)));
    }
}
