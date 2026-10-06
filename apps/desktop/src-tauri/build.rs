fn main() {
	// 声明应用自身的命令 ACL：owl 桌面页面加载的是远程地址（http://127.0.0.1:端口），
	// Tauri v2 对远程页面的自定义命令一律走 ACL（远程内容不显式授权就到不了自定义命令），
	// 不声明时 invoke("show_approval_toast") 直接被拒——这是「审批 Toast 不弹出」的根因。
	// AppManifest 为列出的命令自动生成 allow-$command / deny-$command 权限，
	// 由 capabilities/default.json 以裸标识符引用（无前缀即 app ACL 命名空间）。
	tauri_build::try_build(
		tauri_build::Attributes::new()
			.app_manifest(tauri_build::AppManifest::new().commands(&[
				"show_approval_toast",
				"quit_app",
				"reveal_in_file_manager",
				"gps_location",
				"debug_rebuild_and_restart",
			])),
	)
	.expect("failed to run tauri-build");
}
