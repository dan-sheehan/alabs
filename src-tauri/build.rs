fn main() {
    // Only the desktop build needs the Tauri context, icons and plugin
    // permissions. `alabs-serve` builds with no build hook at all.
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
