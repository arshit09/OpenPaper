//! OpenPaper.exe: a native window around the local OpenPaper editor.
//!
//! The window opens on a small splash page, makes sure the server is running (starting the bundled
//! `node\node.exe server\cli.js serve` when it isn't), then loads the editor from it. Closing the window
//! hides it to the tray so agents connected over MCP keep working; Quit in the tray stops everything.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU8, Ordering};
use std::sync::Mutex;

use openpaper_common as common;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

const MAIN: &str = "main";

/// Port of the server the editor was loaded from; 0 until it's known.
static SERVER_PORT: AtomicU16 = AtomicU16::new(0);
static SHOWN: AtomicBool = AtomicBool::new(false);

/// Server start-up, which runs alongside the window opening rather than after it.
const STARTING: u8 = 1;
const READY: u8 = 2;
const FAILED: u8 = 3;
static PHASE: AtomicU8 = AtomicU8::new(0);
static FAILURE: Mutex<String> = Mutex::new(String::new());
static SPLASH_LOADS: AtomicU32 = AtomicU32::new(0);

/// Folder holding node\ and server\: next to the exe in an install, or OPENPAPER_DESKTOP_RUNTIME when developing.
fn runtime_dir() -> Option<PathBuf> {
    let dir = match std::env::var_os("OPENPAPER_DESKTOP_RUNTIME") {
        Some(dir) => PathBuf::from(dir),
        None => std::env::current_exe().ok()?.parent()?.to_path_buf(),
    };
    common::node_exe(&dir).exists().then_some(dir)
}

fn main() {
    tauri::Builder::default()
        // First, so a second launch hands its arguments to the running app and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--quit") {
                quit(app);
            } else {
                show(app);
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // `--quit` with nothing running to quit.
            if std::env::args().any(|a| a == "--quit") {
                app.handle().exit(0);
                return Ok(());
            }
            start_server(app.handle().clone());
            build_tray(app.handle())?;
            build_window(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("OpenPaper failed to start");
}

fn build_window(app: &AppHandle) -> tauri::Result<()> {
    let background = if common::system_prefers_dark() { Color(17, 17, 17, 255) } else { Color(255, 255, 255, 255) };
    let opener = app.clone();
    let links = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("OpenPaper")
        .inner_size(1280.0, 820.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .visible(false)
        .background_color(background)
        // Let the editor receive dropped files and images itself.
        .disable_drag_drop_handler()
        .on_page_load(|window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            if !SHOWN.swap(true, Ordering::SeqCst) {
                let _ = window.show();
                let _ = window.set_focus();
            }
            if is_splash(payload.url()) {
                let first = SPLASH_LOADS.fetch_add(1, Ordering::SeqCst) == 0;
                match PHASE.load(Ordering::SeqCst) {
                    // The server was ready before the window was.
                    READY => open_editor(&window),
                    // The start failed before the page could show why.
                    FAILED if first => show_failure(&window),
                    // "Try again" reloaded the page.
                    FAILED => start_server(window.app_handle().clone()),
                    // Still starting: it opens the editor when done.
                    _ => {}
                }
            }
        })
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(if title.trim().is_empty() { "OpenPaper" } else { &title });
        })
        // The editor and this app's own pages stay in the window; everything else opens in the browser.
        .on_navigation(move |url| {
            if is_splash(url) || is_editor(url) || matches!(url.scheme(), "about" | "blob" | "data") {
                return true;
            }
            open_external(&links, url);
            false
        })
        .on_new_window(move |url, _features| {
            open_external(&opener, &url);
            NewWindowResponse::Deny
        })
        .build()?;
    tune_webview(&window);
    Ok(())
}

fn is_splash(url: &Url) -> bool {
    url.host_str() == Some("tauri.localhost") || url.scheme() == "tauri"
}

fn is_editor(url: &Url) -> bool {
    let port = SERVER_PORT.load(Ordering::SeqCst);
    port != 0 && matches!(url.host_str(), Some("127.0.0.1" | "localhost")) && url.port() == Some(port)
}

fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// Make the window behave like an app rather than a browser tab: no reload, find, print, zoom or
/// devtools keys, and no status bar. Editing keys (copy, paste, undo...) are unaffected.
fn tune_webview(window: &WebviewWindow) {
    #[cfg(windows)]
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let Ok(settings) = core.Settings() else { return };
        let _ = settings.SetIsStatusBarEnabled(false);
        if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    });
}

/// Find or start the server, then load the editor. Runs at launch, and again from the splash's "Try again".
fn start_server(app: AppHandle) {
    if PHASE.swap(STARTING, Ordering::SeqCst) == STARTING {
        return;
    }
    std::thread::spawn(move || {
        let result = match runtime_dir() {
            Some(dir) => common::ensure_server(&common::node_exe(&dir), &common::server_cli(&dir)),
            None => common::find_running()
                .map(|(port, _)| port)
                .ok_or_else(|| "OpenPaper's files are missing next to OpenPaper.exe. Reinstall OpenPaper.".to_string()),
        };
        match result {
            Ok(port) => {
                SERVER_PORT.store(port, Ordering::SeqCst);
                PHASE.store(READY, Ordering::SeqCst);
                if let Some(window) = app.get_webview_window(MAIN) {
                    open_editor(&window);
                }
            }
            Err(message) => {
                *FAILURE.lock().unwrap() = message;
                PHASE.store(FAILED, Ordering::SeqCst);
                // Before the splash has loaded, its first load shows the message instead.
                if SPLASH_LOADS.load(Ordering::SeqCst) > 0 {
                    if let Some(window) = app.get_webview_window(MAIN) {
                        show_failure(&window);
                    }
                }
            }
        }
    });
}

fn open_editor(window: &WebviewWindow) {
    let port = SERVER_PORT.load(Ordering::SeqCst);
    if let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/")) {
        let _ = window.navigate(url);
    }
}

fn show_failure(window: &WebviewWindow) {
    let message = serde_json::to_string(&*FAILURE.lock().unwrap()).unwrap_or_default();
    let _ = window.eval(format!("window.showError && window.showError({message})"));
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Quit the app and stop the server it runs. A server from somewhere else (a git clone, say) keeps running.
fn quit(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.hide();
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(dir) = runtime_dir() {
            common::request_stop_in(&dir);
        }
        app.exit(0);
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open OpenPaper", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit OpenPaper", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit_item])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("OpenPaper")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
