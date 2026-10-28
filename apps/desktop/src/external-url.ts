/**
 * 外链白名单：只有 http(s) 且能解析成绝对地址的 URL 才允许交给系统浏览器打开。
 *
 * 调用方拿到的 URL 常常来自模型输出、文档正文或插件内容（链接卡片、指南条目、
 * 搜索结果），都是不可信输入。`window.open("javascript:...")` 在 Electron/WebView
 * 里能拿到与宿主页同等的执行能力，`file:` 能摸本地文件，所以必须在出口统一拦一次，
 * 而不是指望每个调用点各自记得校验。
 */
export function toExternalUrl(url: string): string | undefined {
	const trimmed = url.trim();
	if (!trimmed) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	return parsed.href;
}
