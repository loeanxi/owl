import WebSocket from "ws";
import { existsSync, readFileSync } from "node:fs";

const PORT = process.env.PI_RE_PORT ?? 8791;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const pending = new Map();
const events = [];
let sawToolCall = false;

function send(msg) {
	return new Promise((resolve) => {
		pending.set(msg.id, resolve);
		ws.send(JSON.stringify(msg));
	});
}

ws.on("message", (data) => {
	const msg = JSON.parse(String(data));
	if (msg.type === "response" && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
		return;
	}
	if (msg.type === "event") {
		const e = msg.event;
		const label = e.type === "message_update" ? `message_update/${e.assistantMessageEvent?.type}` : e.type;
		if (label.startsWith("message_update/toolcall_start")) sawToolCall = true;
		events.push(label);
	}
});

ws.on("open", async () => {
	try {
		const pong = await send({ type: "ping", id: "ping1" });
		console.log("[1] ping:", JSON.stringify(pong.result));

		const created = await send({
			type: "session.create",
			id: "c1",
			cwd: "D:/pire/acceptance-ws",
			provider: "zai-coding-cn",
			model: "glm-5.3-flash",
		});
		if (!created.ok) throw new Error(`create failed: ${created.error}`);
		const sid = created.result.sessionId;
		console.log("[2] session created:", sid, "cwd:", created.result.cwd);

		await send({
			type: "session.prompt",
			id: "p1",
			sessionId: sid,
			message: "Create a file named pire-acceptance.txt in the current directory containing exactly one line: PIRE_OK",
		});
		console.log("[3] prompt accepted, waiting for completion...");

		// wait for the file to appear (tool execution through the bridge)
		const file = "D:/pire/acceptance-ws/pire-acceptance.txt";
		const deadline = Date.now() + 150000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 2000));
			if (existsSync(file)) break;
		}
		const content = existsSync(file) ? readFileSync(file, "utf-8").trim() : "<missing>";
		console.log("[4] file content:", JSON.stringify(content));

		const done = events.filter((e) => e.startsWith("message_end")).length;
		await new Promise((r) => setTimeout(r, 3000));
		console.log("[5] events seen:", events.length, "| toolCall events:", sawToolCall, "| message_end:", done);
		console.log("[6] VERDICT:", content === "PIRE_OK" && sawToolCall ? "PASS" : "FAIL");
		process.exit(content === "PIRE_OK" ? 0 : 1);
	} catch (error) {
		console.error("ACCEPTANCE ERROR:", error);
		process.exit(1);
	}
});

ws.on("error", (e) => {
	console.error("WS ERROR:", e.message);
	process.exit(1);
});
setTimeout(() => {
	console.error("CLIENT TIMEOUT. events:", events.slice(-20));
	process.exit(1);
}, 170000);
