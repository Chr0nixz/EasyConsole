fn main() {
    // Test binaries (cargo test) link `TaskDialogIndirect` from comctl32 via
    // tao/muda. That entry point only exists in comctl32 v6, which is selected
    // through an application manifest — tauri-build embeds one in the app
    // binary, but bare test executables have none and die at load time with
    // STATUS_ENTRYPOINT_NOT_FOUND. Embed a minimal v6 manifest into every test
    // target on Windows so the unit/integration tests can start at all.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest = std::env::var("CARGO_MANIFEST_DIR")
            .map(|dir| std::path::Path::new(&dir).join("tests-comctl.manifest"))
            .expect("CARGO_MANIFEST_DIR is set");
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
    tauri_build::build()
}
