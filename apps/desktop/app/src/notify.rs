//! A Windows notification that a new version is out, for when the window is in the tray.
//!
//! The app has no package, so it registers its name and icon for its ID under HKCU first (what Windows reads for
//! unpackaged apps; the uninstaller removes it). Clicking the notification opens the window; its Update button
//! starts the update; What's new opens the release notes in the browser.

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use openpaper_common as common;
use tauri::AppHandle;
use windows::core::{IInspectable, Interface, HSTRING};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{ToastActivatedEventArgs, ToastNotification, ToastNotificationManager};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

const ICON: &[u8] = include_bytes!("../icons/128x128.png");

/// The notification on screen; its click handler lives as long as it does.
static SHOWN: Mutex<Option<ToastNotification>> = Mutex::new(None);

pub fn show(app: &AppHandle, data_dir: &Path, version: &str, notes: &str) -> Result<(), String> {
    register(data_dir)?;
    // Safe to repeat on a thread that's already set up.
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let xml = format!(
        r#"<toast launch="open"><visual><binding template="ToastGeneric"><text>OpenPaper {version} is available</text><text>Update now: it takes about a minute, then OpenPaper opens again.</text></binding></visual><actions><action content="Update" arguments="update"/><action content="What's new" activationType="protocol" arguments="{notes}"/></actions></toast>"#,
        version = escape(version),
        notes = escape(notes),
    );
    let fail = |e: windows::core::Error| e.to_string();
    let doc = XmlDocument::new().map_err(fail)?;
    doc.LoadXml(&HSTRING::from(xml)).map_err(fail)?;
    let toast = ToastNotification::CreateToastNotification(&doc).map_err(fail)?;
    let app = app.clone();
    let handler = TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, args| {
        let action = args.ok().ok().and_then(|a| a.cast::<ToastActivatedEventArgs>().ok()).and_then(|a| a.Arguments().ok());
        crate::show(&app);
        if action.is_some_and(|a| a == "update") {
            crate::update::start(&app);
        }
        Ok(())
    });
    toast.Activated(&handler).map_err(fail)?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(common::APP_IDENTIFIER))
        .and_then(|notifier| notifier.Show(&toast))
        .map_err(fail)?;
    *SHOWN.lock().unwrap() = Some(toast);
    Ok(())
}

/// Name and icon for the app's notifications.
fn register(data_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let icon = data_dir.join("notification-icon.png");
    if fs::metadata(&icon).map(|m| m.len()).ok() != Some(ICON.len() as u64) {
        fs::write(&icon, ICON).map_err(|e| e.to_string())?;
    }
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(common::NOTIFICATION_KEY).map_err(|e| e.to_string())?;
    key.set_value("DisplayName", &"OpenPaper").map_err(|e| e.to_string())?;
    key.set_value("IconUri", &icon.display().to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}
