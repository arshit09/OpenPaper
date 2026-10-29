//! OpenPaper Setup.exe: a small, branded web installer.
//!
//! It reads a release manifest from GitHub Releases, downloads that release's zip, checks its SHA-256,
//! and installs it for the current user (no admin rights) under %LOCALAPPDATA%\Programs\OpenPaper, with
//! Start menu and desktop shortcuts and an Apps & Features entry. A copy of it in the install folder,
//! "Uninstall OpenPaper.exe", removes OpenPaper again (`--uninstall`).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod install;
mod system;

use std::path::{Path, PathBuf};

use install::{Progress, Release};
use openpaper_common as common;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{AppHandle, RunEvent, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct Mode {
    uninstall: bool,
    /// The install to remove (uninstall mode).
    dir: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupInfo {
    mode: &'static str,
    installed: Option<system::Installed>,
    default_dir: String,
    data_dir: String,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let uninstalling = args.iter().any(|a| a == "--uninstall");
    let dir = args.iter().position(|a| a == "--dir").and_then(|i| args.get(i + 1)).map(PathBuf::from);
    // A running exe can't be deleted, so the uninstaller in the install folder hands over to a copy in %TEMP%.
    if uninstalling && system::relaunch_from_temp(dir.as_deref()) {
        return;
    }
    if !system::ensure_webview2() {
        return;
    }
    let dir = dir.or_else(|| {
        let exe = std::env::current_exe().ok()?;
        Some(exe.parent()?.to_path_buf())
    });
    let webview_dir = std::env::temp_dir().join(format!("OpenPaper-Setup-{}", std::process::id()));
    let data_dir = webview_dir.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mode { uninstall: uninstalling, dir: if uninstalling { dir } else { None } })
        .invoke_handler(tauri::generate_handler![setup_info, fetch_release, pick_folder, install, cancel, launch, uninstall])
        .setup(move |app| {
            build_window(app.handle(), data_dir.clone())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("OpenPaper Setup failed to start");
    app.run(move |_app, event| {
        if let RunEvent::Exit = event {
            system::clean_up_after_exit(&webview_dir, uninstalling);
        }
    });
}

fn build_window(app: &AppHandle, data_dir: PathBuf) -> tauri::Result<()> {
    let background = if common::system_prefers_dark() { Color(17, 17, 17, 255) } else { Color(255, 255, 255, 255) };
    let links = app.clone();
    let popups = app.clone();
    let window = WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("index.html".into()))
        .title("OpenPaper Setup")
        .inner_size(840.0, 560.0)
        .resizable(false)
        .maximizable(false)
        .decorations(false)
        .shadow(true)
        .center()
        .visible(false)
        .background_color(background)
        // Keep the installer's browser data out of the user's profile; it's deleted on exit.
        .data_directory(data_dir)
        .disable_drag_drop_handler()
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .on_navigation(move |url| {
            if url.host_str() == Some("tauri.localhost") || url.scheme() == "tauri" {
                return true;
            }
            open_external(&links, url);
            false
        })
        .on_new_window(move |url, _features| {
            open_external(&popups, &url);
            NewWindowResponse::Deny
        })
        .build()?;
    tune_webview(&window);
    Ok(())
}

fn open_external(app: &AppHandle, url: &Url) {
    if url.scheme() == "https" {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// No reload, find, print, zoom or devtools keys: a reload halfway through an install would lose its progress.
fn tune_webview(window: &WebviewWindow) {
    #[cfg(windows)]
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let Ok(settings) = core.Settings() else { return };
        let _ = settings.SetIsStatusBarEnabled(false);
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    });
}

#[tauri::command]
fn setup_info(mode: State<'_, Mode>) -> SetupInfo {
    SetupInfo {
        mode: if mode.uninstall { "uninstall" } else { "install" },
        installed: system::installed(),
        default_dir: install::default_dir().display().to_string(),
        data_dir: common::data_home().display().to_string(),
    }
}

#[tauri::command]
async fn fetch_release() -> Result<Release, String> {
    install::fetch_release().await
}

#[tauri::command]
async fn pick_folder(app: AppHandle, current: String) -> Option<String> {
    let current = Path::new(&current);
    let start = current.parent().filter(|p| p.exists()).unwrap_or(current);
    let picked = app
        .dialog()
        .file()
        .set_title("Choose where to install OpenPaper")
        .set_directory(start)
        .blocking_pick_folder()?;
    let picked = picked.into_path().ok()?;
    Some(install::with_app_folder(&picked).display().to_string())
}

#[tauri::command]
async fn install(dir: String, desktop: bool, release: Release, progress: Channel<Progress>) -> Result<String, String> {
    install::run(PathBuf::from(dir), desktop, release, progress).await.map(|dir| dir.display().to_string())
}

#[tauri::command]
fn cancel() {
    install::cancel();
}

#[tauri::command]
fn launch(app: AppHandle, dir: String) -> Result<(), String> {
    let dir = PathBuf::from(dir);
    std::process::Command::new(dir.join(common::APP_EXE))
        .current_dir(&dir)
        .spawn()
        .map_err(|e| format!("Couldn't open OpenPaper: {e}"))?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn uninstall(mode: State<'_, Mode>, remove_data: bool, progress: Channel<Progress>) -> Result<(), String> {
    let dir = mode.dir.clone().ok_or("No OpenPaper install was given to remove.")?;
    tauri::async_runtime::spawn_blocking(move || install::remove(&dir, remove_data, &progress))
        .await
        .map_err(|e| e.to_string())?
}
