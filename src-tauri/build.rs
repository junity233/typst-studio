fn main() {
    tauri_build::build();

    // Tauri's Windows UI dependencies import `TaskDialogIndirect`, which only
    // exists in Common Controls v6. Tauri embeds the required v6 manifest in
    // the application binary, but Cargo's lib unit-test harness is a separate
    // executable and does not inherit that resource. Eager DLL binding would
    // therefore make the harness exit before `main` with
    // STATUS_ENTRYPOINT_NOT_FOUND. Tests do not open native UI, so delay-load
    // comctl32; the real application still resolves it under Tauri's manifest.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-lib=delayimp");
        println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
    }
}
