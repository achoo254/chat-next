//! Text on a picture: the Text tool's notes and the overlay's own words. The
//! font is the system's (no font ships with tunelo-capture): Segoe UI on
//! Windows, then fonts every macOS and most Linux desktops have, all of them
//! with Vietnamese letters.

use fontdue::{Font, FontSettings};
use tiny_skia::Pixmap;

const CANDIDATES: &[&str] = &[
    "C:\\Windows\\Fonts\\segoeui.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
];

/// The first system font found, or none (text is then left out, the rest still works).
pub fn system_font() -> Option<Font> {
    CANDIDATES.iter().find_map(|path| {
        let bytes = std::fs::read(path).ok()?;
        Font::from_bytes(bytes, FontSettings::default()).ok()
    })
}

/// Width of `text` at `size` pixels.
pub fn measure(font: &Font, text: &str, size: f32) -> f32 {
    text.chars().map(|c| font.metrics(c, size).advance_width).sum()
}

/// Draws `text` with its baseline at `(x, y)`, blending its coverage over the picture.
pub fn draw_text(pixmap: &mut Pixmap, font: &Font, text: &str, x: f32, y: f32, size: f32, color: [u8; 3]) {
    let (w, h) = (pixmap.width() as i32, pixmap.height() as i32);
    let stride = w as usize * 4;
    let data = pixmap.data_mut();
    let mut pen = x;
    for c in text.chars() {
        let (m, coverage) = font.rasterize(c, size);
        let left = (pen + m.xmin as f32).round() as i32;
        let top = (y - m.height as f32 - m.ymin as f32).round() as i32;
        for gy in 0..m.height as i32 {
            let py = top + gy;
            if py < 0 || py >= h {
                continue;
            }
            for gx in 0..m.width as i32 {
                let px = left + gx;
                if px < 0 || px >= w {
                    continue;
                }
                let a = coverage[gy as usize * m.width + gx as usize] as u32;
                if a == 0 {
                    continue;
                }
                let i = py as usize * stride + px as usize * 4;
                for k in 0..3 {
                    let under = data[i + k] as u32;
                    data[i + k] = ((color[k] as u32 * a + under * (255 - a)) / 255) as u8;
                }
                data[i + 3] = 255;
            }
        }
        pen += m.advance_width;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_drawn_where_asked_when_the_system_has_a_font() {
        let Some(font) = system_font() else {
            return; // a machine without any of the fonts: nothing to draw with
        };
        let mut p = Pixmap::new(200, 60).unwrap();
        p.fill(tiny_skia::Color::BLACK);
        draw_text(&mut p, &font, "Chụp", 10.0, 40.0, 28.0, [255, 255, 255]);
        let lit = p.pixels().iter().filter(|c| c.red() > 128).count();
        assert!(lit > 50, "some of the text is drawn ({lit} pixels)");
        assert!(measure(&font, "Chụp", 28.0) > measure(&font, "C", 28.0));
    }
}
