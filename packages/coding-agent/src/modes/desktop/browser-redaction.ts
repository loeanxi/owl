/**
 * 浏览器诊断证据的脱敏。
 *
 * 从 browser-network.ts 抽出：网络证据（header / body / URL）与控制台消息共用同一套
 * 秘密字段判定，避免两边规则漂移。页面 console.log(token) 原样进模型上下文，与网络
 * 响应里带 token 是同一类泄漏——控制台同样要过这道闸。
 */

export const REDACTED = "[REDACTED]";

/** 键名命中即视为秘密：auth / cookie / password / token / secret / csrf 等。 */
export function isSecretKey(key: string): boolean {
	return /auth|cookie|password|passwd|passphrase|token|apikey|secret|credential|sessionid|csrf|xsrf/.test(
		key.toLowerCase().replace(/[^a-z0-9]/g, ""),
	);
}

/** 去掉凭据形态的值：labeled 字段、Bearer/Basic、URL 里的 userinfo 与 query。 */
export function redactSecrets(text: string): string {
	return redactText(text, 0);
}

/** 脱敏单个 URL：去 userinfo 与 hash，query 里的秘密键与嵌套文本按同一规则处理。 */
export function redactUrl(value: string): string {
	return redactUrlValue(value, 0);
}

function redactText(text: string, depth: number): string {
	return text
		.replace(/<(input|meta)\b[^>]*>/gi, (tag) => {
			const fields = [...tag.matchAll(/\b(?:name|id|type)\s*=\s*["']([^"']*)["']/gi)];
			if (!fields.some((field) => isSecretKey(field[1]))) return tag;
			return tag.replace(/(\b(?:value|content)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi, `$1"${REDACTED}"`);
		})
		.replace(/<([a-z][a-z0-9:_-]*)\b[^>]*>([^<]*)<\/\1\s*>/gi, (match, key: string) =>
			isSecretKey(key) ? `<${key}>${REDACTED}</${key}>` : match,
		)
		.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (value) => redactUrlValue(value, depth + 1))
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, `$1 ${REDACTED}`)
		.replace(
			/(["']?[a-z0-9_-]*(?:auth|cookie|password|passwd|passphrase|token|api[-_]?key|secret|credential|session[-_]?id|csrf|xsrf)[a-z0-9_-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&<>]+)/gi,
			(_match, prefix: string) => `${prefix}"${REDACTED}"`,
		);
}

function redactUrlValue(value: string, depth: number): string {
	if (depth > 4) return "[nested URL omitted]";
	try {
		const url = new URL(value);
		if (url.protocol === "data:") return "data:[body omitted]";
		url.username = "";
		url.password = "";
		url.hash = "";
		const parameters = [...url.searchParams.entries()];
		url.search = "";
		for (const [key, content] of parameters) {
			url.searchParams.append(key, isSecretKey(key) ? REDACTED : redactText(content, depth));
		}
		return url.toString();
	} catch {
		return "[invalid URL omitted]";
	}
}
