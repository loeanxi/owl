/**
 * 浏览器侧文本文件下载：Blob → objectURL → <a download> 一次性点击。
 * Tauri webview 加载的是 http 页面，这条路径原生可用（与 news-client 的 downloadNews 同款）。
 */
export function downloadTextFile(content: string, filename: string, mime = "text/plain"): void {
	const url = URL.createObjectURL(new Blob([content], { type: mime }));
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
