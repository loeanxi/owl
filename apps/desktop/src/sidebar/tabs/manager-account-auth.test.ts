import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { attachManagerAccountAuth } from "./manager-account-auth.ts";

interface MessageEventFixture {
	origin: string;
	source: unknown;
	data: unknown;
}

function renderManager() {
	const replies: Array<{ data: unknown; origin: string }> = [];
	const frame = { postMessage: (data: unknown, origin: string) => replies.push({ data, origin }) };
	const listeners = new Set<(event: MessageEventFixture) => void>();
	const opened: string[] = [];
	const cleanup: Array<() => void> = [];
	const jsx = (type: unknown, props: Record<string, unknown> | null): unknown => {
		if (type === "iframe" && props?.ref && typeof props.ref === "object") {
			Object.assign(props.ref, { current: { contentWindow: frame } });
		}
		return { type, props };
	};
	const react = {
		useState: (initial: unknown) => [initial === "checking" ? "up" : typeof initial === "function" ? initial() : initial, () => {}],
		useRef: (initial: unknown) => ({ current: initial }),
		useCallback: (callback: unknown) => callback,
		useEffect: (effect: () => (() => void) | undefined) => {
			const dispose = effect();
			if (dispose) cleanup.push(dispose);
		},
	};
	const currentDir = dirname(fileURLToPath(import.meta.url));
	const source = readFileSync(resolve(currentDir, "ManagerTab.tsx"), "utf8");
	const built = buildSync({
		stdin: { contents: source, resolveDir: currentDir, loader: "tsx" },
		bundle: true,
		write: false,
		format: "cjs",
		platform: "node",
		jsx: "automatic",
		external: ["react", "react/jsx-runtime"],
	});
	const module = { exports: {} as { ManagerTab?: (props: { onOpenExternal: (url: string) => Promise<void> }) => unknown } };
	runInNewContext(built.outputFiles[0].text, {
		module,
		exports: module.exports,
		require: (name: string) => name === "react" ? react : { jsx, jsxs: jsx },
		URL,
		AbortSignal,
		fetch: () => Promise.resolve({ ok: true }),
		window: {
			addEventListener: (_type: string, listener: (event: MessageEventFixture) => void) => listeners.add(listener),
			removeEventListener: (_type: string, listener: (event: MessageEventFixture) => void) => listeners.delete(listener),
		},
	});
	assert.ok(module.exports.ManagerTab);
	module.exports.ManagerTab({ onOpenExternal: async (url) => { opened.push(url); } });
	return {
		frame, opened, replies,
		emit: (data: unknown) => { for (const listener of listeners) listener({ source: frame, origin: "http://127.0.0.1:8790", data }); },
		dispose: () => { for (const callback of cleanup) callback(); },
	};
}

test("ManagerTab routes an account authorization click to the system browser without a webview popup", async () => {
	const f = renderManager();
	const url = "https://cursor.com/loginDeepControl?challenge=fixture&uuid=fixture&mode=login&redirectTarget=sdk";
	try {
		f.emit({ type: "owl:account-auth:open", requestId: "auth-fixture-1", platform: "CURSOR", url });
		await setImmediate();
		assert.deepEqual(f.opened, [url]);
		assert.deepEqual(JSON.parse(JSON.stringify(f.replies)), [{ data: { type: "owl:account-auth:opened", requestId: "auth-fixture-1", opened: true }, origin: "http://127.0.0.1:8790" }]);
	} finally { f.dispose(); }
});

test("ManagerTab opens the Cursor spending dashboard through the quota operation", async () => {
	const f = renderManager();
	const url = "https://cursor.com/dashboard/spending";
	try {
		f.emit({ type: "owl:account-quota:open", requestId: "quota-fixture-1", platform: "CURSOR", url });
		await setImmediate();
		assert.deepEqual(f.opened, [url]);
		assert.deepEqual(JSON.parse(JSON.stringify(f.replies)), [{ data: { type: "owl:account-quota:opened", requestId: "quota-fixture-1", opened: true }, origin: "http://127.0.0.1:8790" }]);
	} finally { f.dispose(); }
});

function authFixture(openExternal?: (url: string) => Promise<void>) {
	const listeners = new Set<(event: MessageEventFixture) => void>();
	const replies: Array<{ data: unknown; origin: string }> = [];
	const frame = { postMessage: (data: unknown, origin: string) => replies.push({ data, origin }) };
	let currentFrame: typeof frame | null = frame;
	const opened: string[] = [];
	const dispose = attachManagerAccountAuth({
		host: {
			addEventListener: (_type, listener) => { listeners.add(listener); },
			removeEventListener: (_type, listener) => { listeners.delete(listener); },
		},
		managerUrl: "http://127.0.0.1:8790",
		frameWindow: () => currentFrame,
		openExternal: async (url) => { opened.push(url); await openExternal?.(url); },
	});
	return {
		frame, opened, replies, dispose,
		emit: (data: unknown, source: unknown = frame, origin = "http://127.0.0.1:8790") => {
			for (const listener of listeners) listener({ data, source, origin });
		},
		replaceFrame: () => { currentFrame = { postMessage: () => {} }; },
	};
}

const request = (platform = "CURSOR", url = "https://cursor.com/loginDeepControl?challenge=fixture", requestId = "fixture-1") => ({ type: "owl:account-auth:open", platform, url, requestId });

