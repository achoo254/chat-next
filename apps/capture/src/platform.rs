//! What differs per system when the overlay covers a monitor.
//!
//! - macOS: a borderless window placed on the monitor in points (fullscreen
//!   would open a new Space with its slide), raised to the screen saver level
//!   so it covers the menu bar and the Dock; the process stays out of the Dock
//!   (accessory) yet takes the keyboard; typed text comes through the input
//!   method (Vietnamese Telex and VNI compose there). xcap gives monitors in
//!   points, winit in pixels.
//! - Windows, Linux: borderless fullscreen on the monitor; xcap and winit both
//!   give pixels.

use winit::event_loop::EventLoopBuilder;
use winit::monitor::MonitorHandle;
use winit::window::{Window, WindowAttributes};

/// A monitor as xcap reports it.
pub struct Place {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Whether winit's monitor is xcap's: same top left corner, in pixels or in points.
pub fn same_monitor(handle: &MonitorHandle, place: &Place) -> bool {
    let physical = handle.position();
    if physical.x == place.x && physical.y == place.y {
        return true;
    }
    let logical = physical.to_logical::<f64>(handle.scale_factor());
    (logical.x - place.x as f64).abs() < 1.0 && (logical.y - place.y as f64).abs() < 1.0
}

#[cfg(target_os = "macos")]
pub const TEXT_FROM_IME: bool = true;
#[cfg(not(target_os = "macos"))]
pub const TEXT_FROM_IME: bool = false;

#[cfg(target_os = "macos")]
pub fn background_app<T>(builder: &mut EventLoopBuilder<T>) {
    use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
    builder
        .with_activation_policy(ActivationPolicy::Accessory)
        .with_default_menu(false)
        .with_activate_ignoring_other_apps(true);
}

#[cfg(not(target_os = "macos"))]
pub fn background_app<T>(_builder: &mut EventLoopBuilder<T>) {}

#[cfg(target_os = "macos")]
pub fn cover(attrs: WindowAttributes, _handle: Option<MonitorHandle>, place: &Place) -> WindowAttributes {
    use winit::dpi::{LogicalPosition, LogicalSize};
    attrs
        .with_position(LogicalPosition::new(place.x, place.y))
        .with_inner_size(LogicalSize::new(place.width, place.height))
}

/// Fullscreen on the monitor winit matched; one it did not match is covered by a window of its place and size.
#[cfg(not(target_os = "macos"))]
pub fn cover(attrs: WindowAttributes, handle: Option<MonitorHandle>, place: &Place) -> WindowAttributes {
    use winit::dpi::{PhysicalPosition, PhysicalSize};
    match handle {
        Some(h) => attrs.with_fullscreen(Some(winit::window::Fullscreen::Borderless(Some(h)))),
        None => attrs
            .with_position(PhysicalPosition::new(place.x, place.y))
            .with_inner_size(PhysicalSize::new(place.width, place.height)),
    }
}

/// Above the menu bar and the Dock (macOS); elsewhere the window level set at creation is enough.
#[cfg(target_os = "macos")]
pub fn raise(window: &Window) {
    use objc2_app_kit::{NSScreenSaverWindowLevel, NSView};
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = window.window_handle() else { return };
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else { return };
    // SAFETY: winit's AppKit handle points at the window's live NSView; this runs on the main thread, where winit creates windows.
    let view: &NSView = unsafe { appkit.ns_view.cast().as_ref() };
    if let Some(ns_window) = view.window() {
        ns_window.setLevel(NSScreenSaverWindowLevel);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn raise(_window: &Window) {}
