#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! owl desktop shell (Phase 3).
//!
//! One-click desktop entry:
//! - Auto-discovers serve.js and data directory without hardcoded machine paths
//! - Spawns the bridge (node serve.js) as a hidden child process
//! - Allocates an available port dynamically to prevent conflicts
//! - System tray support (show/hide window, restart bridge, exit)
//! - Cleans up child process tree cleanly on exit

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

mod gps;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
mod toast;
#[cfg(not(windows))]
mod toast {
    /// 非 Windows 占位：桌面壳当前只发 Windows 包，保持命令面完整以便前端统一调用。
    #[tauri::command]
    pub fn show_approval_toast() -> Result<(), String> {
        Err("toast notifications are only supported on Windows".into())
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

static DEBUG_UPDATE_STARTED: AtomicBool = AtomicBool::new(false);

/// 前端「退出 Owl」入口（帮助/文件菜单的 Ctrl+Q）：
/// RunEvent::Exit 钩子会顺带走 bridge.kill()，桥子进程不残留。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn is_source_repo_root(path: &Path) -> bool {
    path.join(".git").exists()
        && path.join("package.json").is_file()
        && path.join("apps/desktop/src-tauri/Cargo.toml").is_file()
}

fn find_source_repo_root(mut path: PathBuf) -> Option<PathBuf> {
    for _ in 0..10 {
        if is_source_repo_root(&path) {
            return Some(path);
        }
        if !path.pop() {
            break;
        }
    }
    None
}

fn resolve_source_repo_root() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("OWL_SOURCE_ROOT") {
        let root = PathBuf::from(path);
        if is_source_repo_root(&root) {
            return Some(root);
        }
    }
    if let Ok(path) = std::env::current_dir() {
        if let Some(root) = find_source_repo_root(path) {
            return Some(root);
        }
    }
    if let Ok(path) = std::env::current_exe() {
        if let Some(parent) = path.parent() {
            if let Some(root) = find_source_repo_root(parent.to_path_buf()) {
                return Some(root);
            }
        }
    }
    let fallback = PathBuf::from("D:/owl/owl-re-v1/owl-mono");
    is_source_repo_root(&fallback).then_some(fallback)
}

#[cfg(windows)]
fn spawn_debug_update_helper(repo: &Path, helper: &Path) -> Result<(), String> {
    let powershell = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .map(|root| root.join("System32/WindowsPowerShell/v1.0/powershell.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("powershell.exe"));
    let mut command = Command::new(powershell);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(helper)
        .arg("-ParentProcessId")
        .arg(std::process::id().to_string())
        .current_dir(repo)
        .creation_flags(CREATE_NEW_CONSOLE);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动调试更新窗口：{error}"))?;
    // The helper must still be waiting on this process after startup. An early exit means
    // another updater owns the mutex or PowerShell rejected the script; keep Owl open.
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(100));
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("无法确认调试更新进程状态：{error}"))?
        {
            return Err(format!(
                "调试更新进程提前退出（退出码 {}），当前 Owl 将保持运行。",
                status.code().unwrap_or(-1)
            ));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn spawn_debug_update_helper(_repo: &Path, _helper: &Path) -> Result<(), String> {
    Err("调试更新目前只支持 Windows。".to_owned())
}

#[tauri::command]
fn debug_rebuild_and_restart(app: tauri::AppHandle) -> Result<(), String> {
    if DEBUG_UPDATE_STARTED.swap(true, Ordering::SeqCst) {
        return Err("调试更新已经启动，请查看构建窗口。".to_owned());
    }
    let result = (|| {
        let repo = resolve_source_repo_root()
            .ok_or_else(|| "找不到 Owl 源码仓库，调试更新只支持源码构建。".to_owned())?;
        let helper = repo.join("scripts/owl-debug-update.ps1");
        if !helper.is_file() {
            return Err(format!("找不到调试更新脚本：{}", helper.display()));
        }
        let build_script = repo
            .parent()
            .map(|parent| parent.join("scripts/owl-start.ps1"))
            .ok_or_else(|| "无法定位 Owl 一键启动脚本。".to_owned())?;
        if !build_script.is_file() {
            return Err(format!("找不到一键启动脚本：{}", build_script.display()));
        }
        spawn_debug_update_helper(&repo, &helper)
    })();
    if let Err(error) = result {
        DEBUG_UPDATE_STARTED.store(false, Ordering::SeqCst);
        return Err(error);
    }

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(450));
        app.exit(0);
    });
    Ok(())
}

