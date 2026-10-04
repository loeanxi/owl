import type { LookupFunction } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNewsText } from "../../src/core/news/sources.ts";

const transport = vi.hoisted(() => ({
	fetch: vi.fn<typeof fetch>(),
	lookup: vi.fn(),
	pinnedLookups: [] as LookupFunction[],
}));
vi.mock("node:dns/promises", () => ({ lookup: transport.lookup }));
vi.mock("undici", () => ({
	fetch: transport.fetch,
	Agent: class {
		constructor(options: { connect: { lookup: LookupFunction } }) {
			transport.pinnedLookups.push(options.connect.lookup);
		}
		async close(): Promise<void> {}
	},
}));

beforeEach(() => {
	transport.fetch.mockReset();
	transport.lookup.mockReset();
	transport.pinnedLookups.length = 0;
	transport.fetch.mockResolvedValue(new Response("<rss><channel/></rss>"));
});

describe("news Fake-IP DNS boundary", () => {
	it("re-resolves synthetic answers independently and pins only the validated real public addresses", async () => {
		const resolveHost = vi.fn(async () => ["198.18.0.106", "8.8.8.8"]);
		const resolvePublicHost = vi.fn(async (_host: string, _signal: AbortSignal) => [
			"104.18.33.45",
			"2606:4700:4700::1111",
		]);
		const result = await fetchNewsText("https://openai.com/news/rss.xml", {}, { resolveHost, resolvePublicHost });
		expect(result.status).toBe(200);
		expect(resolvePublicHost).toHaveBeenCalledOnce();
		expect(resolvePublicHost.mock.calls[0]?.[0]).toBe("openai.com");
		expect(transport.pinnedLookups).toHaveLength(1);
		transport.pinnedLookups[0]!("openai.com", { all: true }, (error, addresses) => {
			expect(error).toBeNull();
			expect(addresses).toEqual([
				{ address: "104.18.33.45", family: 4 },
				{ address: "2606:4700:4700::1111", family: 6 },
			]);
		});
		expect(resolveHost).toHaveBeenCalledOnce();
	});

	it("does not silently use external DNS when a custom resolver has no explicit fallback", async () => {
		await expect(
			fetchNewsText("https://example.com", {}, { resolveHost: async () => ["198.18.0.106"] }),
		).rejects.toThrow("内网");
		expect(transport.fetch).not.toHaveBeenCalled();
	});

	it("does not silently use external DNS when only a custom fetch is injected", async () => {
		transport.lookup.mockResolvedValue([{ address: "198.18.0.106", family: 4 }]);
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("<rss/>"));
		await expect(fetchNewsText("https://example.com", {}, { fetch })).rejects.toThrow("内网");
		expect(fetch).not.toHaveBeenCalled();
		expect(transport.fetch).not.toHaveBeenCalled();
	});

	it("does not invoke the fallback for ordinary public DNS answers", async () => {
		const resolvePublicHost = vi.fn(async () => ["8.8.8.8"]);
		await fetchNewsText("https://example.com", {}, { resolveHost: async () => ["8.8.4.4"], resolvePublicHost });
		expect(resolvePublicHost).not.toHaveBeenCalled();
	});

	it.each(["127.0.0.1", "10.0.0.1", "192.168.1.1", "::1", "fd00::1", "::ffff:10.0.0.1"])(
		"rejects a mixed synthetic/private DNS reply before any fallback or transport: %s",
		async (privateAddress) => {
			const resolvePublicHost = vi.fn(async () => ["8.8.8.8"]);
			await expect(
				fetchNewsText(
					"https://example.com",
					{},
					{
						resolveHost: async () => ["198.18.0.106", privateAddress],
						resolvePublicHost,
					},
				),
			).rejects.toThrow("内网");
			expect(resolvePublicHost).not.toHaveBeenCalled();
			expect(transport.fetch).not.toHaveBeenCalled();
		},
	);

	it.each(["198.18.0.106", "198.19.255.255", "127.0.0.1", "localhost"])(
		"never reinterprets a literal private target as a public hostname: %s",
		async (host) => {
			const resolvePublicHost = vi.fn(async () => ["8.8.8.8"]);
			await expect(fetchNewsText(`https://${host}/`, {}, { resolvePublicHost })).rejects.toThrow("内网");
			expect(resolvePublicHost).not.toHaveBeenCalled();
			expect(transport.fetch).not.toHaveBeenCalled();
		},
	);

	it.each(
		[[], ["198.18.0.1"], ["8.8.8.8", "10.0.0.1"], ["2606:4700::1111", "fd00::1"], ["not-an-ip"]].map((addresses) => ({
			addresses,
		})),
	)("validates every independent DNS result before creating a dispatcher: $addresses", async ({ addresses }) => {
		const resolvePublicHost = vi.fn(async () => addresses);
		await expect(
			fetchNewsText(
				"https://example.com",
				{},
				{
					resolveHost: async () => ["198.18.0.106"],
					resolvePublicHost,
				},
			),
		).rejects.toThrow();
		expect(resolvePublicHost).toHaveBeenCalledOnce();
		expect(transport.pinnedLookups).toHaveLength(0);
		expect(transport.fetch).not.toHaveBeenCalled();
	});

	it("revalidates a redirect and stops before contacting an internal target", async () => {
		const resolvePublicHost = vi.fn(async () => ["8.8.8.8"]);
		transport.fetch.mockResolvedValue(
			new Response("", { status: 302, headers: { location: "http://10.0.0.1/secret" } }),
		);
		await expect(
			fetchNewsText(
				"https://example.com",
				{},
				{
					resolveHost: async () => ["198.18.0.106"],
					resolvePublicHost,
				},
			),
		).rejects.toThrow("内网");
		expect(transport.fetch).toHaveBeenCalledOnce();
	});

	it("bounds a hung independent resolver with the original request timeout", async () => {
		const resolvePublicHost = vi.fn(() => new Promise<string[]>(() => undefined));
		await expect(
			fetchNewsText(
				"https://example.com",
				{},
				{
					resolveHost: async () => ["198.18.0.106"],
					resolvePublicHost,
					timeoutMs: 20,
				},
			),
		).rejects.toThrow("超时");
		expect(resolvePublicHost).toHaveBeenCalledOnce();
		expect(transport.fetch).not.toHaveBeenCalled();
	});
});

