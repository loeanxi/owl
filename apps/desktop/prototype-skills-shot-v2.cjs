// PROTOTYPE v2 截图 — 分组 tab / 编辑弹窗 / 项目 tab，用完即扔
const { chromium } = require("playwright-core");
const path = require("path");

(async () => {
	const browser = await chromium.launch({
		executablePath: process.env.LOCALAPPDATA + "\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe",
	});
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
	const file = "file:///" + path.resolve(__dirname, "prototype-skills-groups-v2.html").replace(/\\/g, "/");
	const shots = [
		["?view=groups", "prototype-skills-groups-v2-groups.png"],
		["?view=groups&modal=写作组", "prototype-skills-groups-v2-modal.png"],
		["?view=project", "prototype-skills-groups-v2-project.png"],
	];
	for (const [query, out] of shots) {
		await page.goto(file + query);
		await page.waitForTimeout(300);
		await page.screenshot({ path: path.resolve(__dirname, out), fullPage: true });
		console.log("saved", out);
	}
	await browser.close();
})();
