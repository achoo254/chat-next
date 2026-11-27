//! The five annotation tools of the design (frame, arrow, pen, text, blur)
//! and drawing them onto the picked region. Blur is a real mosaic of the
//! source pixels (each block is replaced by its average), not a layer on top:
//! what it hides cannot be recovered from the exported picture.

use tiny_skia::{Color, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Stroke, Transform};

/// The four colours of the design: red, yellow, blue, green.
pub const COLORS: [[u8; 3]; 4] = [[0xff, 0x4d, 0x4f], [0xff, 0xcc, 0x4d], [0x4d, 0xa3, 0xff], [0x2e, 0xc2, 0x7e]];

/// Size of a mosaic block in pixels.
pub const MOSAIC_BLOCK: u32 = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Frame,
    Arrow,
    Pen,
    Text,
    Blur,
}

impl Tool {
    pub const ALL: [Tool; 5] = [Tool::Frame, Tool::Arrow, Tool::Pen, Tool::Text, Tool::Blur];
}

/// One mark on the region, in the region's pixels.
#[derive(Clone, Debug, PartialEq)]
pub enum Mark {
    Frame {
        from: (f32, f32),
        to: (f32, f32),
        color: [u8; 3],
    },
    Arrow {
        from: (f32, f32),
        to: (f32, f32),
        color: [u8; 3],
    },
    Pen {
        points: Vec<(f32, f32)>,
        color: [u8; 3],
    },
    /// Drawn by the overlay, which has the font (`draw_marks` leaves it alone).
    Text {
        at: (f32, f32),
        text: String,
        color: [u8; 3],
    },
    Blur {
        from: (f32, f32),
        to: (f32, f32),
    },
}

/// The line width of every stroke, in pixels of the picture.
pub fn stroke_width(scale: f32) -> f32 {
    (3.0 * scale).max(2.0)
}

fn paint(color: [u8; 3]) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color(Color::from_rgba8(color[0], color[1], color[2], 255));
    p.anti_alias = true;
    p
}

fn stroke(scale: f32) -> Stroke {
    Stroke {
        width: stroke_width(scale),
        line_cap: LineCap::Round,
        line_join: LineJoin::Round,
        ..Stroke::default()
    }
}

/// Draws every mark but text onto `pixmap`, in order (a later mark covers an earlier one).
pub fn draw_marks(pixmap: &mut Pixmap, marks: &[Mark], scale: f32) {
    for mark in marks {
        match mark {
            Mark::Blur { from, to } => mosaic(pixmap, *from, *to, MOSAIC_BLOCK),
            Mark::Frame { from, to, color } => {
                let (x0, x1) = (from.0.min(to.0), from.0.max(to.0));
                let (y0, y1) = (from.1.min(to.1), from.1.max(to.1));
                if let Some(rect) = tiny_skia::Rect::from_ltrb(x0, y0, x1.max(x0 + 1.0), y1.max(y0 + 1.0)) {
                    let path = PathBuilder::from_rect(rect);
                    pixmap.stroke_path(&path, &paint(*color), &stroke(scale), Transform::identity(), None);
                }
            }
            Mark::Arrow { from, to, color } => {
                if let Some(path) = arrow_path(*from, *to, stroke_width(scale)) {
                    pixmap.stroke_path(&path, &paint(*color), &stroke(scale), Transform::identity(), None);
                }
            }
            Mark::Pen { points, color } => {
                let mut pb = PathBuilder::new();
                if let Some((first, rest)) = points.split_first() {
                    pb.move_to(first.0, first.1);
                    if rest.is_empty() {
                        pb.line_to(first.0 + 0.1, first.1);
                    }
                    for p in rest {
                        pb.line_to(p.0, p.1);
                    }
                }
                if let Some(path) = pb.finish() {
                    pixmap.stroke_path(&path, &paint(*color), &stroke(scale), Transform::identity(), None);
                }
            }
            Mark::Text { .. } => {}
        }
    }
}

/// A line from `from` to `to` with a two-sided head at `to`, sized by the line width.
fn arrow_path(from: (f32, f32), to: (f32, f32), width: f32) -> Option<tiny_skia::Path> {
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1.0 {
        return None;
    }
    let (ux, uy) = (dx / len, dy / len);
    let head = (width * 5.0).min(len * 0.6);
    let wing = |s: f32| (to.0 - ux * head + -uy * s * head * 0.55, to.1 - uy * head + ux * s * head * 0.55);
    let (l, r) = (wing(1.0), wing(-1.0));
    let mut pb = PathBuilder::new();
    pb.move_to(from.0, from.1);
    pb.line_to(to.0, to.1);
    pb.move_to(l.0, l.1);
    pb.line_to(to.0, to.1);
    pb.line_to(r.0, r.1);
    pb.finish()
}

