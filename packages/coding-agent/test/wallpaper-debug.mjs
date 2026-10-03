import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWallpaperHttp } from "../src/modes/desktop/wallpaper-http.ts";

const root = mkdtempSync(join(tmpdir(), "owl-wp-d4-"));
const wsDir = join(root, "workshop");
const videoDir = join(wsDir, "video-wall");
mkdirSync(videoDir, { recursive: true });
writeFileSync(join(videoDir, "project.json"), JSON.stringify({ title: "测试视频", type: "video", file: "main.mp4", contentrating: "Everyone", general: { properties: { schemecolor: { value: "0.2 0.5 0.9" } } } }));
writeFileSync(join(videoDir, "main.mp4"), Buffer.alloc(2048, 7));
writeFileSync(join(videoDir, "preview.jpg"), Buffer.alloc(128, 1));

const server = createServer((request, response) => {
	void handleWallpaperHttp(request, response, {
		getCustomDir: () => wsDir,
		getCustomPath: () => "",
		steamProbe: false,
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const response = await fetch(`http://127.0.0.1:${server.address().port}/wallpaper/inventory`);
console.log("status", response.status);
console.log(Buffer.from(await response.arrayBuffer()).toString());
server.close();
rmSync(root, { recursive: true, force: true });
process.exit(0);