function dnsAnswer(type: number, patch: Record<string, unknown> = {}): Response {
	return new Response(
		JSON.stringify({
			Status: 0,
			Question: [{ name: "example.com.", type }],
			Answer: type === 1 ? [{ type: 1, data: "8.8.8.8" }] : [],
			...patch,
		}),
	);
}

function defaultDnsTransport(reply: (type: number) => Response) {
	transport.lookup.mockResolvedValue([{ address: "198.18.0.106", family: 4 }]);
	transport.fetch.mockImplementation(async (input) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		return url.hostname === "1.1.1.1" ? reply(Number(url.searchParams.get("type"))) : new Response("<rss/>");
	});
}

describe("news independent public DNS transport", () => {
	it("uses a fixed HTTPS IP endpoint for A and AAAA without source credentials, then pins the real result", async () => {
		defaultDnsTransport((type) => dnsAnswer(type));
		await fetchNewsText("https://example.com/private/path?apikey=source-secret", {
			headers: { authorization: "Bearer source-secret", cookie: "session=source-secret" },
		});
		const calls = transport.fetch.mock.calls.filter(([input]) => String(input).startsWith("https://1.1.1.1/"));
		expect(calls).toHaveLength(2);
		for (const [input, init] of calls) {
			const url = new URL(String(input));
			expect(url.pathname).toBe("/dns-query");
			expect([...url.searchParams.keys()].sort()).toEqual(["name", "type"]);
			expect(url.searchParams.get("name")).toBe("example.com");
			expect(init).toMatchObject({ headers: { accept: "application/dns-json" }, redirect: "error" });
			expect(JSON.stringify({ input, init })).not.toContain("source-secret");
		}
		expect(transport.pinnedLookups).toHaveLength(1);
		transport.pinnedLookups[0]!("example.com", { all: true }, (_error, addresses) => {
			expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
		});
	});

	it.each([
		{ label: "nonzero status", patch: { Status: 3 } },
		{ label: "coerced status", patch: { Status: "0" } },
		{ label: "different question", patch: { Question: [{ name: "attacker.example.", type: 1 }] } },
		{ label: "missing question", patch: { Question: undefined } },
		{ label: "invalid A address", patch: { Answer: [{ type: 1, data: "not-an-IP" }] } },
		{ label: "different answer family", patch: { Answer: [{ type: 28, data: "2606:4700::1111" }] } },
		{ label: "invalid answer shape", patch: { Answer: "8.8.8.8" } },
		{ label: "no answers", patch: { Answer: [] } },
	])("rejects malformed or unrelated DoH replies before source transport: $label", async ({ patch }) => {
		defaultDnsTransport((type) => (type === 1 ? dnsAnswer(type, patch) : dnsAnswer(type)));
		await expect(fetchNewsText("https://example.com")).rejects.toThrow("真实公网地址");
		expect(transport.pinnedLookups).toHaveLength(0);
		expect(transport.fetch.mock.calls.every(([input]) => String(input).startsWith("https://1.1.1.1/"))).toBe(true);
	});

	it("rejects a valid AAAA reply containing a private address even when the A answer is public", async () => {
		defaultDnsTransport((type) =>
			type === 28 ? dnsAnswer(type, { Answer: [{ type: 28, data: "fd00::1" }] }) : dnsAnswer(type),
		);
		await expect(fetchNewsText("https://example.com")).rejects.toThrow("内网");
		expect(transport.pinnedLookups).toHaveLength(0);
	});

	it("allows CNAME metadata only alongside validated actual address records", async () => {
		defaultDnsTransport((type) =>
			type === 1
				? dnsAnswer(type, {
						Answer: [
							{ type: 5, data: "cdn.example.com." },
							{ type: 1, data: "8.8.8.8" },
						],
					})
				: dnsAnswer(type),
		);
		expect((await fetchNewsText("https://example.com")).status).toBe(200);
	});

	it.each([
		{
			label: "declared oversized reply",
			response: () => new Response("{}", { headers: { "content-length": String(17 * 1024) } }),
		},
		{ label: "streamed oversized reply", response: () => new Response(" ".repeat(17 * 1024)) },
		{
			label: "redirect",
			response: () => new Response("", { status: 302, headers: { location: "http://127.0.0.1/" } }),
		},
		{ label: "invalid JSON", response: () => new Response("not-json") },
	])("bounds and rejects provider transport errors without following them: $label", async ({ response }) => {
		defaultDnsTransport(() => response());
		await expect(fetchNewsText("https://example.com")).rejects.toThrow("真实公网地址");
		expect(transport.pinnedLookups).toHaveLength(0);
		expect(transport.fetch.mock.calls.every(([input]) => String(input).startsWith("https://1.1.1.1/"))).toBe(true);
	});

	it("shares the original source deadline with both DoH requests", async () => {
		transport.lookup.mockResolvedValue([{ address: "198.18.0.106", family: 4 }]);
		transport.fetch.mockImplementation(
			async (_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		await expect(fetchNewsText("https://example.com", {}, { timeoutMs: 20 })).rejects.toThrow("超时");
		expect(transport.fetch).toHaveBeenCalledTimes(2);
		expect(transport.pinnedLookups).toHaveLength(0);
	});
});
