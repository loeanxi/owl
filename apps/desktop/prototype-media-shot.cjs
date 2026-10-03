// PROTOTYPE 截图脚本 — 媒体桥四屏各截一张 PNG（复用 prototype-skills-shot.cjs 的管线）
const { chromium } = require("playwright-core");
const path = require("path");

(async () => {
	const browser = await chromium.launch({
		executablePath: process.env.LOCALAPPDATA + "\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe",
	});
	const page = await browser.newPage({ viewport: { width: 1280, height: 880 }, deviceScaleFactor: 2 });
	const file = "file:///" + path.resolve(__dirname, "prototype-media-bridge.html").replace(/\\/g, "/");
	const screens = ["home", "memory", "chat", "onboarding"];
	for (const s of screens) {
		await page.goto(`${file}?screen=${s}`);
		// 藏掉原型导航条，只看应用本身
		await page.addStyleTag({ content: ".prototype-nav{display:none}" });
		await page.waitForTimeout(400);
		await page.screenshot({ path: path.resolve(__dirname, `prototype-media-bridge-${s}.png`) });
		console.log("saved", s);
	}
	await browser.close();
})();
