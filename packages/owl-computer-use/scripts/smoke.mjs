// owl-computer-use 真实驱动 smoke：不经 agent，直连 computer-driver.ps1。
//
// 步骤：cursor → windows → 截屏存盘 → 启动记事本 → 聚焦 → 点进文本区 →
// 输入中英文 → 回车 → 再截屏存盘。产物在 %TEMP%\owl-cu-smoke\，人工目检
// 两张 jpg 与记事本内容即算通过。用法：node scripts/smoke.mjs [--keep-app]
// @module owl-computer-use/scripts/smoke
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ComputerDriverSession } from "../src/driver/session.ts";

const outDir = join(tmpdir(), "owl-cu-smoke");
await mkdir(outDir, { recursive: true });

const session = new ComputerDriverSession(undefined, { readyTimeoutMs: 180_000 });

function step(name) {
	process.stdout.write(`\n== ${name} ==\n`);
}
function show(name, value) {
	const text = value === undefined ? "undefined" : JSON.stringify(value);
	process.stdout.write(`${name}: ${text.length > 300 ? text.slice(0, 300) + ` …(+${text.length - 300}B)` : text}\n`);
}
async function saveShot(shot, name) {
	const path = join(outDir, name);
	await writeFile(path, Buffer.from(shot.jpeg, "base64"));
	process.stdout.write(`screenshot -> ${path} (${shot.imageWidth}x${shot.imageHeight}, screen ${shot.screenWidth}x${shot.screenHeight}@${shot.originX},${shot.originY})\n`);
	return path;
}

try {
	step("1. cursor（GetCursorPos 经 SendInput 内核）");
	show("cursor", await session.cursor());

	step("2. windows（枚举可见顶层窗口）");
	const windows = await session.windows();
	show("count", windows.length);
	show("top5", windows.slice(0, 5).map((w) => ({ title: w.title, process: w.process, fg: w.foreground })));

	step("3. screenshot（主显示器，冷启动含 csc 编译）");
	const before = await session.screenshot(-1, 1568, 80);
	await saveShot(before, "before.jpg");

	step("4. 启动记事本（只认新开的无标题窗口，绝不碰用户已打开的文档窗口）");
	const known = new Set((await session.windows()).map((w) => w.hwnd));
	const notepad = spawn("cmd.exe", ["/c", "start", "notepad"], { windowsHide: true, stdio: "ignore" });
	notepad.unref();
	await new Promise((resolve) => setTimeout(resolve, 2500));

	const listed = await session.windows();
	const fresh = listed.filter((w) => !known.has(w.hwnd));
	const target =
		fresh.find((w) => /^(?:\*)?\s*(无标题|Untitled)/i.test(w.title) && /notepad|记事本/i.test(w.process + w.title)) ??
		fresh.find((w) => /notepad|记事本/i.test(w.process));
	if (target === undefined) {
		throw new Error(
			"new untitled notepad window not found; refusing to touch pre-existing windows. new windows: " +
				JSON.stringify(fresh.map((w) => ({ title: w.title, process: w.process }))),
		);
	}
	show("target", { hwnd: target.hwnd, title: target.title, process: target.process, minimized: target.minimized });

	step("5. focus + restore");
	if (target.minimized) show("restored", await session.restore(target.hwnd));
	show("focused", await session.focus(target.hwnd));
	await new Promise((resolve) => setTimeout(resolve, 500));

	step("6. 点击记事本文本区（expectHwnd 预检：点偏时拒绝注入，绝不误触别的窗口）");
	async function clickIntoTarget() {
		const mid = await session.screenshot(-1, 1568, 80);
		await saveShot(mid, "focused.jpg");
		const meta = session.screenshotMeta;
		const scaleX = meta.imageWidth / meta.screenWidth;
		const scaleY = meta.imageHeight / meta.screenHeight;
		const imageX = Math.round((target.x + target.w / 2 - meta.originX) * scaleX);
		const imageY = Math.round((target.y + Math.min(target.h * 0.6, target.h - 80) - meta.originY) * scaleY);
		show("clickAt(image space)", { imageX, imageY });
		const result = await session.click(imageX, imageY, "left", false, undefined, target.hwnd);
		show("click", result);
		return result;
	}
	let clickResult = await clickIntoTarget();
	if (clickResult.blocked === true) {
		process.stdout.write(`!! 预检拦截：目标点上是 ${clickResult.window?.title ?? "none"}，重新聚焦再点\n`);
		show("focused", await session.focus(target.hwnd));
		await new Promise((resolve) => setTimeout(resolve, 400));
		clickResult = await clickIntoTarget();
	}
	if (clickResult.blocked === true || clickResult.window?.hwnd !== target.hwnd) {
		throw new Error(`click keeps landing on another window: ${JSON.stringify(clickResult.window)}`);
	}
	await new Promise((resolve) => setTimeout(resolve, 300));

	step("7. type 中英文 + 回车（expectHwnd 预检：前台不对就不打字）");
	const typeResult = await session.type("hello from owl computer-use", undefined, target.hwnd);
	if (typeResult.blocked === true || typeResult.foreground?.hwnd !== target.hwnd) {
		throw new Error(`foreground guard blocked typing: ${JSON.stringify(typeResult.foreground)}`);
	}
	show("type-en", typeResult);
	show("key-enter", await session.key([], [13], undefined, target.hwnd));
	show("type-zh", await session.type("第二行：中文输入测试 ✓", undefined, target.hwnd));
	await new Promise((resolve) => setTimeout(resolve, 300));

	step("8. 截屏确认");
	const after = await session.screenshot(-1, 1568, 80);
	await saveShot(after, "after.jpg");

	step("done");
	process.stdout.write(`\nPASS：全部命令走通。检查 ${outDir}\\after.jpg 与记事本内容（两行文本、换行、中文与 emoji 是否正确）。\n`);
	process.stdout.write(`（记事本 hwnd=${target.hwnd}「${target.title}」保持打开，请自行关闭；脚本从不强杀任何进程。）\n`);
} catch (error) {
	console.error(`\nFAIL：${error instanceof Error ? error.stack : String(error)}`);
	process.exitCode = 1;
} finally {
	session.close();
}
