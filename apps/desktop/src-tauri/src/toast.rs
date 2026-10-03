//! Windows 原生 Toast 通知（带操作按钮）。
//!
//! WebView2 的 Web Notification API 不支持操作按钮，审批类的「同意 / 拒绝」
//! 快捷裁决走这里：Rust 侧弹 Toast，按钮点击经 Activated 回调（进程内触发）
//! 转成 Tauri 事件发回前端应答。因此仅在 owl 运行期间可点，与桌面壳常驻形态一致。

use tauri::{AppHandle, Emitter, Manager};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::core::{HSTRING, IInspectable, Interface};
use windows::UI::Notifications::{ToastActivatedEventArgs, ToastNotification, ToastNotificationManager};

/// 应用 AUMID（与 tauri.conf 的 identifier 一致，NSIS 安装器会写进开始菜单快捷方式）。
/// 开发态没有快捷方式时 AUMID 未注册，退回 PowerShell 的 AUMID 保证 Toast 弹得出来
/// （归属图标不同，按钮与回调不受影响）。
const AUMID: &str = "dev.owl.desktop";
const FALLBACK_AUMID: &str = "Microsoft.Windows.PowerShell";

fn escape_xml(value: &str) -> String {
	let mut out = String::with_capacity(value.len());
	for ch in value.chars() {
		match ch {
			'&' => out.push_str("&amp;"),
			'<' => out.push_str("&lt;"),
			'>' => out.push_str("&gt;"),
			'"' => out.push_str("&quot;"),
			'\'' => out.push_str("&apos;"),
			_ => out.push(ch),
		}
	}
	out
}

fn focus_main_window(app: &AppHandle) {
	if let Some(window) = app.get_webview_window("main") {
		let _ = window.show();
		let _ = window.unminimize();
		let _ = window.set_focus();
	}
}

/// 弹一条带「同意 / 拒绝」按钮的系统 Toast。
/// 按钮点击后向前端发 `owl-toast-action`（kind=decision + requestId + approved），
/// 前端直接应答对应审批；点通知本体只回焦主窗口（不裁决）。
#[tauri::command]
pub fn show_approval_toast(
	app: AppHandle,
	title: String,
	body: String,
	request_id: String,
	approve_label: String,
	deny_label: String,
) -> Result<(), String> {
	let xml = format!(
		"<toast activationType=\"foreground\" launch=\"focus\">\
<visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>\
<actions>\
<action content=\"{}\" arguments=\"approve\" activationType=\"foreground\"/>\
<action content=\"{}\" arguments=\"deny\" activationType=\"foreground\"/>\
</actions></toast>",
		escape_xml(&title),
		escape_xml(&body),
		escape_xml(&approve_label),
		escape_xml(&deny_label),
	);

	let doc = XmlDocument::new().map_err(|error| error.to_string())?;
	doc.LoadXml(&HSTRING::from(xml)).map_err(|error| error.to_string())?;
	let toast = ToastNotification::CreateToastNotification(&doc).map_err(|error| error.to_string())?;

	let app_for_activate = app.clone();
	let request_id_for_activate = request_id.clone();
	toast
		.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, args| {
			let arguments = args
				.ok()
				.and_then(|inspectable| inspectable.cast::<ToastActivatedEventArgs>())
				.and_then(|activated| activated.Arguments())
				.map(|value| value.to_string())
				.unwrap_or_default();
			focus_main_window(&app_for_activate);
			if arguments == "approve" || arguments == "deny" {
				let _ = app_for_activate.emit(
					"owl-toast-action",
					serde_json::json!({
						"kind": "decision",
						"requestId": request_id_for_activate,
						"approved": arguments == "approve",
					}),
				);
			}
			Ok(())
		}))
		.map_err(|error| error.to_string())?;

	let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))
		.or_else(|_| ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(FALLBACK_AUMID)))
		.map_err(|error| error.to_string())?;
	notifier.Show(&toast).map_err(|error| error.to_string())?;
	Ok(())
}
