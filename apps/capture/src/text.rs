//! Text on a picture: the Text tool's notes and the overlay's own words. The
//! fonts are the system's (none ships with tunelo-capture): Segoe UI on
//! Windows, then fonts every macOS and most Linux desktops have, all of them
//! with Vietnamese letters. A letter the first font lacks (Chinese on
//! Windows) comes from a fallback font, read the first time one is needed.

use std::sync::OnceLock;

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

/// Fonts with Chinese letters (the first face of each collection).
const FALLBACKS: &[&str] = &[
    "C:\\Windows\\Fonts\\msyh.ttc",
    "C:\\Windows\\Fonts\\simsun.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
];

fn load(path: &str) -> Option<Font> {
    let bytes = std::fs::read(path).ok()?;
    Font::from_bytes(bytes, FontSettings::default()).ok()
}

/// The system font, and a fallback for the letters it lacks.
pub struct Fonts {
    main: Font,
    fallback: OnceLock<Option<Font>>,
}

impl Fonts {
    /// The font that has `c`: the main one when it does (or when no fallback has it either).
    fn for_char(&self, c: char) -> &Font {
        if self.main.lookup_glyph_index(c) != 0 || c.is_whitespace() {
            return &self.main;
        }
        let fallback = self.fallback.get_or_init(|| FALLBACKS.iter().find_map(|p| load(p)));
        match fallback {
            Some(f) if f.lookup_glyph_index(c) != 0 => f,
            _ => &self.main,
        }
    }

    /// Lets the fallback go once a capture ends: a Chinese font holds some
    /// 170 MB once read, and reading it again takes a fraction of a second.
    pub fn release_fallback(&mut self) {
        self.fallback = OnceLock::new();
    }
}

/// The first system font found, or none (text is then left out, the rest still works).
pub fn system_fonts() -> Option<Fonts> {
    let main = CANDIDATES.iter().find_map(|p| load(p))?;
    Some(Fonts {
        main,
        fallback: OnceLock::new(),
    })
}

/// Width of `text` at `size` pixels.
pub fn measure(fonts: &Fonts, text: &str, size: f32) -> f32 {
    text.chars().map(|c| fonts.for_char(c).metrics(c, size).advance_width).sum()
}

/// Draws `text` with its baseline at `(x, y)`, blending its coverage over the picture.
pub fn draw_text(pixmap: &mut Pixmap, fonts: &Fonts, text: &str, x: f32, y: f32, size: f32, color: [u8; 3]) {
    let (w, h) = (pixmap.width() as i32, pixmap.height() as i32);
    let stride = w as usize * 4;
    let data = pixmap.data_mut();
    let mut pen = x;
    for c in text.chars() {
        let (m, coverage) = fonts.for_char(c).rasterize(c, size);
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
        let Some(fonts) = system_fonts() else {
            return; // a machine without any of the fonts: nothing to draw with
        };
        let mut p = Pixmap::new(200, 60).unwrap();
        p.fill(tiny_skia::Color::BLACK);
        draw_text(&mut p, &fonts, "Chụp", 10.0, 40.0, 28.0, [255, 255, 255]);
        let lit = p.pixels().iter().filter(|c| c.red() > 128).count();
        assert!(lit > 50, "some of the text is drawn ({lit} pixels)");
        assert!(measure(&fonts, "Chụp", 28.0) > measure(&fonts, "C", 28.0));
    }

    #[test]
    fn chinese_letters_come_from_a_font_that_has_them() {
        let Some(fonts) = system_fonts() else { return };
        if !FALLBACKS.iter().any(|p| std::path::Path::new(p).exists()) && fonts.main.lookup_glyph_index('发') == 0 {
            return; // no font on this machine has them
        }
        for c in "发送截图".chars() {
            assert_ne!(fonts.for_char(c).lookup_glyph_index(c), 0, "{c} has a glyph");
        }
        assert!(std::ptr::eq(fonts.for_char('A'), &fonts.main), "Latin letters stay in the main font");
    }
}
