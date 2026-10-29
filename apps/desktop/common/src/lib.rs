//! Shared by OpenPaper.exe and OpenPaper Setup.exe: where an install keeps its files, and how to
//! find, start and stop the local OpenPaper server. A server is only ever stopped when its node.exe
//! lives in the install being handled, so a server run from a git clone or another install is left alone.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub const DEFAULT_PORT: u16 = 29_880;
pub const APP_EXE: &str = "OpenPaper.exe";
pub const UNINSTALL_EXE: &str = "Uninstall OpenPaper.exe";
/// Tauri identifier of the app; names its WebView2 data and window-state folders.
pub const APP_IDENTIFIER: &str = "io.github.arshit09.openpaper";

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Bundled runtime inside an install folder.
pub fn node_exe(install_dir: &Path) -> PathBuf {
    install_dir.join("node").join("node.exe")
}

pub fn server_cli(install_dir: &Path) -> PathBuf {
    install_dir.join("server").join("cli.js")
}

pub fn user_home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// The data folder, same rule as the server's paths.ts: OPENPAPER_HOME, else ~/.openpaper.
pub fn data_home() -> PathBuf {
    match std::env::var_os("OPENPAPER_HOME") {
        Some(h) if !h.is_empty() => PathBuf::from(h),
        _ => user_home().join(".openpaper"),
    }
}

/// An explicit port from OPENPAPER_PORT, for running a second, isolated copy next to another one.
pub fn port_override() -> Option<u16> {
    std::env::var("OPENPAPER_PORT").ok()?.trim().parse().ok()
}

/// Ports to look on, like the server's findRunningServer: the explicit port only, else server.json's, then the default.
fn candidate_ports() -> Vec<u16> {
    if let Some(port) = port_override() {
        return vec![port];
    }
    let mut ports: Vec<u16> = server_json_port().into_iter().collect();
    if !ports.contains(&DEFAULT_PORT) {
        ports.push(DEFAULT_PORT);
    }
    ports
}

fn server_json_port() -> Option<u16> {
    let text = fs::read_to_string(data_home().join("server.json")).ok()?;
    let info: serde_json::Value = serde_json::from_str(&text).ok()?;
    u16::try_from(info.get("port")?.as_u64()?).ok()
}

pub struct Health {
    pub pid: u32,
}

/// `GET /api/health`; Some when an OpenPaper server answers on that port.
pub fn health(port: u16) -> Option<Health> {
    let (status, body) = request("GET", port, "/api/health", Duration::from_millis(1500)).ok()?;
    if status != 200 {
        return None;
    }
    let info: serde_json::Value = serde_json::from_str(&body).ok()?;
    if info.get("name")?.as_str()? != "openpaper" {
        return None;
    }
    Some(Health { pid: u32::try_from(info.get("pid")?.as_u64()?).ok()? })
}

pub fn find_running() -> Option<(u16, Health)> {
    candidate_ports().into_iter().find_map(|port| health(port).map(|h| (port, h)))
}

/// HTTP/1.0 to the local server: no keep-alive and no chunked bodies, so reading to EOF is the whole response.
fn request(method: &str, port: u16, path: &str, timeout: Duration) -> std::io::Result<(u16, String)> {
    // Windows retries a refused connection for about two seconds before reporting it, while a listening
    // local port accepts in well under a millisecond: give up on the connect quickly.
    let connect = timeout.min(Duration::from_millis(200));
    let mut stream = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), connect)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    write!(stream, "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\n\r\n")?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok((status, body.to_string()))
}

/// Make sure a server is running, starting `node cli.js serve` in the background when none is.
/// Resolves with its port. The server outlives the caller, so agents keep working after the window closes.
pub fn ensure_server(node: &Path, cli: &Path) -> Result<u16, String> {
    if let Some((port, _)) = find_running() {
        return Ok(port);
    }
    let logs = data_home().join("logs");
    fs::create_dir_all(&logs).map_err(|e| format!("Couldn't create {}: {e}", logs.display()))?;
    let log_path = logs.join("server.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Couldn't open {}: {e}", log_path.display()))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(node);
    cmd.arg(cli).args(["serve", "--no-open"]);
    if let Some(port) = port_override() {
        cmd.args(["--port", &port.to_string()]);
    }
    if let Some(dir) = cli.parent() {
        cmd.current_dir(dir);
    }
    cmd.env("OPENPAPER_BACKGROUND", "1").stdin(Stdio::null()).stdout(log).stderr(log_err);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start {}: {e}", node.display()))?;

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        std::thread::sleep(Duration::from_millis(100));
        if let Some((port, _)) = find_running() {
            return Ok(port);
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("The OpenPaper server stopped ({status}). Details are in {}", log_path.display()));
        }
        if Instant::now() > deadline {
            return Err(format!("The OpenPaper server didn't start in time. Details are in {}", log_path.display()));
        }
    }
}

