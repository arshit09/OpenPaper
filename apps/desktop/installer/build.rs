fn main() {
    // The release manifest URL is baked in at build time (see scripts/package.mjs).
    println!("cargo:rerun-if-env-changed=OPENPAPER_MANIFEST_URL");
    let windows = tauri_build::WindowsAttributes::new().app_manifest(include_str!("../windows.manifest"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri-build failed");
}
