//! Updates. At launch and every few hours, read the release manifest Setup installs from. When it names a newer
//! version than this app, say so in the editor and the tray menu, and, while the window is in the tray, with a
//! Windows notification (once per version). Updating downloads that release's Setup, checks it against the
//! manifest and runs it with `--update`: Setup closes this app when it's ready to swap the files in, then opens
//! the new version.
//!
//! The editor hears about an update through `window.__openpaperDesktop` and an `openpaper-desktop` event, and asks
//! for one by navigating to UPDATE_PATH, which the window cancels and hands to `start`. It gets no other native access.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use openpaper_common as common;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Url, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

pub const CURRENT: &str = env!("CARGO_PKG_VERSION");
/// The editor navigates here to start an update; the window cancels that navigation.
pub const UPDATE_PATH: &str = "/desktop/update";

/// Give the server and the editor a moment to open before the first check.
const FIRST_CHECK: Duration = Duration::from_secs(10);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// After a failed check (offline, say), try again sooner.
const RETRY: Duration = Duration::from_secs(60 * 60);
/// Opening OpenPaper again while it runs checks too, unless the last check is this recent.
const RECENT: Duration = Duration::from_secs(60 * 60);

#[derive(Deserialize)]
struct Manifest {
    version: String,
    /// That release's Setup, which performs the update. A manifest without one (0.4.0 and older) means the
    /// OpenPaper-Setup.exe next to it, unchecked.
    #[serde(default)]
    setup: Option<Download>,
}

#[derive(Deserialize, Clone, Default)]
struct Download {
    url: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    sha256: String,
}

/// What the editor is told about a newer version.
#[derive(Serialize, Clone)]
struct Update {
    version: String,
    /// Its release notes.
    notes: String,
    /// "available"; "starting" while Setup downloads and opens; "failed", with `error`, when it couldn't.
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip)]
    setup: Download,
}

static AVAILABLE: Mutex<Option<Update>> = Mutex::new(None);
static LAST_CHECK: Mutex<Option<SystemTime>> = Mutex::new(None);
static WAKE: OnceLock<Sender<()>> = OnceLock::new();

/// Check at launch, then every few hours while the app runs.
pub fn spawn(app: AppHandle) {
    let (wake, woken) = mpsc::channel();
    let _ = WAKE.set(wake);
    std::thread::spawn(move || run(app, woken));
}

/// OpenPaper was opened again: check now, unless a check ran in the last hour.
pub fn check_soon() {
    if let Some(wake) = WAKE.get() {
        let _ = wake.send(());
    }
}

