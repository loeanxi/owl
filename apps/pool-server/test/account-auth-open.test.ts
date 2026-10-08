import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Listener = (event: Record<string, unknown>) => unknown;
const fixtureUrl =
	"https://cursor.com/loginDeepControl?challenge=fixture-only&uuid=fixture-only&mode=login&redirectTarget=sdk";

function page(embedded = true, referrer = "http://127.0.0.1:18901/", opened = true) {
	const nodes = new Map<string, ReturnType<typeof element>>();
	function element() {
		return {
			listeners: new Map<string, Listener>(),
			href: "",
			value: "",
			textContent: "",
			hidden: false,
			disabled: false,
			open: false,
			classList: { toggle: () => false, add: () => {}, remove: () => {} },
			addEventListener(type: string, listener: Listener) {
				this.listeners.set(type, listener);
			},
			showModal() {
				this.open = true;
			},
		};
	}
	const node = (selector: string) => {
		let value = nodes.get(selector);
		if (!value) {
			value = element();
			nodes.set(selector, value);
		}
		return value;
	};
	const messages = new Set<Listener>();
	const posted: Array<{ data: Record<string, unknown>; origin: string }> = [];
	const timers = new Map<number, { callback: () => void; delay: number }>();
	let timerId = 0;
	const parent = {
		postMessage(data: Record<string, unknown>, origin: string) {
			posted.push({ data, origin });
			queueMicrotask(() => {
				for (const listener of messages)
					listener({
						origin,
						source: parent,
						data: { type: "owl:account-auth:opened", requestId: data.requestId, opened },
					});
			});
		},
	};
	const browser: Record<string, unknown> = {
		parent,
		addEventListener: (_type: string, listener: Listener) => messages.add(listener),
		removeEventListener: (_type: string, listener: Listener) => messages.delete(listener),
	};
	if (!embedded) browser.parent = browser;
	const context = createContext({
		$: node,
		t: (key: string) => key,
		window: browser,
		URL,
		setInterval: () => 0,
		clearInterval: () => {},
		document: { referrer, querySelectorAll: () => [], addEventListener: () => {} },
		crypto: { randomUUID: () => "auth-fixture-request" },
		setTimeout: (callback: () => void, delay: number) => {
			const id = ++timerId;
			timers.set(id, { callback, delay });
			return id;
		},
		clearTimeout: (id: number) => timers.delete(id),
	});
	runInContext(readFileSync(new URL("../public/pool-admin.js", import.meta.url), "utf8"), context);
	runInContext(
		'bindPoolUI(); poolState.loginAccount = {id:"fixture-account",name:"Fixture",platform:"CURSOR"};',
		context,
	);
	node("#pool-auth-link").href = fixtureUrl;
	return {
		posted,
		timers,
		node,
		context,
		click: async () => {
			let prevented = false;
			await node("#pool-auth-link").listeners.get("click")?.({
				currentTarget: node("#pool-auth-link"),
				target: node("#pool-auth-link"),
				button: 0,
				isTrusted: true,
				preventDefault: () => {
					prevented = true;
				},
			});
			return prevented;
		},
	};
}

describe("account authorization link click", () => {
	it("forwards the actual embedded auth-link click to Owl instead of relying on a blocked popup", async () => {
		const current = page();
		expect(await current.click()).toBe(true);
		expect(current.posted).toEqual([
			{
				data: {
					type: "owl:account-auth:open",
					requestId: "auth-fixture-request",
					platform: "CURSOR",
					url: fixtureUrl,
				},
				origin: "http://127.0.0.1:18901",
			},
		]);
		expect(current.node("#pool-auth-open-status").textContent).toBe("pool.authBrowserOpened");
		expect(current.timers.size).toBe(0);
	});
	it("keeps normal target-blank navigation in a standalone browser", async () => {
		const current = page(false);
		expect(await current.click()).toBe(false);
		expect(current.posted).toHaveLength(0);
	});
	it("shows an actionable error if the host cannot launch the browser", async () => {
		const current = page(true, undefined, false);
		await current.click();
		expect(current.node("#pool-auth-open-status").textContent).toBe("pool.authBrowserFailed");
	});
	it("does not send the authorization challenge to an untrusted embedding origin", async () => {
		const current = page(true, "https://untrusted.example/");
		await current.click();
		expect(current.posted).toHaveLength(0);
		expect(current.node("#pool-auth-open-status").textContent).toBe("pool.authBrowserFailed");
	});
	it("resumes an existing pending authorization after a UI reload without starting a second login", async () => {
		const current = page();
		const requests: string[] = [];
		current.context.api = async (path: string) => {
			requests.push(path);
			return { login: { status: "PENDING", url: fixtureUrl } };
		};
		await runInContext('startAccountAuth({id:"fixture-account",name:"Fixture",platform:"CURSOR"})', current.context);
		expect(requests).toEqual(["/api/accounts/fixture-account/auth/status"]);
		expect(current.node("#pool-auth-link").href).toBe(fixtureUrl);
	});
	it("refreshes Cursor quota after SDK authorization without treating a missing web session as SDK expiry", async () => {
		const current = page();
		const calls: string[] = [];
		current.context.refreshOneCredit = async () => {
			calls.push("quota");
			return { creditsStatus: "UNAVAILABLE", credentialStatus: "OK" };
		};
		current.context.loadAccounts = async () => {
			calls.push("accounts");
		};
		await runInContext("finishAccountAuth()", current.context);
		expect(calls).toEqual(["quota", "accounts"]);
	});
});
