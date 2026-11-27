//! tunelo-capture: screenshots with a picked region and annotations, run by
//! tunelo (docs/capture-wire.md, ADR 0031). The library holds what does not
//! need a screen (geometry, marks, the exported picture, the toolbar's layout,
//! the wire) so it is tested everywhere; `main.rs` holds the overlay.

pub mod annotate;
pub mod compose;
pub mod geometry;
pub mod text;
pub mod toolbar;
pub mod wire;