/// Ask the running server to shut down if its node.exe lives in `install_dir`, and wait until it stops
/// answering (its port is free again). Returns its pid when it was ours.
pub fn request_stop_in(install_dir: &Path) -> Option<u32> {
    let (port, h) = find_running()?;
    if !process_image(h.pid).is_some_and(|exe| is_inside(&exe, install_dir)) {
        return None;
    }
    let _ = request("POST", port, "/api/shutdown", Duration::from_secs(3));
    let deadline = Instant::now() + Duration::from_secs(3);
    while health(port).is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    Some(h.pid)
}

/// Stop the running server if its node.exe lives in `install_dir`, waiting for its process to end so its files
/// can be replaced. Returns whether one was stopped.
pub fn stop_server_in(install_dir: &Path) -> bool {
    let Some(pid) = request_stop_in(install_dir) else { return false };
    if !wait_exit(pid, Duration::from_secs(10)) {
        terminate(pid);
        wait_exit(pid, Duration::from_secs(3));
    }
    true
}

/// Case-insensitive path prefix check (Windows paths).
pub fn is_inside(path: &Path, dir: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let (path, dir) = (norm(path), norm(dir));
    path == dir || path.starts_with(&(dir + "\\"))
}

/// Whether Windows apps are set to dark mode.
pub fn system_prefers_dark() -> bool {
    #[cfg(windows)]
    {
        read_dword(
            win::HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "AppsUseLightTheme",
        ) == Some(0)
    }
    #[cfg(not(windows))]
    false
}

#[cfg(windows)]
mod win {
    pub use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
    pub use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    pub use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW,
    };
    pub use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
    };

    pub fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub struct Handle(pub HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    pub fn open(pid: u32, access: u32) -> Option<Handle> {
        let h = unsafe { OpenProcess(access, 0, pid) };
        (!h.is_null()).then_some(Handle(h))
    }
}

/// Full path of a running process's executable.
pub fn process_image(pid: u32) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let h = win::open(pid, win::PROCESS_QUERY_LIMITED_INFORMATION)?;
        let mut buf = vec![0u16; 32_768];
        let mut len = buf.len() as u32;
        let ok = unsafe { win::QueryFullProcessImageNameW(h.0, win::PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) };
        (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

/// Wait for a process to exit; true once it has (or no longer exists).
pub fn wait_exit(pid: u32, timeout: Duration) -> bool {
    #[cfg(windows)]
    {
        let Some(h) = win::open(pid, win::PROCESS_SYNCHRONIZE) else { return true };
        unsafe { win::WaitForSingleObject(h.0, timeout.as_millis() as u32) == win::WAIT_OBJECT_0 }
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, timeout);
        true
    }
}

pub fn terminate(pid: u32) {
    #[cfg(windows)]
    if let Some(h) = win::open(pid, win::PROCESS_TERMINATE) {
        unsafe { win::TerminateProcess(h.0, 1) };
    }
    #[cfg(not(windows))]
    let _ = pid;
}

/// Processes (other than this one) whose executable lives in `dir`.
pub fn processes_in(dir: &Path) -> Vec<(u32, PathBuf)> {
    let mut found = Vec::new();
    #[cfg(windows)]
    unsafe {
        let snap = win::CreateToolhelp32Snapshot(win::TH32CS_SNAPPROCESS, 0);
        if snap == win::INVALID_HANDLE_VALUE {
            return found;
        }
        let snap = win::Handle(snap);
        let mut entry: win::PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<win::PROCESSENTRY32W>() as u32;
        let mut more = win::Process32FirstW(snap.0, &mut entry) != 0;
        while more {
            let pid = entry.th32ProcessID;
            if pid != std::process::id() {
                if let Some(exe) = process_image(pid).filter(|exe| is_inside(exe, dir)) {
                    found.push((pid, exe));
                }
            }
            more = win::Process32NextW(snap.0, &mut entry) != 0;
        }
    }
    #[cfg(not(windows))]
    let _ = dir;
    found
}

#[cfg(windows)]
pub fn read_dword(root: win::HKEY, key: &str, value: &str) -> Option<u32> {
    let (key, value) = (win::wide(key), win::wide(value));
    let mut data = 0u32;
    let mut size = 4u32;
    let status = unsafe {
        win::RegGetValueW(
            root,
            key.as_ptr(),
            value.as_ptr(),
            win::RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut data as *mut u32).cast(),
            &mut size,
        )
    };
    (status == 0).then_some(data)
}

#[cfg(windows)]
pub fn read_string(root: win::HKEY, key: &str, value: &str) -> Option<String> {
    let (key, value) = (win::wide(key), win::wide(value));
    let mut buf = vec![0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    let status = unsafe {
        win::RegGetValueW(
            root,
            key.as_ptr(),
            value.as_ptr(),
            win::RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    let len = (size as usize / 2).saturating_sub(1);
    Some(String::from_utf16_lossy(&buf[..len]))
}

#[cfg(windows)]
pub use win::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
