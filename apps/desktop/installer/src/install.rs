//! Download, check, unpack and swap in a release; and remove an install again.

use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use openpaper_common::{self as common, APP_EXE, UNINSTALL_EXE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;

use crate::system;

/// Where the release manifest lives. `scripts/package.mjs` can bake in another one (OPENPAPER_MANIFEST_URL at
/// build time), and OPENPAPER_SETUP_MANIFEST overrides it at run time for testing against a local folder.
const DEFAULT_MANIFEST: &str = "https://github.com/arshit09/OpenPaper/releases/latest/download/OpenPaper-windows-x64.json";
/// What a cancelled install rejects with; the page goes back to its first screen on it.
const CANCELLED: &str = "cancelled";

static CANCEL: AtomicBool = AtomicBool::new(false);

pub fn cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// One entry of the release manifest. `url` may be relative to the manifest.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub installed_size: u64,
}

#[derive(Serialize, Clone)]
#[serde(tag = "step", rename_all = "camelCase")]
pub enum Progress {
    Download { done: u64, total: u64 },
    Verify,
    Close,
    Extract { done: u64, total: u64 },
    Remove,
    Shortcuts,
    Done,
}

pub fn default_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("OPENPAPER_INSTALL_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| common::user_home().join("AppData").join("Local"));
    local.join("Programs").join("OpenPaper")
}

/// Install into an "OpenPaper" folder inside whatever folder was picked, unless it already is one.
pub fn with_app_folder(dir: &Path) -> PathBuf {
    let named = dir.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("OpenPaper"));
    if named { dir.to_path_buf() } else { dir.join("OpenPaper") }
}

/// Whether a folder holds an OpenPaper install (and so is safe to replace or delete).
pub fn looks_like_install(dir: &Path) -> bool {
    let home = common::user_home();
    dir.parent().is_some()
        && !common::is_inside(&home, dir)
        && (dir.join(APP_EXE).is_file() || dir.join(UNINSTALL_EXE).is_file() || common::server_cli(dir).is_file())
}

