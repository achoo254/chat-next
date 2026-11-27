//! tunelo-capture: run by tunelo (`tunelo-capture --out <folder> [--lang vi]
//! [--hotkey Ctrl+Alt+A]`), it reads commands on stdin and writes events on
//! stdout (docs/capture-wire.md). An interactive capture freezes every
//! monitor, covers each with a borderless window showing its frame, lets the
//! user pick a region and mark it (overlay.rs), then writes the picture to
//! the folder as a PNG, copies it to the clipboard and tells tunelo. The
//! global shortcut starts the same capture by itself. Closing stdin (tunelo
//! gone) ends the process.

mod overlay;

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use overlay::{Key, Outcome, Overlay};
use tunelo_capture::compose::{export_png, Frame};
use tunelo_capture::text::system_font;
use tunelo_capture::toolbar::{words_for, Words};
use tunelo_capture::wire::{event_line, parse_command, Action, Command, Display, Event, Origin, WIRE_VERSION};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, KeyEvent, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{Key as WKey, ModifiersState, NamedKey};
use winit::window::{CursorIcon, Fullscreen, Window, WindowId, WindowLevel};

enum UserEvent {
    Command(Command),
    Hotkey,
    /// stdin closed: tunelo is gone.
    Eof,
}

struct Pane {
    window: Arc<Window>,
    surface: softbuffer::Surface<Arc<Window>, Arc<Window>>,
    overlay: Overlay,
    /// The pointer's last position in the window (winit gives it on moves, not on presses).
    cursor: Option<(f64, f64)>,
}

/// The capture going on: its id (empty for the shortcut's), where it was asked from, one pane per monitor.
struct Session {
    id: String,
    origin: Origin,
    panes: HashMap<WindowId, Pane>,
}

struct App {
    out: PathBuf,
    words: &'static Words,
    font: Option<fontdue::Font>,
    hotkeys: Option<GlobalHotKeyManager>,
    hotkey: Option<HotKey>,
    hotkey_text: String,
    session: Option<Session>,
    modifiers: ModifiersState,
}

fn emit(event: &Event) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(event_line(event).as_bytes());
    let _ = out.flush();
}

fn error(id: &str, code: &str, message: impl Into<String>) {
    emit(&Event::Error {
        id: id.into(),
        code: code.into(),
        message: message.into(),
    });
}

/// Every monitor's frame now, with where it is on the desktop.
fn grab_all() -> Result<Vec<(xcap::Monitor, Frame)>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("no display".into());
    }
    let mut out = Vec::new();
    for m in monitors {
        let image = m.capture_image().map_err(|e| e.to_string())?;
        let (width, height) = image.dimensions();
        out.push((
            m,
            Frame {
                width,
                height,
                rgba: image.into_raw(),
            },
        ));
    }
    Ok(out)
}

fn stamp() -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("capture-{ms}")
}

fn write_png(dir: &Path, png: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.png", stamp()));
    std::fs::write(&path, png).map_err(|e| e.to_string())?;
    Ok(path)
}

/// The user's Pictures folder (Save).
fn pictures_dir() -> Option<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join("Pictures"))
}

fn copy_to_clipboard(png: &[u8]) -> Result<(), String> {
    let pixmap = tiny_skia::Pixmap::decode_png(png).map_err(|e| e.to_string())?;
    let image = arboard::ImageData {
        width: pixmap.width() as usize,
        height: pixmap.height() as usize,
        bytes: pixmap.data().to_vec().into(),
    };
    arboard::Clipboard::new().and_then(|mut c| c.set_image(image)).map_err(|e| e.to_string())
}

/// "Ctrl+Alt+A" as global-hotkey writes it ("ctrl+alt+KeyA").
fn hotkey_of(text: &str) -> Result<HotKey, String> {
    let parts: Vec<String> = text
        .split('+')
        .map(|p| p.trim())
        .map(|p| {
            if p.len() == 1 && p.chars().all(|c| c.is_ascii_alphabetic()) {
                format!("Key{}", p.to_ascii_uppercase())
            } else {
                p.to_string()
            }
        })
        .collect();
    HotKey::from_str(&parts.join("+")).map_err(|e| e.to_string())
}

