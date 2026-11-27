//! The exported picture: the picked region of the frozen frame with its
//! marks drawn on it, as PNG bytes. Blur marks change the pixels themselves.

use crate::annotate::{draw_marks, Mark};
use crate::geometry::Rect;
use crate::text::draw_text;
use fontdue::Font;
use tiny_skia::{IntSize, Pixmap};

/// The text size of the Text tool, in pixels of the picture at scale 1.
pub const TEXT_SIZE: f32 = 22.0;

/// A captured frame: RGBA8, `width` × `height`, rows packed.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// The region of the frame as its own picture (opaque, so premultiplied RGBA is the same bytes).
pub fn crop(frame: &Frame, region: Rect) -> Option<Pixmap> {
    let x0 = region.x.max(0) as u32;
    let y0 = region.y.max(0) as u32;
    let x1 = (region.right().max(0) as u32).min(frame.width);
    let y1 = (region.bottom().max(0) as u32).min(frame.height);
    if x1 <= x0 || y1 <= y0 || frame.rgba.len() < (frame.width * frame.height * 4) as usize {
        return None;
    }
    let (w, h) = (x1 - x0, y1 - y0);
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for y in y0..y1 {
        let start = ((y * frame.width + x0) * 4) as usize;
        let row = &frame.rgba[start..start + (w * 4) as usize];
        // Screens are opaque; a stray alpha would be premultiplied wrongly.
        out.extend(row.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2], 255]));
    }
    Pixmap::from_vec(out, IntSize::from_wh(w, h)?)
}

/// The region with its marks (`marks` in the region's pixels), as a PNG.
pub fn export_png(frame: &Frame, region: Rect, marks: &[Mark], font: Option<&Font>, scale: f32) -> Result<Vec<u8>, String> {
    let mut pixmap = crop(frame, region).ok_or("the region is outside the frame")?;
    draw_marks(&mut pixmap, marks, scale);
    if let Some(font) = font {
        for mark in marks {
            if let Mark::Text { at, text, color } = mark {
                draw_text(&mut pixmap, font, text, at.0, at.1, TEXT_SIZE * scale, *color);
            }
        }
    }
    pixmap.encode_png().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::annotate::COLORS;

    fn frame(w: u32, h: u32) -> Frame {
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                rgba.extend([(x % 256) as u8, (y % 256) as u8, 7, 0]);
            }
        }
        Frame { width: w, height: h, rgba }
    }

    #[test]
    fn the_crop_is_exactly_the_region_and_opaque() {
        let f = frame(300, 200);
        let p = crop(&f, Rect::new(100, 50, 40, 30)).unwrap();
        assert_eq!((p.width(), p.height()), (40, 30));
        let c = p.pixel(0, 0).unwrap();
        assert_eq!((c.red(), c.green(), c.blue(), c.alpha()), (100, 50, 7, 255));
        let c = p.pixel(39, 29).unwrap();
        assert_eq!((c.red(), c.green()), (139, 79));
    }

    #[test]
    fn a_region_partly_outside_is_cut_to_the_frame_and_one_fully_outside_is_refused() {
        let f = frame(100, 100);
        let p = crop(&f, Rect::new(80, 80, 50, 50)).unwrap();
        assert_eq!((p.width(), p.height()), (20, 20));
        assert!(crop(&f, Rect::new(200, 200, 10, 10)).is_none());
    }

    #[test]
    fn the_png_has_the_region_size_and_its_marks() {
        let f = frame(300, 200);
        let marks = [Mark::Frame {
            from: (2.0, 2.0),
            to: (60.0, 40.0),
            color: COLORS[0],
        }];
        let png = export_png(&f, Rect::new(10, 10, 80, 60), &marks, None, 1.0).unwrap();
        let back = Pixmap::decode_png(&png).unwrap();
        assert_eq!((back.width(), back.height()), (80, 60));
        let edge = back.pixel(2, 20).unwrap();
        assert!(edge.red() > 200 && edge.blue() < 120, "the frame is drawn");
    }
}
