import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BrowserHub } from "../src/modes/desktop/browser-hub.ts";

const browserAvailable = [
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"/usr/bin/chromium",
].some(existsSync);

// Same native controls and associated labels as the real, local agent-eval form.
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>
<label>设备数量<input id="quantity" type="number" required></label>
<label>期望日期<input id="visit-date" type="date" required></label>
<label>申请说明<textarea id="notes"></textarea></label>
</body></html>`;

describe.skipIf(!browserAvailable)("browser tools on typed form inputs", () => {
	let server: Server;
	let url: string;
	let hub: BrowserHub;
	beforeAll(async () => {
		server = createServer((_request, response) =>
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html),
		);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	});
	beforeEach(async () => {
		hub = new BrowserHub({
			onPagesChanged: () => {},
			onFrame: () => {},
			onFileChooser: () => {},
			onDiagnostic: () => {},
		});
		await invoke("browser_navigate", { url });
	});
	afterEach(async () => {
		await hub.dispose();
	});
	afterAll(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	async function invoke(name: string, input: Record<string, unknown>) {
		const definition = hub.tools("typed-input-fixture").find((tool) => tool.name === name);
		if (!definition) throw new Error(`Missing tool ${name}`);
		return definition.execute("fixture-call", input, undefined, undefined, undefined!);
	}
	async function snapshot() {
		const result = await invoke("browser_snapshot", {});
		return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	}

	it("shows associated labels and native input types so dates are not unnamed textboxes", async () => {
		const text = await snapshot();
		expect(text).toMatch(/设备数量.*type=number/);
		expect(text).toMatch(/期望日期.*type=date/);
		expect(text).toContain("申请说明");
	});

	it("replays the real browser_type call on an empty date field and verifies the full ISO value", async () => {
		const text = await snapshot();
		const line = text.split("\n").filter((line) => /textbox/.test(line))[1];
		const ref = Number(line.match(/ref=(\d+)/)?.[1]);
		expect(Number.isInteger(ref)).toBe(true);
		const result = await invoke("browser_type", { ref, text: "2026-10-15" });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"verified": true') });
		expect(await snapshot()).toContain('值="2026-10-15"');
	});

	it("preserves ordinary numeric input and explicit date replacement", async () => {
		await invoke("browser_type", { selector: "#quantity", text: "3" });
		await invoke("browser_fill", { selector: "#visit-date", text: "2026-10-15" });
		await invoke("browser_type", { selector: "#visit-date", text: "2026-10-16", clear: true });
		expect(await snapshot()).toContain('值="2026-10-16"');
		expect(await snapshot()).toContain('值="3"');
	});

	it("rejects date append and invalid date syntax before changing the current field", async () => {
		await invoke("browser_fill", { selector: "#visit-date", text: "2026-10-15" });
		await expect(invoke("browser_type", { selector: "#visit-date", text: "2026-10-16" })).rejects.toThrow(
			"clear=true",
		);
		await expect(invoke("browser_fill", { selector: "#visit-date", text: "2026/10/16" })).rejects.toThrow(
			"YYYY-MM-DD",
		);
		expect(await snapshot()).toContain('值="2026-10-15"');
	});
});
