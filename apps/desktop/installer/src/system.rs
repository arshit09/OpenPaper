//! Windows integration: the Apps & Features entry, shortcuts, the WebView2 runtime, and tidying up.

use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use openpaper_common::{self as common, APP_EXE, APP_IDENTIFIER, CREATE_NO_WINDOW, UNINSTALL_EXE};
use serde::Serialize;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenPaper";
const SHORTCUT: &str = "OpenPaper.lnk";
const WEBVIEW2_CLIENT: &str = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const WEBVIEW2_BOOTSTRAPPER: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub version: String,
    pub dir: String,
}

/// The current install, from its Apps & Features entry.
pub fn installed() -> Option<Installed> {
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(UNINSTALL_KEY).ok()?;
    let dir: String = key.get_value("InstallLocation").ok()?;
    let version: String = key.get_value("DisplayVersion").unwrap_or_default();
    Path::new(&dir).join(APP_EXE).is_file().then_some(Installed { version, dir })
}

pub fn register(dir: &Path, version: &str, size_bytes: u64) -> Result<(), String> {
    let fail = |e: std::io::Error| format!("Couldn't add OpenPaper to Apps & Features: {e}");
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(UNINSTALL_KEY).map_err(fail)?;
    let app = dir.join(APP_EXE);
    let uninstaller = dir.join(UNINSTALL_EXE);
    key.set_value("DisplayName", &"OpenPaper").map_err(fail)?;
    key.set_value("DisplayVersion", &version).map_err(fail)?;
    key.set_value("Publisher", &"OpenPaper").map_err(fail)?;
    key.set_value("DisplayIcon", &format!("{},0", app.display())).map_err(fail)?;
    key.set_value("InstallLocation", &dir.display().to_string()).map_err(fail)?;
    key.set_value("UninstallString", &format!("\"{}\" --uninstall", uninstaller.display())).map_err(fail)?;
    key.set_value("URLInfoAbout", &"https://github.com/arshit09/OpenPaper").map_err(fail)?;
    key.set_value("EstimatedSize", &u32::try_from(size_bytes / 1024).unwrap_or(u32::MAX)).map_err(fail)?;
    key.set_value("NoModify", &1u32).map_err(fail)?;
    key.set_value("NoRepair", &1u32).map_err(fail)?;
    Ok(())
}

pub fn unregister() {
    let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(UNINSTALL_KEY);
}

fn start_menu() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("APPDATA")?).join(r"Microsoft\Windows\Start Menu\Programs"))
}

pub fn create_shortcuts(dir: &Path, desktop: bool) -> Result<(), String> {
    let app = dir.join(APP_EXE);
    let make = |at: PathBuf| -> Result<(), String> {
        let fail = |e: mslnk::MSLinkError| format!("Couldn't create the shortcut {}: {e}", at.display());
        let mut link = mslnk::ShellLink::new(&app).map_err(fail)?;
        link.set_working_dir(Some(dir.display().to_string()));
        link.set_name(Some("The design canvas your agents draw on".into()));
        link.set_icon_location(Some(app.display().to_string()));
        link.create_lnk(&at).map_err(fail)
    };
    if let Some(menu) = start_menu() {
        let _ = fs::create_dir_all(&menu);
        make(menu.join(SHORTCUT))?;
    }
    if let Some(desk) = dirs::desktop_dir() {
        if desktop {
            make(desk.join(SHORTCUT))?;
        } else {
            let _ = fs::remove_file(desk.join(SHORTCUT));
        }
    }
    Ok(())
}

pub fn remove_shortcuts() {
    for folder in [start_menu(), dirs::desktop_dir()].into_iter().flatten() {
        let _ = fs::remove_file(folder.join(SHORTCUT));
    }
}