const DEFAULT_PORT: u16 = 18901;

/// serve.js does heavy top-level module loading before it starts listening;
/// a cold start measured ~13s, so allow a generous window.
const BRIDGE_START_TIMEOUT: Duration = Duration::from_secs(60);

/// Bridge output lands here (previously discarded, which made startup
/// failures like EADDRINUSE impossible to diagnose).
fn bridge_log_path() -> PathBuf {
    std::env::temp_dir().join("owl-bridge.log")
}

/// Locate the `serve.js` desktop bridge script.
fn resolve_serve_script() -> PathBuf {
    // 1. OWL_SERVE_SCRIPT override
    if let Ok(path) = std::env::var("OWL_SERVE_SCRIPT") {
        let p = PathBuf::from(path);
        if p.exists() {
            return p;
        }
    }

    // 2. Relative to executable (bundled NSIS / release mode)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // resources/packages/coding-agent/dist/modes/desktop/serve.js
            let cand1 = exe_dir
                .join("resources")
                .join("packages")
                .join("coding-agent")
                .join("dist")
                .join("modes")
                .join("desktop")
                .join("serve.js");
            if cand1.exists() {
                return cand1;
            }
            let cand2 = exe_dir
                .join("dist")
                .join("modes")
                .join("desktop")
                .join("serve.js");
            if cand2.exists() {
                return cand2;
            }
        }
    }

    // 3. Search upwards from cwd (dev mode)
    if let Ok(mut dir) = std::env::current_dir() {
        for _ in 0..6 {
            let cand = dir
                .join("packages")
                .join("coding-agent")
                .join("dist")
                .join("modes")
                .join("desktop")
                .join("serve.js");
            if cand.exists() {
                return cand;
            }
            let cand2 = dir
                .join("owl-mono")
                .join("packages")
                .join("coding-agent")
                .join("dist")
                .join("modes")
                .join("desktop")
                .join("serve.js");
            if cand2.exists() {
                return cand2;
            }
            if !dir.pop() {
                break;
            }
        }
    }

    // 4. Fallback to known default dev path
    PathBuf::from("D:/owl/owl-re-v1/owl-mono/packages/coding-agent/dist/modes/desktop/serve.js")
}

/// Locate the agent data directory (OWL_CODING_AGENT_DIR).
fn resolve_agent_dir() -> PathBuf {
    // 1. OWL_CODING_AGENT_DIR override
    if let Ok(path) = std::env::var("OWL_CODING_AGENT_DIR") {
        return PathBuf::from(path);
    }

    // 2. Search upwards for data/owl
    if let Ok(mut dir) = std::env::current_dir() {
        for _ in 0..6 {
            let cand = dir.join("data").join("owl");
            if cand.exists() {
                return cand;
            }
            let cand2 = dir.join("owl-re-v1").join("data").join("owl");
            if cand2.exists() {
                return cand2;
            }
            if !dir.pop() {
                break;
            }
        }
    }

    // 3. Fallback to dev path
    PathBuf::from("D:/owl/owl-re-v1/data/owl")
}

/// Find a free port, preferring `preferred` if available.
fn find_available_port(preferred: u16) -> u16 {
    if let Ok(env_p) = std::env::var("OWL_PORT") {
        if let Ok(p) = env_p.parse::<u16>() {
            return p;
        }
    }
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    // Let OS assign a free port
    if let Ok(listener) = TcpListener::bind("127.0.0.1:0") {
        if let Ok(addr) = listener.local_addr() {
            return addr.port();
        }
    }
    preferred
}

fn bridge_log_stdio() -> (Stdio, Stdio) {
    let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(bridge_log_path())
    else {
        return (Stdio::null(), Stdio::null());
    };
    match file.try_clone() {
        Ok(clone) => (Stdio::from(file), Stdio::from(clone)),
        Err(_) => (Stdio::null(), Stdio::null()),
    }
}