/// Replaces each `block` × `block` cell of the rectangle with the average of its pixels.
pub fn mosaic(pixmap: &mut Pixmap, from: (f32, f32), to: (f32, f32), block: u32) {
    let (w, h) = (pixmap.width() as i64, pixmap.height() as i64);
    let x0 = (from.0.min(to.0).floor() as i64).clamp(0, w);
    let x1 = (from.0.max(to.0).ceil() as i64).clamp(0, w);
    let y0 = (from.1.min(to.1).floor() as i64).clamp(0, h);
    let y1 = (from.1.max(to.1).ceil() as i64).clamp(0, h);
    let block = block.max(1) as i64;
    let stride = w as usize * 4;
    let data = pixmap.data_mut();
    let mut by = y0;
    while by < y1 {
        let ey = (by + block).min(y1);
        let mut bx = x0;
        while bx < x1 {
            let ex = (bx + block).min(x1);
            let mut sum = [0u64; 4];
            let mut n = 0u64;
            for y in by..ey {
                for x in bx..ex {
                    let i = y as usize * stride + x as usize * 4;
                    for (k, s) in sum.iter_mut().enumerate() {
                        *s += data[i + k] as u64;
                    }
                    n += 1;
                }
            }
            if n > 0 {
                let avg = sum.map(|s| (s / n) as u8);
                for y in by..ey {
                    for x in bx..ex {
                        let i = y as usize * stride + x as usize * 4;
                        data[i..i + 4].copy_from_slice(&avg);
                    }
                }
            }
            bx = ex;
        }
        by = ey;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stripes(w: u32, h: u32) -> Pixmap {
        let mut p = Pixmap::new(w, h).unwrap();
        for (i, px) in p.data_mut().chunks_exact_mut(4).enumerate() {
            let x = i as u32 % w;
            let v = if x.is_multiple_of(2) { 255 } else { 0 };
            px.copy_from_slice(&[v, v, v, 255]);
        }
        p
    }

    #[test]
    fn blur_destroys_the_detail_under_it_and_leaves_the_rest() {
        let mut p = stripes(48, 24);
        mosaic(&mut p, (0.0, 0.0), (24.0, 24.0), 12);
        // Inside: every pixel of a block is the block's average grey; the stripes are gone.
        let px = |p: &Pixmap, x: u32, y: u32| p.pixel(x, y).unwrap().red();
        assert_eq!(px(&p, 0, 0), px(&p, 1, 0));
        assert_eq!(px(&p, 0, 0), 127);
        // Outside: untouched.
        assert_eq!(px(&p, 30, 5), 255);
        assert_eq!(px(&p, 31, 5), 0);
    }

    #[test]
    fn blur_past_the_picture_stops_at_its_edge() {
        let mut p = stripes(10, 10);
        mosaic(&mut p, (-20.0, -20.0), (500.0, 500.0), 4);
        assert_eq!(p.width(), 10);
    }

    #[test]
    fn a_frame_an_arrow_and_a_pen_line_draw_in_their_colour() {
        let mut p = Pixmap::new(200, 200).unwrap();
        p.fill(Color::WHITE);
        let red = COLORS[0];
        draw_marks(
            &mut p,
            &[
                Mark::Frame {
                    from: (10.0, 10.0),
                    to: (60.0, 60.0),
                    color: red,
                },
                Mark::Arrow {
                    from: (100.0, 100.0),
                    to: (180.0, 100.0),
                    color: red,
                },
                Mark::Pen {
                    points: vec![(20.0, 150.0), (60.0, 150.0)],
                    color: red,
                },
            ],
            1.0,
        );
        let is_red = |x: u32, y: u32| {
            let c = p.pixel(x, y).unwrap();
            c.red() > 200 && c.green() < 120
        };
        assert!(is_red(10, 35), "the frame's left side");
        assert!(is_red(140, 100), "the arrow's shaft");
        assert!(is_red(40, 150), "the pen line");
        assert!(!is_red(35, 35), "inside the frame stays as it was");
    }

    #[test]
    fn an_arrow_of_no_length_draws_nothing() {
        assert!(arrow_path((5.0, 5.0), (5.2, 5.0), 3.0).is_none());
    }
}
