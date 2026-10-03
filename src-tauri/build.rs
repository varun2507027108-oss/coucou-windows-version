fn main() {
    // tauri_build embeds `dist/` into the binary, but Cargo has no idea the
    // frontend changed: it only re-runs a build script when *its own* inputs
    // change. After editing `src/`, a plain `cargo build` happily relinked the
    // crate against the assets embedded by the last run, so the release exe
    // silently kept serving the previous island (no error anywhere, and the
    // window still rendered, which made it look like a live bug).
    //
    // Re-run whenever anything under dist/ is newer than this script's output.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