impl App {
    fn set_hotkey(&mut self, text: &str) {
        let Some(manager) = &self.hotkeys else {
            error("", "hotkey_taken", "global shortcuts are not available");
            return;
        };
        if let Some(old) = self.hotkey.take() {
            let _ = manager.unregister(old);
        }
        self.hotkey_text.clear();
        if text.trim().is_empty() {
            return;
        }
        match hotkey_of(text).and_then(|k| manager.register(k).map(|_| k).map_err(|e| e.to_string())) {
            Ok(k) => {
                self.hotkey = Some(k);
                self.hotkey_text = text.to_string();
            }
            Err(e) => error("", "hotkey_taken", e),
        }
    }

    fn start(&mut self, event_loop: &ActiveEventLoop, id: String, origin: Origin) {
        if self.session.is_some() {
            error(&id, "busy", "a capture is already open");
            return;
        }
        let frames = match grab_all() {
            Ok(f) => f,
            Err(e) => return error(&id, if e == "no display" { "no_display" } else { "capture_failed" }, e),
        };
        let handles: Vec<_> = event_loop.available_monitors().collect();
        let mut panes = HashMap::new();
        for (monitor, frame) in frames {
            let (mx, my) = (monitor.x().unwrap_or(0), monitor.y().unwrap_or(0));
            let handle = handles.iter().find(|h| h.position().x == mx && h.position().y == my).cloned();
            let scale = handle.as_ref().map_or(1.0, |h| h.scale_factor()) as f32;
            let attrs = Window::default_attributes()
                .with_title("tunelo capture")
                .with_decorations(false)
                .with_resizable(false)
                .with_window_level(WindowLevel::AlwaysOnTop)
                .with_fullscreen(Some(Fullscreen::Borderless(handle)));
            let Ok(window) = event_loop.create_window(attrs) else { continue };
            let window = Arc::new(window);
            window.set_cursor(CursorIcon::Crosshair);
            let Ok(context) = softbuffer::Context::new(window.clone()) else { continue };
            let Ok(surface) = softbuffer::Surface::new(&context, window.clone()) else {
                continue;
            };
            let size = window.inner_size();
            let overlay = Overlay::new(frame, (size.width.max(1), size.height.max(1)), scale, origin, self.words, self.font.as_ref());
            window.focus_window();
            window.request_redraw();
            panes.insert(
                window.id(),
                Pane {
                    window,
                    surface,
                    overlay,
                    cursor: None,
                },
            );
        }
        if panes.is_empty() {
            return error(&id, "capture_failed", "no window could be opened");
        }
        self.session = Some(Session { id, origin, panes });
    }

    /// Ends the capture: the pane's picture written and reported, or a cancel.
    fn finish(&mut self, window: WindowId, outcome: Outcome) {
        let Some(mut session) = self.session.take() else { return };
        let Outcome::Done(action) = outcome else {
            emit(&Event::Cancelled { id: session.id });
            return;
        };
        let Some(pane) = session.panes.get_mut(&window) else { return };
        let Some(region) = pane.overlay.region else {
            emit(&Event::Cancelled { id: session.id });
            return;
        };
        let marks = pane.overlay.final_marks();
        let scale = (pane.overlay.frame.width as f32 / pane.window.inner_size().width.max(1) as f32).max(1.0);
        let result = export_png(&pane.overlay.frame, region, &marks, self.font.as_ref(), scale).and_then(|png| {
            // The picture is always on the clipboard too (as in Zalo); a clipboard refusal is not fatal.
            let _ = copy_to_clipboard(&png);
            let dir = if action == Action::Save {
                pictures_dir().unwrap_or_else(|| self.out.clone())
            } else {
                self.out.clone()
            };
            write_png(&dir, &png)
        });
        // The windows close with the session (dropped here).
        match result {
            Ok(path) => emit(&Event::Captured {
                id: session.id,
                origin: session.origin,
                action,
                file: path.to_string_lossy().into_owned(),
                width: region.w,
                height: region.h,
            }),
            Err(e) => error(&session.id, "capture_failed", e),
        }
    }

