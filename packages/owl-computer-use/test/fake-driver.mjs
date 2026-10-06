// 伪 computer-use driver：按 ComputerDriverSession 的 JSON 行协议应答。
// 用法：node fake-driver.mjs [normal|flaky]
//   normal — 一直活着；flaky — 处理完第一条命令后退出（测崩溃重建）。
import readline from "node:readline";

const mode = process.argv[2] === "flaky" ? "flaky" : "normal";

process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let handled = 0;

rl.on("line", (line) => {
	if (line.trim() === "") return;
	const req = JSON.parse(line);
	let response;
	if (req.cmd === "cursor") {
		response = { id: req.id, ok: true, data: { x: 111, y: 222 } };
	} else if (req.cmd === "screenshot") {
		// 模拟 1568x784 的屏幕缩到一半。
		response = {
			id: req.id,
			ok: true,
			data: {
				imageWidth: 784,
				imageHeight: 392,
				screenWidth: 1568,
				screenHeight: 784,
				originX: 0,
				originY: 0,
				jpeg: "ZmFrZQ==",
			},
		};
	} else if (req.cmd === "click") {
		response = { id: req.id, ok: true, data: { clicked: true, x: req.x, y: req.y } };
	} else if (req.cmd === "scroll") {
		response = { id: req.id, ok: true, data: { scrolled: true } };
	} else if (req.cmd === "type") {
		response = { id: req.id, ok: true, data: { typed: true } };
	} else if (req.cmd === "key") {
		const blocked = (req.down ?? []).includes(0x5b) && (req.tap ?? []).includes(0x4c);
		response = blocked
			? { id: req.id, ok: false, error: "Blocked key combo: win+l (system-level lock keys are not injectable)." }
			: { id: req.id, ok: true, data: { sent: true } };
	} else if (req.cmd === "windows") {
		response = { id: req.id, ok: true, data: { windows: [] } };
	} else if (req.cmd === "focus" || req.cmd === "restore") {
		response = { id: req.id, ok: true, data: { [req.cmd]: true } };
	} else {
		response = { id: req.id, ok: false, error: `unknown cmd: ${req.cmd}` };
	}
	process.stdout.write(`${JSON.stringify(response)}\n`);
	handled += 1;
	if (mode === "flaky" && handled >= 1) process.exit(0);
});