/// Tie the child's lifetime to this process via a Windows job object with
/// KILL_ON_JOB_CLOSE: when owl-desktop exits (even on panic), the kernel
/// terminates the bridge, so no orphaned node is left holding the port.
#[cfg(windows)]
fn tie_child_to_self(child: &Child) {
    use std::os::windows::io::AsRawHandle;

    use winapi::um::jobapi2::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    };
    use winapi::um::winnt::{
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *mut winapi::ctypes::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok != 0 {
            // The job handle is intentionally never closed; KILL_ON_JOB_CLOSE
            // fires when this process exits and the kernel reaps our handles.
            let _ =
                AssignProcessToJobObject(job, child.as_raw_handle() as winapi::um::winnt::HANDLE);
        }
    }
}

fn spawn_bridge(script: &Path, agent_dir: &Path, port: u16) -> Child {
    let (stdout, stderr) = bridge_log_stdio();
    let mut cmd = Command::new("node");
    cmd.args([
        script.to_string_lossy().as_ref(),
        "--port",
        &port.to_string(),
    ])
    .env("OWL_CODING_AGENT_DIR", agent_dir.to_string_lossy().as_ref())
    .stdin(Stdio::null())
    .stdout(stdout)
    .stderr(stderr);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd
        .spawn()
        .expect("failed to spawn owl bridge (is node on PATH?)");
    #[cfg(windows)]
    tie_child_to_self(&child);
    child
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

struct BridgeState {
    child: Option<Child>,
    port: u16,
    script: PathBuf,
    agent_dir: PathBuf,
}

impl BridgeState {
    fn kill(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Let the news queue save any paid response before terminating the bridge.
            // A crash still falls back to durable receipt/job recovery on the next start.
            if let Ok(mut stream) = TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], self.port)),
                Duration::from_secs(2),
            ) {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(210)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let request = format!(
					"POST /api/news/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
					self.port
				);
                if stream.write_all(request.as_bytes()).is_ok() {
                    let mut response = [0_u8; 128];
                    let _ = stream.read(&mut response);
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn restart(&mut self) -> Result<(), String> {
        self.kill();
        let child = spawn_bridge(&self.script, &self.agent_dir, self.port);
        if !wait_for_port(self.port, BRIDGE_START_TIMEOUT) {
            return Err(format!("Bridge failed to restart on port {}", self.port));
        }
        self.child = Some(child);
        Ok(())
    }
}

fn main() {
    let port = find_available_port(DEFAULT_PORT);
    let script = resolve_serve_script();
    let agent_dir = resolve_agent_dir();

    let child = spawn_bridge(&script, &agent_dir, port);
    eprintln!(
        "[owl] bridge spawning on port {port} (script: {}, log: {})",
        script.display(),
        bridge_log_path().display()
    );
    if !wait_for_port(port, BRIDGE_START_TIMEOUT) {
        panic!(
            "owl bridge did not start on port {port} within 60s; see {}",
            bridge_log_path().display()
        );
    }

    let bridge = Arc::new(Mutex::new(BridgeState {
        child: Some(child),
        port,
        script,
        agent_dir,
    }));

    let url: tauri::Url = format!("http://127.0.0.1:{port}").parse().unwrap();
    let bridge_for_setup = bridge.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            toast::show_approval_toast,
            quit_app,
            gps::gps_location,
            debug_rebuild_and_restart
        ])
        .setup(move |app| {
            let window =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                    .title("owl")
                    .inner_size(1280.0, 860.0)
                    .resizable(true)
                    .decorations(false)
                    .build()?;

            // 拦截窗口关闭：隐藏到托盘，保持后台会话运行
            let window_for_close = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window_for_close.hide();
                }
            });

            // 构建系统托盘
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart", "重启桥服务", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 Owl", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &restart_item, &quit_item])?;

            let bridge_for_tray = bridge_for_setup.clone();
            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Owl - AI 编程助手")
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "restart" => {
                        if let Ok(mut b) = bridge_for_tray.lock() {
                            let _ = b.restart();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if let Ok(visible) = w.is_visible() {
                                if visible {
                                    let _ = w.set_focus();
                                } else {
                                    let _ = w.show();
                                    let _ = w.unminimize();
                                    let _ = w.set_focus();
                                }
                            }
                        }
                    }
                });

            let icon = app.default_window_icon().cloned().unwrap_or_else(|| {
                tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
                    .expect("embedded icon must decode")
            });
            tray_builder = tray_builder.icon(icon);

            tray_builder.build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building owl desktop shell")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut b) = bridge.lock() {
                    b.kill();
                }
            }
        });
}