    fn capture_screen(&self, id: String, display: Option<u32>) {
        let result = grab_all().and_then(|frames| {
            let pick = match display {
                Some(i) => frames.into_iter().nth(i as usize),
                None => {
                    let mut all = frames.into_iter();
                    let first = all.next();
                    all.find(|(m, _)| m.is_primary().unwrap_or(false)).or(first)
                }
            };
            let (_, frame) = pick.ok_or("no such display")?;
            let region = tunelo_capture::geometry::Rect::new(0, 0, frame.width, frame.height);
            let png = export_png(&frame, region, &[], None, 1.0)?;
            Ok((write_png(&self.out, &png)?, frame.width, frame.height))
        });
        match result {
            Ok((path, width, height)) => emit(&Event::Captured {
                id,
                origin: Origin::Ai,
                action: Action::Main,
                file: path.to_string_lossy().into_owned(),
                width,
                height,
            }),
            Err(e) => error(&id, "capture_failed", e),
        }
    }

    fn list_displays(&self, id: String) {
        match xcap::Monitor::all() {
            Ok(monitors) => {
                let displays = monitors
                    .iter()
                    .enumerate()
                    .map(|(i, m)| Display {
                        index: i as u32,
                        name: m.name().unwrap_or_default(),
                        width: m.width().unwrap_or(0),
                        height: m.height().unwrap_or(0),
                        primary: m.is_primary().unwrap_or(false),
                    })
                    .collect();
                emit(&Event::Displays { id, displays });
            }
            Err(e) => error(&id, "no_display", e.to_string()),
        }
    }

    fn redraw(&mut self, id: WindowId) {
        let Some(session) = &mut self.session else { return };
        let Some(pane) = session.panes.get_mut(&id) else { return };
        let size = pane.window.inner_size();
        let (Some(w), Some(h)) = (NonZeroU32::new(size.width), NonZeroU32::new(size.height)) else {
            return;
        };
        if pane.surface.resize(w, h).is_err() {
            return;
        }
        let picture = pane.overlay.render(self.font.as_ref());
        let Ok(mut buffer) = pane.surface.buffer_mut() else { return };
        let (pw, ph) = (picture.width(), picture.height());
        let data = picture.data();
        // The frame has the monitor's pixels; a window of another size samples it.
        for y in 0..h.get() {
            let sy = (y as u64 * ph as u64 / h.get() as u64) as u32;
            for x in 0..w.get() {
                let sx = (x as u64 * pw as u64 / w.get() as u64) as u32;
                let i = ((sy * pw + sx) * 4) as usize;
                buffer[(y * w.get() + x) as usize] = (data[i] as u32) << 16 | (data[i + 1] as u32) << 8 | data[i + 2] as u32;
            }
        }
        let _ = buffer.present();
    }
}

