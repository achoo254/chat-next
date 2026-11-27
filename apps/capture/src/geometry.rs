//! Rectangles of a frozen screen frame, in its own pixels: the region a drag
//! picks (any direction, clamped to the frame) and where the toolbar goes
//! under it (variant A of the design), flipped above when there is no room.

/// A rectangle in pixels of a captured monitor (origin at its top left).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }

    pub fn right(&self) -> i32 {
        self.x + self.w as i32
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.h as i32
    }

    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.right() && py >= self.y && py < self.bottom()
    }

    pub fn is_empty(&self) -> bool {
        self.w == 0 || self.h == 0
    }
}

/// A drag from `a` to `b` as a region of a `width` × `height` frame: any
/// direction, clamped to the frame; none when it is smaller than `min` pixels
/// on a side (a click, not a region).
pub fn drag_rect(a: (i32, i32), b: (i32, i32), width: u32, height: u32, min: u32) -> Option<Rect> {
    let clamp_x = |v: i32| v.clamp(0, width as i32);
    let clamp_y = |v: i32| v.clamp(0, height as i32);
    let (x0, x1) = (clamp_x(a.0.min(b.0)), clamp_x(a.0.max(b.0)));
    let (y0, y1) = (clamp_y(a.1.min(b.1)), clamp_y(a.1.max(b.1)));
    let (w, h) = ((x1 - x0) as u32, (y1 - y0) as u32);
    if w < min || h < min {
        return None;
    }
    Some(Rect::new(x0, y0, w, h))
}

/// Where a `bar_w` × `bar_h` toolbar goes for a region: right-aligned under it
/// with a `gap`, above it when it would leave the frame below, inside its
/// bottom when neither fits; always within the frame horizontally.
pub fn toolbar_rect(region: Rect, bar_w: u32, bar_h: u32, gap: u32, width: u32, height: u32) -> Rect {
    let max_x = (width as i32 - bar_w as i32).max(0);
    let x = (region.right() - bar_w as i32).clamp(0, max_x);
    let below = region.bottom() + gap as i32;
    let above = region.y - gap as i32 - bar_h as i32;
    let y = if below + bar_h as i32 <= height as i32 {
        below
    } else if above >= 0 {
        above
    } else {
        (region.bottom() - bar_h as i32 - gap as i32).max(0)
    };
    Rect::new(x, y, bar_w, bar_h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drag_in_any_direction_is_the_same_region() {
        let r = Rect::new(100, 50, 300, 200);
        assert_eq!(drag_rect((100, 50), (400, 250), 1920, 1080, 4), Some(r));
        assert_eq!(drag_rect((400, 250), (100, 50), 1920, 1080, 4), Some(r));
        assert_eq!(drag_rect((100, 250), (400, 50), 1920, 1080, 4), Some(r));
    }

    #[test]
    fn a_drag_past_the_frame_is_clamped_and_a_click_is_no_region() {
        assert_eq!(drag_rect((-50, -50), (5000, 5000), 1920, 1080, 4), Some(Rect::new(0, 0, 1920, 1080)));
        assert_eq!(drag_rect((10, 10), (12, 300), 1920, 1080, 4), None);
        assert_eq!(drag_rect((10, 10), (10, 10), 1920, 1080, 4), None);
    }

    #[test]
    fn the_toolbar_goes_under_the_region_then_above_then_inside() {
        let (w, h) = (1920, 1080);
        let under = toolbar_rect(Rect::new(100, 100, 600, 300), 400, 40, 8, w, h);
        assert_eq!(under, Rect::new(300, 408, 400, 40));
        let above = toolbar_rect(Rect::new(100, 700, 600, 370), 400, 40, 8, w, h);
        assert_eq!(above, Rect::new(300, 652, 400, 40));
        let inside = toolbar_rect(Rect::new(0, 0, 1920, 1080), 400, 40, 8, w, h);
        assert_eq!(inside, Rect::new(1520, 1032, 400, 40));
    }

    #[test]
    fn the_toolbar_stays_inside_the_frame_for_a_small_region_at_the_left_edge() {
        let bar = toolbar_rect(Rect::new(0, 100, 50, 50), 400, 40, 8, 1920, 1080);
        assert_eq!(bar.x, 0);
    }
}