/// The app's browser data (WebView2 profile) and saved window size; not the user's designs.
pub fn app_data_folders() -> Vec<PathBuf> {
    ["LOCALAPPDATA", "APPDATA"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(|root| PathBuf::from(root).join(APP_IDENTIFIER))
        .collect()
}

pub fn spawn_hidden(program: &Path, args: &[&str]) -> std::io::Result<std::process::Child> {
    Command::new(program).args(args).creation_flags(CREATE_NO_WINDOW).spawn()
}

/// Run the uninstaller from a copy in %TEMP% when it was started from inside the install. True when handed off.
pub fn relaunch_from_temp(dir: Option<&Path>) -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let Some(install) = dir.map(Path::to_path_buf).or_else(|| exe.parent().map(Path::to_path_buf)) else { return false };
    if !common::is_inside(&exe, &install) {
        return false;
    }
    let copy = std::env::temp_dir().join(format!("OpenPaper-Uninstall-{}.exe", std::process::id()));
    if fs::copy(&exe, &copy).is_err() {
        return false;
    }
    Command::new(&copy).arg("--uninstall").arg("--dir").arg(&install).spawn().is_ok()
}

/// After the window closes: delete this run's browser data and, for the temporary uninstaller, itself.
pub fn clean_up_after_exit(webview_dir: &Path, uninstalling: bool) {
    let mut script = format!("/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"{}\"", webview_dir.display());
    if uninstalling {
        if let Ok(exe) = std::env::current_exe() {
            if common::is_inside(&exe, &std::env::temp_dir()) {
                script.push_str(&format!(" & del /f /q \"{}\"", exe.display()));
            }
        }
    }
    let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let _ = Command::new(shell).raw_arg(script).creation_flags(CREATE_NO_WINDOW).spawn();
}

fn webview2_installed() -> bool {
    let wow = format!(r"SOFTWARE\WOW6432Node\{WEBVIEW2_CLIENT}");
    let native = format!(r"SOFTWARE\{WEBVIEW2_CLIENT}");
    let found = [(common::HKEY_LOCAL_MACHINE, &wow), (common::HKEY_LOCAL_MACHINE, &native), (common::HKEY_CURRENT_USER, &native)]
        .into_iter()
        .filter_map(|(root, key)| common::read_string(root, key, "pv"))
        .any(|version| !version.is_empty() && version != "0.0.0.0");
    found
}

/// The setup window needs Microsoft's WebView2 runtime (part of Windows 11, and of Windows 10 with current
/// updates). If it's missing, offer to install it with Microsoft's small bootstrapper. False to stop.
pub fn ensure_webview2() -> bool {
    if webview2_installed() {
        return true;
    }
    let ask = "OpenPaper needs Microsoft Edge WebView2, a free Windows component that shows its window.\n\nDownload and install it now?";
    if message_box(ask, MB_YESNO | MB_ICONINFORMATION) != IDYES {
        return false;
    }
    if tauri::async_runtime::block_on(install_webview2()).is_ok() && webview2_installed() {
        return true;
    }
    let fail = format!("WebView2 couldn't be installed.\n\nInstall it from {WEBVIEW2_BOOTSTRAPPER}, then run OpenPaper Setup again.");
    message_box(&fail, MB_OK | MB_ICONERROR);
    false
}

async fn install_webview2() -> Result<(), String> {
    let bytes = reqwest::get(WEBVIEW2_BOOTSTRAPPER).await.map_err(|e| e.to_string())?.bytes().await.map_err(|e| e.to_string())?;
    let path = std::env::temp_dir().join("MicrosoftEdgeWebview2Setup.exe");
    fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    let status = Command::new(&path).args(["/silent", "/install"]).status().map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&path);
    status.success().then_some(()).ok_or_else(|| format!("exit {status}"))
}

use windows_sys::Win32::UI::WindowsAndMessaging::{IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_YESNO, MessageBoxW};

fn message_box(text: &str, flags: u32) -> i32 {
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (text, title) = (wide(text), wide("OpenPaper Setup"));
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), flags) }
}