impl ApplicationHandler<UserEvent> for App {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Command(Command::CaptureInteractive { id, origin }) => self.start(event_loop, id, origin),
            UserEvent::Command(Command::CaptureScreen { id, display }) => self.capture_screen(id, display),
            UserEvent::Command(Command::ListDisplays { id }) => self.list_displays(id),
            UserEvent::Command(Command::SetHotkey { capture }) => self.set_hotkey(&capture),
            UserEvent::Hotkey => self.start(event_loop, String::new(), Origin::Hotkey),
            UserEvent::Command(Command::Quit) | UserEvent::Eof => event_loop.exit(),
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        let mut outcome = Outcome::Pending;
        let mut dirty = false;
        match event {
            WindowEvent::RedrawRequested => return self.redraw(id),
            WindowEvent::CloseRequested => outcome = Outcome::Cancel,
            WindowEvent::ModifiersChanged(m) => self.modifiers = m.state(),
            WindowEvent::KeyboardInput {
                event:
                    KeyEvent {
                        logical_key,
                        state: ElementState::Pressed,
                        text,
                        ..
                    },
                ..
            } => {
                let ctrl = self.modifiers.control_key() || self.modifiers.super_key();
                let key = match &logical_key {
                    WKey::Named(NamedKey::Escape) => Some(Key::Escape),
                    WKey::Named(NamedKey::Enter) => Some(Key::Enter),
                    WKey::Named(NamedKey::Backspace) => Some(Key::Backspace),
                    WKey::Character(c) if ctrl && c.eq_ignore_ascii_case("z") => Some(Key::Undo),
                    WKey::Character(c) if ctrl && c.eq_ignore_ascii_case("c") => Some(Key::Copy),
                    _ if !ctrl => text.as_ref().and_then(|t| t.chars().next()).filter(|c| !c.is_control()).map(Key::Char),
                    _ => None,
                };
                if let (Some(key), Some(session)) = (key, &mut self.session) {
                    if let Some(pane) = session.panes.get_mut(&id) {
                        outcome = pane.overlay.outcome_for_key(key);
                        dirty = true;
                    }
                }
            }
            WindowEvent::MouseInput {
                state,
                button: MouseButton::Left,
                ..
            } => {
                if let Some(pane) = self.session.as_mut().and_then(|s| s.panes.get_mut(&id)) {
                    if state == ElementState::Pressed {
                        if let Some(at) = pane.cursor {
                            outcome = pane.overlay.press(at.0, at.1);
                        }
                    } else {
                        pane.overlay.released();
                    }
                    dirty = true;
                }
            }
            // A right click closes, as in most capture tools.
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Right,
                ..
            } => outcome = Outcome::Cancel,
            WindowEvent::CursorMoved { position, .. } => {
                if let Some(pane) = self.session.as_mut().and_then(|s| s.panes.get_mut(&id)) {
                    pane.cursor = Some((position.x, position.y));
                    dirty = pane.overlay.moved(position.x, position.y);
                }
            }
            _ => {}
        }
        if outcome != Outcome::Pending {
            self.finish(id, outcome);
            event_loop.set_control_flow(ControlFlow::Wait);
            return;
        }
        if dirty {
            if let Some(pane) = self.session.as_ref().and_then(|s| s.panes.get(&id)) {
                pane.window.request_redraw();
            }
        }
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(out) = arg(&args, "--out") else {
        eprintln!("usage: tunelo-capture --out <folder> [--lang vi|en|zh-CN] [--hotkey Ctrl+Alt+A]");
        std::process::exit(2);
    };
    let words = words_for(&arg(&args, "--lang").unwrap_or_default());
    let event_loop = match EventLoop::<UserEvent>::with_user_event().build() {
        Ok(l) => l,
        Err(e) => {
            error("", "no_display", e.to_string());
            std::process::exit(1);
        }
    };
    event_loop.set_control_flow(ControlFlow::Wait);
    let proxy: EventLoopProxy<UserEvent> = event_loop.create_proxy();

    // Commands: one per line on stdin; a bad line answers an error and the rest goes on.
    let commands = proxy.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            match parse_command(&line) {
                Ok(cmd) => {
                    if commands.send_event(UserEvent::Command(cmd)).is_err() {
                        return;
                    }
                }
                Err(e) => error("", "bad_command", e),
            }
        }
        let _ = commands.send_event(UserEvent::Eof);
    });

    let hotkeys = GlobalHotKeyManager::new().ok();
    let pressed = proxy.clone();
    GlobalHotKeyEvent::set_event_handler(Some(move |e: GlobalHotKeyEvent| {
        if e.state == HotKeyState::Pressed {
            let _ = pressed.send_event(UserEvent::Hotkey);
        }
    }));

    let mut app = App {
        out: PathBuf::from(out),
        words,
        font: system_font(),
        hotkeys,
        hotkey: None,
        hotkey_text: String::new(),
        session: None,
        modifiers: ModifiersState::empty(),
    };
    app.set_hotkey(&arg(&args, "--hotkey").unwrap_or_else(|| "Ctrl+Alt+A".into()));
    emit(&Event::Ready {
        version: env!("CARGO_PKG_VERSION").into(),
        wire: WIRE_VERSION,
        hotkey: app.hotkey_text.clone(),
    });
    if let Err(e) = event_loop.run_app(&mut app) {
        error("", "capture_failed", e.to_string());
    }
}
