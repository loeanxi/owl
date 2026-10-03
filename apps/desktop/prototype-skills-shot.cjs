// PROTOTYPE 截图脚本 — 把三个 variant 各截一张 PNG，用完即扔
const { chromium } = require("playwright-core");
const path = require("path");

(async () => {
	const browser = await chromium.launch({
		executablePath: process.env.LOCALAPPDATA + "\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe",
	});
	const page = await browser.newPage({ viewport: { width: 1280, height: 880 }, deviceScaleFactor: 2 });
	const file = "file:///" + path.resolve(__dirname, "prototype-skills-project.html").replace(/\\/g, "/");
	for (const v of ["A", "B", "C"]) {
		await page.goto(`${file}?variant=${v}`);
		await page.waitForTimeout(300);
		await page.screenshot({ path: path.resolve(__dirname, `prototype-skills-project-${v}.png`), fullPage: true });
		console.log("saved", v);
	}
	await browser.close();
})();
