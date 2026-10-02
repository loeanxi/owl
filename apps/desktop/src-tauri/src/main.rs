#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// pire desktop shell: the UI talks to the bridge over WebSocket on localhost;
// the shell only provides the window. Spawn the bridge as a sidecar or child
// process in M2 (see DEV-README.md, Phase 3).

fn main() {
	tauri::Builder::default()
		.run(tauri::generate_context!())
		.expect("error while running pire desktop shell");
}
