use std::path::Path;

fn main() {
    // tauri-build watches tauri.conf.json and the icons, but not the frontend files
    // that `tauri::generate_context!` embeds into the binary. Without these directives
    // an edit that only touches ui/ can be silently left out of the built exe, because
    // cargo sees no reason to recompile the crate.
    //
    // Cargo treats a directory as a single path, so listing the files is what actually
    // catches a content change inside ui/.
    for_each_frontend_file(|rel| println!("cargo:rerun-if-changed={rel}"));

    tauri_build::build()
}

fn for_each_frontend_file(mut visit: impl FnMut(String)) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui");
    let Ok(entries) = std::fs::read_dir(&root) else {
        // A missing ui/ is a packaging problem, not a build problem: let tauri-build
        // report it from the config instead of failing the build script here.
        return;
    };
    for entry in entries.flatten() {
        if entry.path().is_file() {
            visit(format!("../ui/{}", entry.file_name().to_string_lossy()));
        }
    }
}
