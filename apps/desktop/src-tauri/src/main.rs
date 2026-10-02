#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! owl desktop shell.
//!
//! One-click desktop entry: the shell spawns the bridge (node serve.js) as a
//! hidden child process, points the window at its single-port UI, and kills
//! the bridge when the app exits. Paths are dev-machine absolute for now;
//! M2 turns the bridge into a bundled sidecar (see DEV-README.md, Phase 3).

use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const SERVE_SCRIPT: &str = "D:/owl/owl-re-v1/owl-mono/packages/coding-agent/dist/modes/desktop/serve.js";
const AGENT_DIR: &str = "D:/owl/owl-re-v1/data/owl";
const DEFAULT_PORT: &str = "18901";

fn spawn_bridge(port: &str) -> Child {
	let mut cmd = Command::new("node");
	cmd.args([SERVE_SCRIPT, "--port", port])
		.env("OWL_CODING_AGENT_DIR", AGENT_DIR)
		// The shell is a GUI-subsystem binary; without CREATE_NO_WINDOW Windows
		// allocates a fresh console for the node child and flashes a black window.
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null());
	#[cfg(windows)]
	cmd.creation_flags(CREATE_NO_WINDOW);
	cmd
		.spawn()
		.expect("failed to spawn owl bridge (is node on PATH?)")
}

fn wait_for_port(port: &str, timeout: Duration) -> bool {
	let deadline = Instant::now() + timeout;
	while Instant::now() < deadline {
		if TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap())).is_ok() {
			return true;
		}
		std::thread::sleep(Duration::from_millis(150));
	}
	false
}

fn main() {
	let port = std::env::var("OWL_PORT").unwrap_or_else(|_| DEFAULT_PORT.to_string());
	let mut bridge = spawn_bridge(&port);
	if !wait_for_port(&port, Duration::from_secs(8)) {
		let _ = bridge.kill();
		panic!("owl bridge did not start on port {port}");
	}
	let url: tauri::Url = format!("http://127.0.0.1:{port}").parse().unwrap();
	let bridge = Mutex::new(Some(bridge));

	tauri::Builder::default()
		.setup(move |app| {
			tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
				.title("owl")
				.inner_size(1280.0, 860.0)
				.resizable(true)
				.decorations(false)
				.build()?;
			Ok(())
		})
		.build(tauri::generate_context!())
		.expect("error while building owl desktop shell")
		.run(move |_app, event| {
			if let tauri::RunEvent::Exit = event {
				if let Ok(mut guard) = bridge.lock() {
					if let Some(mut child) = guard.take() {
						let _ = child.kill();
						let _ = child.wait();
					}
				}
			}
		});
}
