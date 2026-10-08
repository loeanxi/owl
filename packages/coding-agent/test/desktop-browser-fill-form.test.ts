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
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><form id="request-form">
<label>申请人<input id="name" name="name" required></label><label>电子邮箱<input id="email" name="email" type="email" required></label>
<label>服务分类<select id="category" name="category" required><option value="">请选择</option><option value="calibration">设备校准</option><option value="inspection">设备巡检</option></select></label>
<label><input id="priority-high" name="priority" type="radio" value="high" required>高</label><label><input name="priority" type="radio" value="normal">普通</label>
<label>设备数量<input id="quantity" name="quantity" type="number" required min="1"></label><label>期望日期<input id="visit-date" name="visitDate" type="date" required></label>
<label>申请说明<textarea id="notes" name="notes" required></textarea></label><label><input id="consent" name="consent" type="checkbox" required>确认本地评测</label>
<button id="submit" type="submit">提交申请</button></form><p id="receipt" role="status"></p><script>
document.querySelector('#request-form').addEventListener('submit',async(event)=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.target));data.consent=document.querySelector('#consent').checked;data.quantity=Number(data.quantity);const receipt=await(await fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})).json();document.querySelector('#receipt').textContent='申请已提交 '+receipt.id;});
</script></body></html>`;
const resetHtml = html.replace(
	"</script>",
	"document.querySelector('#category').addEventListener('change',()=>{document.querySelector('#name').value='';});</script>",
);

const fields = [
	{ kind: "fill", selector: "#name", value: "李校准" },
	{ kind: "fill", selector: "#email", value: "owl-fixture@example.test" },
	{ kind: "select", selector: "#category", values: ["calibration"] },
	{ kind: "check", selector: "#priority-high", checked: true },
	{ kind: "fill", selector: "#quantity", value: "3" },
	{ kind: "fill", selector: "#visit-date", value: "2026-10-15" },
	{ kind: "fill", selector: "#notes", value: "传感器例行校准，仅用于本地评测" },
	{ kind: "check", selector: "#consent", checked: true },
];

describe.skipIf(!browserAvailable)("native bulk form filling", () => {
	let server: Server;
	let url: string;
	let hub: BrowserHub;
	const receipts: Record<string, unknown>[] = [];
	beforeAll(async () => {
		server = createServer(async (request, response) => {
			if (request.url === "/receipt") {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(chunk);
				receipts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
				response.writeHead(201, { "content-type": "application/json" }).end('{"id":"LOCAL-bulk-0001"}');
			} else
				response
					.writeHead(200, { "content-type": "text/html; charset=utf-8" })
					.end(request.url === "/reset" ? resetHtml : html);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	});
	beforeEach(async () => {
		receipts.length = 0;
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
		const definition = hub.tools("bulk-form-fixture").find((tool) => tool.name === name);
		if (!definition) throw new Error(`Missing tool ${name}`);
		return definition.execute("fixture-call", input, undefined, undefined, undefined!);
	}
	async function text(name: string, input: Record<string, unknown>) {
		const result = await invoke(name, input);
		return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	}

	it("fills eight real controls in one call, repeats selection idempotently, and submits a server-verified receipt", async () => {
		const snapshot = await text("browser_snapshot", {});
		const quantityRef = Number(
			snapshot
				.split("\n")
				.find((line) => line.includes("设备数量"))
				?.match(/ref=(\d+)/)?.[1],
		);
		const withRef = fields.map((field, index) =>
			index === 4 ? { kind: "fill", ref: quantityRef, value: "3" } : field,
		);
		const result = await invoke("browser_fill_form", { fields: withRef });
		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({ completedIndices: [0, 1, 2, 3, 4, 5, 6, 7], verified: true });
		await invoke("browser_fill_form", { fields: [fields[3], fields[7]] });
		await invoke("browser_click", { selector: "#submit" });
		await expect.poll(() => receipts.length).toBe(1);
		expect(receipts[0]).toEqual({
			name: "李校准",
			email: "owl-fixture@example.test",
			category: "calibration",
			priority: "high",
			quantity: 3,
			visitDate: "2026-10-15",
			notes: "传感器例行校准，仅用于本地评测",
			consent: true,
		});
		expect(await text("browser_snapshot", {})).toContain("申请已提交 LOCAL-bulk-0001");
	});

	it("validates all field targets and control types before changing any field", async () => {
		await expect(
			invoke("browser_fill_form", { fields: [fields[0], { kind: "fill", selector: "#missing", value: "bad" }] }),
		).rejects.toThrow(/1|未匹配/);
		await expect(
			invoke("browser_fill_form", { fields: [fields[0], { kind: "select", selector: "#email", values: ["bad"] }] }),
		).rejects.toThrow(/1|select/);
		const snapshot = await text("browser_snapshot", {});
		expect(snapshot).not.toContain('值="李校准"');
		await expect(
			invoke("browser_fill_form", { fields: [fields[0], { kind: "check", selector: "#consent", checked: "yes" }] }),
		).rejects.toThrow(/1|checked/);
	});

	it("reports completed indices if a later value is rejected instead of claiming the batch succeeded", async () => {
		const result = await invoke("browser_fill_form", {
			fields: [fields[0], { kind: "select", selector: "#category", values: ["missing-option"] }],
		});
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ completedIndices: [0], failedIndex: 1, verified: false });
		expect(await text("browser_snapshot", {})).toContain('值="李校准"');
	});

	it("reports a final mismatch if a later control resets a previously verified field", async () => {
		await invoke("browser_navigate", { url: `${url}reset` });
		const result = await invoke("browser_fill_form", { fields: [fields[0], fields[2]] });
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ verified: false, completedIndices: [0, 1], failedIndex: 0 });
		expect(await text("browser_snapshot", {})).not.toContain('值="李校准"');
	});
});
