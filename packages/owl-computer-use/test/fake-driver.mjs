// 伪 worker：真 IPC；慢响应、崩溃、缺 ready、无界输出用于生命周期回归。
import readline from "node:readline";

const mode = process.argv[2] ?? "normal";
const readyDelay = mode === "delayed-ready" ? 150 : 0;
const rl = readline.createInterface({ input: process.stdin, terminal: false });
let handled = 0;
let busy = false;
let observation = 0;
let screenshotCount = 0;

if (mode === "flood") process.stdout.write("x".repeat(4096));
else if (mode !== "no-ready") setTimeout(() => process.stdout.write(JSON.stringify({ event: "ready" }) + "\n"), readyDelay);

const screenshot = (originX = 0, originY = 0) => ({
	imageWidth: 784, imageHeight: 392, screenWidth: 1568, screenHeight: 784,
	originX, originY, jpeg: "ZmFrZQ==",
});

rl.on("line", (line) => {
	if (line.trim() === "") return;
	const req = JSON.parse(line);
	process.stderr.write("request:" + JSON.stringify(req) + "\n");
	if (req.text === "hang") return;
	if (mode === "serial-check" && busy) {
		process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: "concurrent request" }) + "\n");
		return;
	}
	busy = true;
	let response;
	if (req.cmd === "cursor") response = { id: req.id, ok: true, data: { x: 111, y: 222 } };
	else if (req.cmd === "screenshot") {
		screenshotCount++;
		const data = screenshot(req.monitor === -2 ? -1568 : 0, req.monitor === -2 ? -784 : 0);
		if (mode === "bad-screenshot" && screenshotCount > 1) data.imageWidth = 0;
		response = { id: req.id, ok: true, data };
	} else if (req.cmd === "observe") {
		observation++;
		const data = {
			observationId: "obs_" + observation, target: null, elements: [],
			capabilities: { uia: true, windowCapture: true, input: true },
		};
		if (req.includeImage) data.screenshot = screenshot();
		response = { id: req.id, ok: true, data };
	} else if (req.cmd === "act") response = { id: req.id, ok: true, data: { status: "issued" } };
	else if (req.cmd === "release") response = { id: req.id, ok: true, data: { released: true } };
	else if (req.cmd === "click") response = { id: req.id, ok: true, data: { clicked: true, x: req.x, y: req.y } };
	else if (req.cmd === "scroll") response = { id: req.id, ok: true, data: { scrolled: true } };
	else if (req.cmd === "type") response = { id: req.id, ok: true, data: { typed: true } };
	else if (req.cmd === "key") {
		const blocked = (req.down ?? []).includes(0x5b) && (req.tap ?? []).includes(0x4c);
		response = blocked
			? { id: req.id, ok: false, error: "Blocked key combo: win+l" }
			: { id: req.id, ok: true, data: { sent: true } };
	} else if (req.cmd === "windows") response = { id: req.id, ok: true, data: { windows: [] } };
	else if (req.cmd === "focus" || req.cmd === "restore")
		response = { id: req.id, ok: true, data: { [req.cmd === "focus" ? "focused" : "restored"]: true } };
	else response = { id: req.id, ok: false, error: "unknown cmd: " + req.cmd };

	const delay = mode === "serial-check" || req.text === "slow" ? 100 : 0;
	setTimeout(() => {
		busy = false;
		process.stdout.write(JSON.stringify(response) + "\n");
		handled++;
		if (mode === "flaky" && handled >= 1) process.exit(0);
	}, delay);
});