test("only the current manager frame and configured origin can request authorization opening", async () => {
	const f = authFixture();
	f.emit(request(), { postMessage: () => {} });
	f.emit(request(), f.frame, "http://127.0.0.1:9999");
	f.emit(request(), f.frame, "http://localhost:8790");
	f.emit(request(), f.frame, "null");
	f.emit(request(), f.frame, "https://cursor.com");
	await setImmediate();
	assert.deepEqual(f.opened, []);
	assert.deepEqual(f.replies, []);
	f.dispose();
});

test("official authorization destinations remain scoped to their matching platform", async () => {
	const f = authFixture();
	const destinations = [
		["CURSOR", "https://cursor.com/loginDeepControl?challenge=fixture"],
		["COPILOT", "https://github.com/login/device"],
		["QODER", "https://qoder.cn/device/selectAccounts?challenge=fixture"],
		["CLAUDE", "https://claude.com/cai/oauth/authorize?state=fixture"],
	];
	for (const [index, [platform, url]] of destinations.entries()) f.emit(request(platform, url, `fixture-${index}`));
	await setImmediate();
	assert.deepEqual(f.opened, destinations.map(([, url]) => url));
	assert.equal(f.replies.length, 4);
	f.dispose();
});

test("unsafe schemes, lookalike hosts, unrelated paths, credentials and ports never reach the system opener", async () => {
	const f = authFixture();
	const urls = [
		"cursor://settings", "file:///C:/Windows/System32/cmd.exe", "javascript:alert(1)",
		"http://cursor.com/loginDeepControl", "https://cursor.com.evil.test/loginDeepControl",
		"https://evil.test/loginDeepControl", "https://cursor.com/dashboard", "https://github.com/login/device",
		"https://user:password@cursor.com/loginDeepControl", "https://cursor.com:444/loginDeepControl",
		"https://cursor.com/loginDeepControl\n", "https://cursor.com/redirect?url=https://evil.test",
	];
	for (const [index, url] of urls.entries()) f.emit(request("CURSOR", url, `unsafe-${index}`));
	await setImmediate();
	assert.deepEqual(f.opened, []);
	assert.equal(f.replies.length, urls.length);
	for (const reply of f.replies) assert.deepEqual(reply.data, { type: "owl:account-auth:opened", requestId: `unsafe-${f.replies.indexOf(reply)}`, opened: false, error: "invalid_auth_url" });
	f.dispose();
});

test("malformed messages are ignored and open failures do not expose challenge URLs", async () => {
	const f = authFixture(async (url) => { throw new Error(`Failure opening ${url}`); });
	for (const data of [null, [], {}, { ...request(), requestId: "" }, { ...request(), platform: "UNKNOWN" }, { ...request(), url: 1 }, { ...request(), type: "open.external" }]) f.emit(data);
	await setImmediate();
	assert.deepEqual(f.opened, []);
	f.emit(request());
	await setImmediate();
	assert.deepEqual(f.replies, [{ data: { type: "owl:account-auth:opened", requestId: "fixture-1", opened: false, error: "external_open_failed" }, origin: "http://127.0.0.1:8790" }]);
	f.dispose();
});

test("duplicate pending clicks and stale completions cannot open twice or update a replaced frame", async () => {
	let finish: (() => void) | undefined;
	const f = authFixture(() => new Promise((resolve) => { finish = resolve; }));
	f.emit(request());
	f.emit(request());
	await setImmediate();
	assert.equal(f.opened.length, 1);
	f.replaceFrame();
	finish?.();
	await setImmediate();
	assert.deepEqual(f.replies, []);
	f.dispose();
	f.emit(request());
	await setImmediate();
	assert.equal(f.opened.length, 1);
});

test("quota opening permits only the exact Cursor spending destination from the manager frame", async () => {
	const f = authFixture();
	const quotaRequest = (platform: string, url: string, requestId: string) => ({ type: "owl:account-quota:open", platform, url, requestId });
	const url = "https://cursor.com/dashboard/spending";
	f.emit(quotaRequest("CURSOR", url, "other-frame"), {});
	f.emit(quotaRequest("CURSOR", url, "other-origin"), f.frame, "https://cursor.com");
	const denied = [
		["COPILOT", url], ["QODER", url], ["CLAUDE", url],
		["CURSOR", "https://cursor.com/dashboard"], ["CURSOR", "https://cursor.com/loginDeepControl"],
		["CURSOR", "https://evil.test/dashboard/spending"], ["CURSOR", "https://cursor.com.evil.test/dashboard/spending"],
		["CURSOR", "http://cursor.com/dashboard/spending"], ["CURSOR", "cursor://dashboard/spending"],
		["CURSOR", "https://cursor.com:444/dashboard/spending"], ["CURSOR", "https://user@cursor.com/dashboard/spending"],
		["CURSOR", "https://cursor.com/dashboard/spending?redirect=https://evil.test"], ["CURSOR", "https://cursor.com/dashboard/spending#redirect"],
	];
	for (const [index, [platform, target]] of denied.entries()) f.emit(quotaRequest(platform, target, `denied-${index}`));
	await setImmediate();
	assert.deepEqual(f.opened, []);
	assert.equal(f.replies.length, denied.length);
	for (const [index, reply] of f.replies.entries()) assert.deepEqual(reply.data, { type: "owl:account-quota:opened", requestId: `denied-${index}`, opened: false, error: "invalid_quota_url" });
	f.emit(quotaRequest("CURSOR", url, "quota-allowed"));
	await setImmediate();
	assert.deepEqual(f.opened, [url]);
	assert.deepEqual(f.replies.at(-1), { data: { type: "owl:account-quota:opened", requestId: "quota-allowed", opened: true }, origin: "http://127.0.0.1:8790" });
	f.dispose();
});
