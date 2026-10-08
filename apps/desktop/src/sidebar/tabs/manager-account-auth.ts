interface AccountAuthMessageEvent {
	origin: string;
	source: unknown;
	data: unknown;
}

interface AccountAuthMessageHost {
	addEventListener(type: "message", listener: (event: AccountAuthMessageEvent) => void): void;
	removeEventListener(type: "message", listener: (event: AccountAuthMessageEvent) => void): void;
}

interface AccountAuthFrame {
	postMessage(data: unknown, targetOrigin: string): void;
}

type AuthPlatform = "CURSOR" | "COPILOT" | "QODER" | "CLAUDE";

interface AccountAuthOpenRequest {
	type: "owl:account-auth:open" | "owl:account-quota:open";
	requestId: string;
	platform: AuthPlatform;
	url: string;
}

/** Account login destinations and the one explicit Cursor quota dashboard. */
function officialAuthUrl(request: AccountAuthOpenRequest): boolean {
	if (request.url.length > 16_384 || /[\u0000-\u0020\u007f]/.test(request.url)) return false;
	let url: URL;
	try { url = new URL(request.url); } catch { return false; }
	if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
	if (request.type === "owl:account-quota:open") {
		return request.platform === "CURSOR" && url.hostname === "cursor.com" && url.pathname === "/dashboard/spending" && !url.search && !url.hash;
	}
	switch (request.platform) {
		case "CURSOR": return url.hostname === "cursor.com" && url.pathname === "/loginDeepControl";
		case "COPILOT": return url.hostname === "github.com" && /^\/login\/device\/?$/.test(url.pathname);
		case "QODER": return ["qoder.cn", "qoder.com.cn"].includes(url.hostname) && url.pathname === "/device/selectAccounts";
		case "CLAUDE": return url.hostname === "claude.com" && url.pathname === "/cai/oauth/authorize";
	}
}

/** The manager iframe cannot rely on WebView2's unhandled target=_blank popups. */
export function attachManagerAccountAuth(options: {
	host: AccountAuthMessageHost;
	managerUrl: string;
	frameWindow: () => AccountAuthFrame | null;
	openExternal: (url: string) => Promise<void>;
}): () => void {
	const origin = new URL(options.managerUrl).origin;
	const pending = new Set<string>();
	let active = true;
	const listener = (event: AccountAuthMessageEvent): void => {
		const frame = options.frameWindow();
		if (!active || !frame || event.source !== frame || event.origin !== origin) return;
		if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return;
		const data = event.data as Record<string, unknown>;
		if ((data.type !== "owl:account-auth:open" && data.type !== "owl:account-quota:open") || typeof data.requestId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(data.requestId)) return;
		if (typeof data.platform !== "string" || !["CURSOR", "COPILOT", "QODER", "CLAUDE"].includes(data.platform) || typeof data.url !== "string") return;
		const request = data as unknown as AccountAuthOpenRequest;
		const quota = request.type === "owl:account-quota:open";
		const reply = (opened: boolean, error?: string): void => {
			if (!active || options.frameWindow() !== frame) return;
			frame.postMessage({ type: quota ? "owl:account-quota:opened" : "owl:account-auth:opened", requestId: request.requestId, opened, ...(error ? { error } : {}) }, origin);
		};
		if (!officialAuthUrl(request)) {
			reply(false, quota ? "invalid_quota_url" : "invalid_auth_url");
			return;
		}
		const key = `${request.type}:${request.requestId}`;
		if (pending.has(key)) return;
		pending.add(key);
		void Promise.resolve().then(() => options.openExternal(request.url)).then(
			() => reply(true),
			() => reply(false, "external_open_failed"),
		).finally(() => pending.delete(key));
	};
	options.host.addEventListener("message", listener);
	return () => {
		active = false;
		options.host.removeEventListener("message", listener);
	};
}