fn manifest_url() -> String {
    match std::env::var("OPENPAPER_SETUP_MANIFEST") {
        Ok(url) if !url.trim().is_empty() => url,
        _ => option_env!("OPENPAPER_MANIFEST_URL").unwrap_or(DEFAULT_MANIFEST).to_string(),
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("OpenPaper-Setup/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

fn offline(error: reqwest::Error) -> String {
    let host = error.url().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| "the download server".into());
    format!("Couldn't reach {host}. Check your internet connection and try again.")
}

pub async fn fetch_release() -> Result<Release, String> {
    let url = manifest_url();
    let base = reqwest::Url::parse(&url).map_err(|e| format!("The release address isn't valid ({url}): {e}"))?;
    let res = client()?.get(base.clone()).header("Cache-Control", "no-cache").send().await.map_err(offline)?;
    if !res.status().is_success() {
        return Err(format!("No OpenPaper release was found (the server answered {}).", res.status()));
    }
    let body = res.bytes().await.map_err(offline)?;
    let mut release: Release = serde_json::from_slice(&body).map_err(|e| format!("The release list couldn't be read: {e}"))?;
    release.url = base.join(&release.url).map_err(|e| e.to_string())?.to_string();
    Ok(release)
}

/// Install `release` into `dir`. Resolves with the folder it went into.
pub async fn run(dir: PathBuf, desktop: bool, release: Release, progress: Channel<Progress>) -> Result<PathBuf, String> {
    CANCEL.store(false, Ordering::SeqCst);
    let dir = with_app_folder(&dir);
    let has_files = fs::read_dir(&dir).is_ok_and(|mut entries| entries.next().is_some());
    if has_files && !looks_like_install(&dir) {
        return Err(format!("{} already has other files in it. Choose another folder.", dir.display()));
    }
    let downloads = std::env::temp_dir().join("OpenPaper-Setup");
    fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    let archive = downloads.join(format!("OpenPaper-{}-windows-x64.zip", release.version));
    let result = match download(&release, &archive, &progress).await {
        Ok(()) => {
            let (target, archive) = (dir.clone(), archive.clone());
            tauri::async_runtime::spawn_blocking(move || put_in_place(&target, &archive, desktop, &release, &progress))
                .await
                .unwrap_or_else(|e| Err(e.to_string()))
        }
        Err(e) => Err(e),
    };
    let _ = fs::remove_file(&archive);
    let _ = fs::remove_dir(&downloads); // only when empty
    result.map(|_| dir)
}

async fn download(release: &Release, to: &Path, progress: &Channel<Progress>) -> Result<(), String> {
    let mut res = client()?.get(&release.url).send().await.map_err(offline)?;
    if !res.status().is_success() {
        return Err(format!("The download failed (the server answered {}).", res.status()));
    }
    let total = res.content_length().unwrap_or(release.size);
    let mut file = BufWriter::new(File::create(to).map_err(|e| format!("Couldn't save the download: {e}"))?);
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    let mut last = Instant::now();
    let _ = progress.send(Progress::Download { done, total });
    while let Some(chunk) = res.chunk().await.map_err(offline)? {
        if CANCEL.load(Ordering::SeqCst) {
            drop(file);
            let _ = fs::remove_file(to);
            return Err(CANCELLED.into());
        }
        file.write_all(&chunk).map_err(|e| format!("Couldn't save the download: {e}"))?;
        hasher.update(&chunk);
        done += chunk.len() as u64;
        if last.elapsed() >= Duration::from_millis(100) {
            let _ = progress.send(Progress::Download { done, total });
            last = Instant::now();
        }
    }
    file.flush().map_err(|e| format!("Couldn't save the download: {e}"))?;
    drop(file);
    let _ = progress.send(Progress::Download { done, total: done });
    let _ = progress.send(Progress::Verify);
    let digest: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if done != release.size || !digest.eq_ignore_ascii_case(release.sha256.trim()) {
        let _ = fs::remove_file(to);
        return Err("The download was damaged on the way (its checksum doesn't match). Try again.".into());
    }
    Ok(())
}

fn put_in_place(dir: &Path, archive: &Path, desktop: bool, release: &Release, progress: &Channel<Progress>) -> Result<(), String> {
    let _ = progress.send(Progress::Close);
    if dir.exists() {
        close_running(dir);
    }
    let staging = beside(dir, "new");
    let old = beside(dir, "old");
    let _ = fs::remove_dir_all(&staging);
    let size = extract(archive, &staging, progress)?;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    fs::copy(&me, staging.join(UNINSTALL_EXE)).map_err(|e| format!("Couldn't add the uninstaller: {e}"))?;
    if let Err(e) = swap(dir, &staging, &old) {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    let _ = progress.send(Progress::Shortcuts);
    system::create_shortcuts(dir, desktop)?;
    system::register(dir, &release.version, size)?;
    let _ = progress.send(Progress::Done);
    Ok(())
}

/// A hidden working folder next to the install, on the same drive so the final move is a rename.
fn beside(dir: &Path, tag: &str) -> PathBuf {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "OpenPaper".into());
    dir.with_file_name(format!(".{name}-{}.{tag}", std::process::id()))
}

/// Unpack the release; returns the unpacked size in bytes.
fn extract(archive: &Path, to: &Path, progress: &Channel<Progress>) -> Result<u64, String> {
    let damaged = |e: zip::result::ZipError| format!("The download couldn't be unpacked: {e}");
    let file = File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(damaged)?;
    let total: u64 = (0..zip.len()).filter_map(|i| zip.by_index_raw(i).ok().map(|f| f.size())).sum();
    let mut done = 0u64;
    let mut last = Instant::now();
    fs::create_dir_all(to).map_err(|e| format!("Couldn't create {}: {e}", to.display()))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(damaged)?;
        let rel = entry.enclosed_name().ok_or_else(|| "The download has an unsafe file path in it.".to_string())?;
        let out = to.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut writer = BufWriter::new(File::create(&out).map_err(|e| format!("Couldn't write {}: {e}", out.display()))?);
        io::copy(&mut entry, &mut writer).map_err(|e| format!("Couldn't write {}: {e}", out.display()))?;
        writer.flush().map_err(|e| e.to_string())?;
        done += entry.size();
        if last.elapsed() >= Duration::from_millis(80) {
            let _ = progress.send(Progress::Extract { done, total });
            last = Instant::now();
        }
    }
    let _ = progress.send(Progress::Extract { done: total, total });
    Ok(total)
}

/// Move the old install aside, the new one in, then delete the old one; put the old one back on failure.
fn swap(dir: &Path, staging: &Path, old: &Path) -> Result<(), String> {
    let had_old = dir.exists();
    if had_old {
        retry(|| fs::rename(dir, old)).map_err(|e| {
            format!("Couldn't replace {}: {e}. Close any program using files in it, then try again.", dir.display())
        })?;
    } else if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    if let Err(e) = retry(|| fs::rename(staging, dir)) {
        if had_old {
            let _ = fs::rename(old, dir);
        }
        return Err(format!("Couldn't move OpenPaper into {}: {e}", dir.display()));
    }
    if had_old {
        let _ = fs::remove_dir_all(old);
    }
    Ok(())
}

/// Files can stay locked for a moment after their process exits (or while antivirus scans them).
fn retry<T>(mut op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let mut attempt = 0;
    loop {
        match op() {
            Ok(value) => return Ok(value),
            Err(e) if attempt >= 15 => return Err(e),
            Err(_) => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    }
}

/// Close everything running from an install: the app (asked politely first, which also stops its server),
/// its server, then anything else, such as an agent's `openpaper mcp` relay.
fn close_running(dir: &Path) {
    let apps: Vec<u32> = common::processes_in(dir)
        .into_iter()
        .filter(|(_, exe)| exe.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(APP_EXE)))
        .map(|(pid, _)| pid)
        .collect();
    if !apps.is_empty() {
        let _ = system::spawn_hidden(&dir.join(APP_EXE), &["--quit"]);
        for pid in apps {
            if !common::wait_exit(pid, Duration::from_secs(15)) {
                common::terminate(pid);
            }
        }
    }
    common::stop_server_in(dir);
    for (pid, _) in common::processes_in(dir) {
        common::terminate(pid);
        common::wait_exit(pid, Duration::from_secs(5));
    }
}

/// Uninstall: close it, delete its files (and, when asked, the user's designs), then its shortcuts and entry.
pub fn remove(dir: &Path, remove_data: bool, progress: &Channel<Progress>) -> Result<(), String> {
    if !looks_like_install(dir) {
        return Err(format!("{} doesn't look like an OpenPaper install, so nothing was removed.", dir.display()));
    }
    let _ = progress.send(Progress::Close);
    close_running(dir);
    let _ = progress.send(Progress::Remove);
    retry(|| fs::remove_dir_all(dir))
        .map_err(|e| format!("Couldn't delete {}: {e}. Close any program using files in it, then try again.", dir.display()))?;
    for folder in system::app_data_folders() {
        let _ = fs::remove_dir_all(folder);
    }
    if remove_data {
        let data = common::data_home();
        let ours = data.join("files").is_dir() || data.join("index.json").is_file() || data.join("config.json").is_file();
        if ours && data.parent().is_some() && !common::is_inside(&common::user_home(), &data) {
            retry(|| fs::remove_dir_all(&data))
                .map_err(|e| format!("OpenPaper was removed, but {} couldn't be deleted: {e}", data.display()))?;
        }
    }
    let _ = progress.send(Progress::Shortcuts);
    system::remove_shortcuts();
    system::unregister();
    let _ = progress.send(Progress::Done);
    Ok(())
}