fn run(app: AppHandle, woken: Receiver<()>) {
    let mut next = SystemTime::now() + FIRST_CHECK;
    loop {
        // Wall-clock time, looked at every few minutes, so the hours a PC spends asleep count toward the next check.
        let wait = next.duration_since(SystemTime::now()).unwrap_or_default();
        match woken.recv_timeout(wait.min(Duration::from_secs(300))) {
            Ok(()) => {
                let last = *LAST_CHECK.lock().unwrap();
                if last.and_then(|t| t.elapsed().ok()).is_some_and(|age| age < RECENT) {
                    continue;
                }
            }
            Err(RecvTimeoutError::Timeout) if SystemTime::now() < next => continue,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        next = SystemTime::now() + if check(&app).is_ok() { EVERY } else { RETRY };
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("OpenPaper/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

fn get(url: &str) -> Result<Vec<u8>, String> {
    tauri::async_runtime::block_on(async {
        let res = client()?.get(url).header("Cache-Control", "no-cache").send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("{url} answered {}", res.status()));
        }
        res.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
    })
}

fn check(app: &AppHandle) -> Result<(), String> {
    let url = common::manifest_url();
    let base = Url::parse(&url).map_err(|e| e.to_string())?;
    let manifest: Manifest = serde_json::from_slice(&get(&url)?).map_err(|e| e.to_string())?;
    *LAST_CHECK.lock().unwrap() = Some(SystemTime::now());
    if !common::is_newer(&manifest.version, CURRENT) {
        return Ok(());
    }
    let mut setup = manifest.setup.unwrap_or_else(|| Download { url: "OpenPaper-Setup.exe".into(), ..Default::default() });
    setup.url = base.join(&setup.url).map_err(|e| e.to_string())?.to_string();
    {
        let mut slot = AVAILABLE.lock().unwrap();
        // Already known, or already being installed: nothing new to say.
        if slot.as_ref().is_some_and(|u| u.version == manifest.version || u.state == "starting") {
            return Ok(());
        }
        *slot = Some(Update {
            notes: format!("{}/tag/v{}", common::RELEASES_URL, manifest.version),
            version: manifest.version,
            state: "available",
            error: None,
            setup,
        });
    }
    refresh(app);
    notify_if_away(app);
    Ok(())
}

/// The newer version and whether it can be started now (not already starting), for the tray menu.
pub fn available() -> Option<(String, bool)> {
    AVAILABLE.lock().unwrap().as_ref().map(|u| (u.version.clone(), u.state != "starting"))
}

/// Bring the tray menu and the editor up to date.
fn refresh(app: &AppHandle) {
    crate::refresh_tray(app);
    if let Some(window) = app.get_webview_window(crate::MAIN) {
        tell_editor(&window);
    }
}

/// Hand the editor this app's version and any update. Runs on every editor load, and when either changes.
pub fn tell_editor(window: &WebviewWindow) {
    if !window.url().is_ok_and(|url| crate::is_editor(&url)) {
        return;
    }
    let info = serde_json::json!({ "version": CURRENT, "update": *AVAILABLE.lock().unwrap() });
    let _ = window.eval(format!("window.__openpaperDesktop={info};window.dispatchEvent(new Event('openpaper-desktop'))"));
}

/// In the tray or minimized, the editor's notice isn't on screen: show a Windows notification instead, once per
/// version (remembered across launches, so it doesn't come back every few hours).
fn notify_if_away(app: &AppHandle) {
    if !crate::BACKGROUND.load(Ordering::SeqCst) {
        return;
    }
    let Some(update) = AVAILABLE.lock().unwrap().clone() else { return };
    let Some(dir) = app.path().app_local_data_dir().ok() else { return };
    let seen = dir.join("update.json");
    let notified = fs::read_to_string(&seen)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|info| info.get("notified")?.as_str().map(str::to_string));
    if notified.as_deref() == Some(update.version.as_str()) {
        return;
    }
    #[cfg(windows)]
    if crate::notify::show(app, &dir, &update.version, &update.notes).is_ok() {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(&seen, serde_json::json!({ "notified": update.version }).to_string());
    }
}

/// The install this app runs from, when Setup made it: the only kind Setup can update in place.
fn install_dir() -> Option<PathBuf> {
    if std::env::var_os("OPENPAPER_DESKTOP_RUNTIME").is_some() {
        return None;
    }
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let installed = common::node_exe(&dir).is_file() && common::server_cli(&dir).is_file() && dir.join(common::UNINSTALL_EXE).is_file();
    installed.then_some(dir)
}

/// Update to the newer version: from the editor's notice, the tray menu or the notification.
pub fn start(app: &AppHandle) {
    let Some(install) = install_dir() else {
        // Not an install Setup can update (a development build, say): show the release instead.
        if let Some(update) = AVAILABLE.lock().unwrap().as_ref() {
            let _ = app.opener().open_url(&update.notes, None::<&str>);
        }
        return;
    };
    let update = {
        let mut slot = AVAILABLE.lock().unwrap();
        let Some(update) = slot.as_mut().filter(|u| u.state != "starting") else { return };
        update.state = "starting";
        update.error = None;
        update.clone()
    };
    let app = app.clone();
    // Off this thread: it can be the window's navigation handler or the tray's menu handler.
    std::thread::spawn(move || {
        refresh(&app);
        let outcome = run_setup(&update, &install);
        // Setup quits this app once it's ready to swap the files in, so still being here means it stopped first
        // (cancelled during its download, or failed): offer the update again.
        let mut slot = AVAILABLE.lock().unwrap();
        if let Some(u) = slot.as_mut().filter(|u| u.version == update.version) {
            u.state = if outcome.is_ok() { "available" } else { "failed" };
            u.error = outcome.err();
        }
        let failed = slot.as_ref().is_some_and(|u| u.state == "failed");
        drop(slot);
        if failed {
            crate::show(&app);
        }
        refresh(&app);
    });
}

/// Download the release's Setup, check it, run it, and wait for it to finish.
fn run_setup(update: &Update, install: &std::path::Path) -> Result<(), String> {
    let bytes = get(&update.setup.url).map_err(|_| "Couldn't download the update. Check your internet connection and try again.".to_string())?;
    let sha256: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    let wrong_size = update.setup.size != 0 && bytes.len() as u64 != update.setup.size;
    let wrong_hash = !update.setup.sha256.is_empty() && !sha256.eq_ignore_ascii_case(update.setup.sha256.trim());
    if wrong_size || wrong_hash {
        return Err("The update was damaged on the way (its checksum doesn't match). Try again.".into());
    }
    // Setup deletes this copy of itself when it closes.
    let path = std::env::temp_dir().join(format!("OpenPaper-Update-{}.exe", update.version));
    fs::write(&path, &bytes).map_err(|e| format!("Couldn't save the update: {e}"))?;
    // Not in this app's working folder, which is the install (the shortcuts start it there): Setup, and the
    // browser processes it starts, would keep that folder open, and Windows can't move a folder that's in use.
    let mut setup = Command::new(&path)
        .arg("--update")
        .arg("--dir")
        .arg(install)
        .current_dir(std::env::temp_dir())
        .spawn()
        .map_err(|e| format!("Couldn't start the update: {e}"))?;
    let _ = setup.wait();
    Ok(())
}
