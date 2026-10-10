/**
 * 动态壁纸桥端模块冒烟测试：不启动完整桥，直接把 handleWallpaperHttp 挂到
 * 一个临时 HTTP server 上，验证清单 / 媒体 Range / 网页壁纸 shim 注入。
 * 运行：npm test（packages/owl-wallpaper 下）
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWallpaperHttp } from "../src/wallpaper-http.ts";

const root = mkdtempSync(join(tmpdir(), "owl-wp-test-"));
const wsDir = join(root, "workshop");
const videoDir = join(wsDir, "video-wall");
const webDir = join(wsDir, "web-wall");
const sceneDir = join(wsDir, "scene-wall");
for (const dir of [videoDir, webDir, sceneDir]) mkdirSync(dir, { recursive: true });

writeFileSync(
	join(videoDir, "project.json"),
	JSON.stringify({ title: "测试视频", type: "video", file: "main.mp4", contentrating: "Everyone", general: { properties: { schemecolor: { value: "0.2 0.5 0.9" } } } }),
);
writeFileSync(join(videoDir, "main.mp4"), Buffer.alloc(2048, 7));
writeFileSync(join(videoDir, "preview.jpg"), Buffer.alloc(128, 1));

writeFileSync(
	join(webDir, "project.json"),
	JSON.stringify({ title: "测试网页", type: "web", file: "index.html", general: { properties: { brightness: { value: 0.5, editable: true }, hidden: { value: 9, editable: false } } } }),
);
writeFileSync(join(webDir, "index.html"), "<!doctype html><html><head><title>w</title><script src='app.js'></script></head><body></body></html>");
writeFileSync(join(webDir, "app.js"), "console.log(1)");

writeFileSync(join(sceneDir, "project.json"), JSON.stringify({ title: "测试场景", type: "scene", file: "scene.pkg" }));
writeFileSync(join(sceneDir, "preview.png"), Buffer.alloc(64, 2));

// 自定义路径（单个文件）
const customFile = join(root, "custom.mp4");
writeFileSync(customFile, Buffer.alloc(512, 3));

const started = await new Promise((resolve) => {
	const server = createServer((request, response) => {
		void handleWallpaperHttp(request, response, {
			getCustomDir: () => wsDir,
			getCustomPath: () => customFile,
			// 本机真装了 Wallpaper Engine：关掉 Steam 探测，保证测试封闭
			steamProbe: false,
		});
	});
	server.listen(0, "127.0.0.1", () => resolve(server));
});
const base = `http://127.0.0.1:${started.address().port}`;

async function get(path, headers = {}) {
	const response = await fetch(base + path, { headers });
	const buffer = Buffer.from(await response.arrayBuffer());
	return { status: response.status, headers: response.headers, buffer };
}

try {
	// 1. 清单：三类壁纸 + 自定义文件都在，token URL 结构正确
	const inv = await (await get("/wallpaper/inventory")).buffer;
	const data = JSON.parse(inv.toString());
	const byTitle = Object.fromEntries(data.wallpapers.map((w) => [w.title, w]));
	assert.equal(byTitle["测试视频"].type, "video");
	assert.match(byTitle["测试视频"].mediaUrl, /^\/wallpaper\/media\/[A-Za-z0-9_-]+$/);
	assert.match(byTitle["测试视频"].previewUrl, /^\/wallpaper\/media\//);
	assert.match(byTitle["测试视频"].schemeColor, /^rgb\(/);
	assert.equal(byTitle["测试网页"].type, "web");
	assert.match(byTitle["测试网页"].webUrl, /^\/wallpaper\/files\/[A-Za-z0-9_-]+\/index\.html$/);
	assert.equal(byTitle["测试场景"].type, "scene");
	assert.ok(byTitle["测试场景"].previewUrl, "scene 有预览图");
	assert.ok(data.wallpapers.some((w) => w.id === "custom" && w.mediaUrl), "customPath 已登记");
	console.log("1. inventory OK");

	// 2. 媒体：全量 200 + Range 206
	const media = await get(byTitle["测试视频"].mediaUrl);
	assert.equal(media.status, 200);
	assert.equal(media.buffer.length, 2048);
	assert.equal(media.headers.get("accept-ranges"), "bytes");
	const partial = await get(byTitle["测试视频"].mediaUrl, { Range: "bytes=100-199" });
	assert.equal(partial.status, 206);
	assert.equal(partial.buffer.length, 100);
	assert.equal(partial.headers.get("content-range"), `bytes 100-199/2048`);
	console.log("2. media + range OK");

	// 3. 网页壁纸：HTML 注入 seed + shim 引用；file 类属性不外泄
	const web = await get(byTitle["测试网页"].webUrl);
	assert.equal(web.status, 200);
	const html = web.buffer.toString();
	assert.ok(html.includes("/wallpaper-shim.js"), "shim 已注入");
	assert.ok(html.includes('"brightness"'), "seed 含可编辑属性");
	assert.ok(!html.includes('"hidden"'), "editable:false 属性已剔除");
	// 子文件：扩展名白名单内的 js 可取，越界路径拒绝
	const js = await get(byTitle["测试网页"].webUrl.replace("index.html", "app.js"));
	assert.equal(js.status, 200);
	const escape = await get(byTitle["测试网页"].webUrl.replace("index.html", "..%2F..%2F..%2Fsecret.txt"));
	assert.equal(escape.status, 403);
	console.log("3. web inject + sandbox OK");

	// 4. 未知 token 404（/api/other 等非壁纸路径 handler 返回 false 交还外层链，无法经 HTTP 断言）
	const missing = await get("/wallpaper/media/deadbeef");
	assert.equal(missing.status, 404);
	const staleFiles = await get("/wallpaper/files/deadbeef/index.html");
	assert.equal(staleFiles.status, 404);
	console.log("4. token isolation OK");

	// 5. refresh=1 强制重扫后 token 全部换新（旧 token 失效）
	const inv2 = await (await get("/wallpaper/inventory?refresh=1")).buffer;
	const data2 = JSON.parse(inv2.toString());
	const byTitle2 = Object.fromEntries(data2.wallpapers.map((w) => [w.title, w]));
	assert.notEqual(byTitle2["测试视频"].mediaUrl, byTitle["测试视频"].mediaUrl);
	const stale = await get(byTitle["测试视频"].mediaUrl);
	assert.equal(stale.status, 404, "旧 token 已失效");
	console.log("5. refresh rotation OK");

	console.log("\nALL WALLPAPER SMOKE TESTS PASSED");
} finally {
	started.close();
	rmSync(root, { recursive: true, force: true });
}
