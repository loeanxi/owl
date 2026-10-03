/**
 * 动态壁纸（Wallpaper Engine 适配）桥端 HTTP 服务。
 *
 * 能力移植自 dsh-wallpaper-engine（MIT，github.com/elysia395/dsh-wallpaper-engine）
 * 的宿主半边，裁剪出 OWL 需要的子集：工程发现 / 枚举 / 媒体文件服务（Range）/
 * 网页壁纸的 shim 注入。Scene 类不做实时渲染（那需要整个 WebWallGL），客户端用
 * 预览图降级；Application 类需要运行第三方可执行程序，一律排除。
 *
 * 安全模型（与上游一致的 token 白名单思路）：
 * - 媒体/预览按「枚举时登记的 token → 绝对路径」白名单出文件，客户端拿不到
 *   任意路径的构造能力（token 是不可猜测的随机串，不是 base64 路径）。
 * - 网页壁纸目录文件按「目录 token + 相对子路径」出文件：resolve 后必须仍在
 *   目录内（防 `..` 逃逸），扩展名走 MIME 白名单，HTML 注入 shim。
 * - 全部路由仅接受本地桌面来源（authorizeOrigin 由 serve.ts 注入）。
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, type Dirent, existsSync, readFileSync, type Stats, statSync } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

/** Wallpaper Engine 的 Steam AppID（workshop content 挂在这个目录下）。 */
const WE_APPID = "431960";

/** 工程清单缓存：首次扫描较慢（工坊几千目录），短 TTL 内的重复拉取直接回缓存。 */
const INVENTORY_TTL_MS = 3000;
/** Steam 路径探测（reg.exe / vdf 解析）较贵，缓存更久；失败也缓存，避免每次请求都探测。 */
const ROOTS_TTL_MS = 60_000;

export interface WallpaperEntry {
	/** 稳定 id：ws-<目录名> / mp-<目录名> / dp-<目录名> / custom / customDir-<目录名>。 */
	id: string;
	title: string;
	type: "scene" | "video" | "web" | "application";
	/** 视频类直连媒体（/wallpaper/media/<token>）；scene/web 为 null。 */
	mediaUrl: string | null;
	/** 网页壁纸入口（/wallpaper/files/<dirToken>/<入口文件>）。 */
	webUrl: string | null;
	previewUrl: string | null;
	contentRating: string;
	/** project.json 的 schemecolor 转成的 CSS 色，给加载占位用；解析不出为空串。 */
	schemeColor: string;
	/** 来源标注，UI 分组显示用。 */
	source: "workshop" | "myprojects" | "default" | "custom";
	/** 目录 token：/wallpaper/files/<dirToken>/<subpath>（所有类型都登记，属性面板读 project.json 用）。 */
	projectUrl: string | null;
	/** scene 实时渲染：scene.pkg 的媒体 token（渲染页拼 mediaBase + src 取包）。非 pkg 场景为 null。 */
	sceneSrc: string | null;
	/** scene 包体积（字节）：客户端按它放大首帧预算（几百 MB 的包要拉很久）。 */
	pkgBytes: number | null;
	/** project.json 是否含用户属性（决定属性面板显隐）。 */
	hasProps: boolean;
}

export interface WallpaperInventory {
	wallpapers: WallpaperEntry[];
	/** 探测摘要：给设置页显示「已找到 Wallpaper Engine 目录 / 未检测到」。 */
	installDir: string | null;
	workshopDirs: string[];
	usedCustomDir: boolean;
}

export interface WallpaperHttpOptions {
	authorizeOrigin?: (origin: string | undefined) => boolean;
	/** settings.json owlWallpaper.customDir：额外扫描的壁纸根目录（每个子目录是一张壁纸）。 */
	getCustomDir?: () => string | Promise<string>;
	/** settings.json owlWallpaper.customPath：用户指定的单个壁纸文件（视频/图片/网页）。 */
	getCustomPath?: () => string | Promise<string>;
	/** 是否探测本机 Steam/Wallpaper Engine（测试隔离用，默认 true）。 */
	steamProbe?: boolean;
}

// ---------------------------------------------------------------- MIME / 类型

const MIME_BY_EXT: Record<string, string> = {
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".mov": "video/quicktime",
	".avi": "video/x-msvideo",
	".m4v": "video/mp4",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".flac": "audio/flac",
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml",
	".vtt": "text/vtt",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const WEB_EXTS = new Set([".html", ".htm"]);

function mimeFor(file: string): string {
	return MIME_BY_EXT[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** project.json 缺 type 时按入口扩展名猜（上游 inferType 同语义，另认图片）。 */
function inferType(file: string): WallpaperEntry["type"] {
	const ext = extname(file).toLowerCase();
	if (VIDEO_EXTS.has(ext)) return "video";
	if (WEB_EXTS.has(ext) || ext === ".js") return "web";
	if (IMAGE_EXTS.has(ext)) return "video"; // 图片走 mediaUrl 通道（img/视频共用 media 路由）
	return "scene";
}

// ---------------------------------------------------------------- token 登记

/** 媒体 token → 文件绝对路径（枚举时登记；桥重启后客户端会重新拉 inventory）。 */
const mediaTokens = new Map<string, string>();
/** 目录 token → 目录绝对路径（网页壁纸子文件服务用）。 */
const dirTokens = new Map<string, string>();

function newToken(): string {
	return randomBytes(16).toString("base64url");
}

// ---------------------------------------------------------------- Steam 探测

/** reg.exe 读 HKCU\Software\Valve\Steam 的 SteamPath（仅 Windows；失败返回 null）。 */
function steamPathFromRegistry(): Promise<string | null> {
	if (process.platform !== "win32") return Promise.resolve(null);
	return new Promise((resolvePromise) => {
		execFile(
			"reg",
			["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"],
			{ timeout: 5000 },
			(error, stdout) => {
				if (error) return resolvePromise(null);
				const match = /SteamPath\s+REG_SZ\s+(.+)/.exec(stdout ?? "");
				resolvePromise(match ? match[1].trim() : null);
			},
		);
	});
}

/** 常见安装位置的兜底探测（registry 拿不到时用，上游 STEAM_PROBE_DIRS 同思路）。 */
const STEAM_PROBE_DIRS = [
	"C:\\Program Files (x86)\\Steam",
	"C:\\Program Files\\Steam",
	"D:\\Steam",
	"D:\\SteamLibrary",
	"E:\\Steam",
	"E:\\SteamLibrary",
];

/** libraryfolders.vdf 里逐条抽 "path" —— Steam 多库目录清单。 */
function librariesFromVdf(vdfPath: string): string[] {
	try {
		const text = readFileSync(vdfPath, "utf8");
		const libs: string[] = [];
		const regex = /"path"\s+"([^"]+)"/g;
		for (const match of text.matchAll(regex)) libs.push(match[1].replace(/\\\\/g, "\\"));
		return libs;
	} catch {
		return [];
	}
}

interface WeRoots {
	installDir: string | null;
	workshopDirs: string[];
}

let rootsCache: { value: WeRoots; at: number } | null = null;

/** Windows 路径不区分大小写，去重前先归一。 */
function normalizeDirKey(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

/**
 * 定位 Wallpaper Engine：Steam 注册表 → libraryfolders.vdf → 各库的
 * workshop/content/431960 与 common/wallpaper_engine。没有 WE 客户端但有
 * 工坊内容（如手动拷贝的目录）时，靠 customDir 兜底。
 * steamProbe=false 供测试隔离（机器上真装了 WE 时，单测不想扫真实库）。
 */
async function locateWeRoots(steamProbe: boolean): Promise<WeRoots> {
	if (!steamProbe) return { installDir: null, workshopDirs: [] };
	if (rootsCache && Date.now() - rootsCache.at < ROOTS_TTL_MS) return rootsCache.value;
	const roots: WeRoots = { installDir: null, workshopDirs: [] };
	const candidates = new Set<string>();
	const registry = await steamPathFromRegistry();
	if (registry) candidates.add(registry);
	for (const dir of STEAM_PROBE_DIRS) if (existsSync(dir)) candidates.add(dir);
	const seenWorkshops = new Set<string>();
	for (const steamRoot of candidates) {
		const steamapps = join(steamRoot, "steamapps");
		const libraries = [steamRoot, ...librariesFromVdf(join(steamapps, "libraryfolders.vdf"))];
		const seenLibs = new Set<string>();
		for (const lib of libraries) {
			// steamRoot 与 vdf 里的第一条库往往是同一个目录，不按 key 去重会重复扫描
			const libKey = normalizeDirKey(lib);
			if (seenLibs.has(libKey)) continue;
			seenLibs.add(libKey);
			const libSteamapps = existsSync(join(lib, "steamapps")) ? join(lib, "steamapps") : steamapps;
			const workshop = join(libSteamapps, "workshop", "content", WE_APPID);
			const workshopKey = normalizeDirKey(workshop);
			if (existsSync(workshop) && !seenWorkshops.has(workshopKey)) {
				seenWorkshops.add(workshopKey);
				roots.workshopDirs.push(workshop);
			}
			const install = join(libSteamapps, "common", "wallpaper_engine");
			if (!roots.installDir && existsSync(join(install, "wallpaper32.exe"))) roots.installDir = install;
		}
	}
	if (!roots.installDir) {
		// 装了工坊内容但没探到客户端 exe：用第一个 workshop 目录反推 common 位置即可
		// （installDir 只用于展示；真正的素材目录是 workshopDirs / myprojects）。
		for (const steamRoot of candidates) {
			const guess = join(steamRoot, "steamapps", "common", "wallpaper_engine");
			if (existsSync(guess)) {
				roots.installDir = guess;
				break;
			}
		}
	}
	rootsCache = { value: roots, at: Date.now() };
	return roots;
}

// ---------------------------------------------------------------- 工程读取

interface ProjectInfo {
	title: string;
	type: WallpaperEntry["type"];
	file: string;
	preview: string;
	contentRating: string;
	schemeColor: string;
	hasProps: boolean;
}

/** 读单个工程的 project.json；无效（缺 file / 非法 JSON / application）返回 null。 */
async function readProject(dir: string): Promise<ProjectInfo | null> {
	let pj: Record<string, unknown>;
	try {
		pj = JSON.parse(await readFile(join(dir, "project.json"), "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
	const file = typeof pj.file === "string" ? pj.file.trim() : "";
	if (!file || file.includes("..")) return null;
	const rawType = typeof pj.type === "string" ? pj.type.toLowerCase() : "";
	if (rawType === "application") return null;
	const type = (["scene", "video", "web"].includes(rawType) ? rawType : inferType(file)) as WallpaperEntry["type"];
	const general = (pj.general ?? {}) as Record<string, unknown>;
	const properties = (general.properties ?? {}) as Record<
		string,
		{ value?: unknown; type?: unknown; editable?: unknown }
	>;
	const scheme = properties.schemecolor?.value;
	let schemeColor = "";
	if (typeof scheme === "string") {
		const parts = scheme.trim().split(/\s+/).map(Number);
		if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) {
			schemeColor = `rgb(${parts.map((n) => Math.round(n * 255)).join(",")})`;
		}
	}
	// 是否有用户可调属性（editable:false 是作者标记的内部变量，不算）
	const hasProps = Object.values(properties).some((p) => p && typeof p.type === "string" && p.editable !== false);
	return {
		title: typeof pj.title === "string" && pj.title.trim() ? pj.title.trim() : basename(dir),
		type,
		file,
		preview: typeof pj.preview === "string" ? pj.preview : "",
		contentRating: typeof pj.contentrating === "string" ? pj.contentrating : "",
		schemeColor,
		hasProps,
	};
}

/** 预览图：声明值优先，不存在则试常见名字；都没有返回 null。 */
function findPreview(dir: string, declared: string): string | null {
	const candidates = [declared, "preview.jpg", "preview.png", "preview.gif"].filter(Boolean);
	for (const candidate of candidates) {
		const abs = resolve(dir, candidate);
		if (!abs.startsWith(resolve(dir) + sep) && abs !== resolve(dir)) continue;
		if (existsSync(abs) && statSync(abs).isFile() && IMAGE_EXTS.has(extname(abs).toLowerCase())) return abs;
	}
	return null;
}

function registerMediaFile(absPath: string): string | null {
	if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
	const token = newToken();
	mediaTokens.set(token, absPath);
	return token;
}

async function entryFromProject(
	dir: string,
	id: string,
	source: WallpaperEntry["source"],
): Promise<WallpaperEntry | null> {
	const info = await readProject(dir);
	if (!info) return null;
	const entry: WallpaperEntry = {
		id,
		title: info.title,
		type: info.type,
		mediaUrl: null,
		webUrl: null,
		previewUrl: null,
		contentRating: info.contentRating,
		schemeColor: info.schemeColor,
		source,
		projectUrl: null,
		sceneSrc: null,
		pkgBytes: null,
		hasProps: info.hasProps,
	};
	const entryAbs = resolve(dir, info.file);
	if (!entryAbs.startsWith(resolve(dir) + sep) && entryAbs !== resolve(dir)) return null;
	// 目录 token：所有类型都登记 —— 属性面板要读 project.json，web 壁纸要取子资源
	const dirToken = newToken();
	dirTokens.set(dirToken, resolve(dir));
	entry.projectUrl = `/wallpaper/files/${dirToken}/project.json`;
	if (info.type === "video") {
		const token = registerMediaFile(entryAbs);
		if (!token) return null;
		entry.mediaUrl = `/wallpaper/media/${token}`;
	} else if (info.type === "web") {
		if (!existsSync(entryAbs) || !WEB_EXTS.has(extname(entryAbs).toLowerCase())) return null;
		entry.webUrl = `/wallpaper/files/${dirToken}/${info.file.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
	} else if (info.type === "scene") {
		// scene 实时渲染：入口是 scene.pkg（二进制容器）才行；scene.json 等旧格式降级为静态预览。
		// token 走 /wallpaper/media（同源 + Range），渲染页拼 mediaBase + src 取包自行解析。
		const isPkg = !entryAbs.toLowerCase().endsWith(".json");
		if (isPkg && existsSync(entryAbs)) {
			const token = registerMediaFile(entryAbs);
			if (token) {
				entry.sceneSrc = token;
				try {
					entry.pkgBytes = statSync(entryAbs).size;
				} catch {
					entry.pkgBytes = null;
				}
			}
		}
	}
	const preview = findPreview(dir, info.preview);
	if (preview) {
		const token = registerMediaFile(preview);
		if (token) entry.previewUrl = `/wallpaper/media/${token}`;
	}
	return entry;
}

// ---------------------------------------------------------------- 枚举

let inventoryCache: { value: WallpaperInventory; at: number } | null = null;

/** 每批并发的 project.json 探测数（上游 SCAN_CHUNK 同值，线程池友好）。 */
const SCAN_CHUNK = 24;

/** 列出 root 下每个含 project.json 的子目录；异步分块探测，不阻塞桥事件循环。 */
async function scanWallpaperDirs(root: string): Promise<string[]> {
	let dirents: Dirent[];
	try {
		dirents = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const dirs = dirents.filter((d) => d.isDirectory()).map((d) => join(root, d.name));
	const found: string[] = [];
	for (let at = 0; at < dirs.length; at += SCAN_CHUNK) {
		const hits = await Promise.all(
			dirs.slice(at, at + SCAN_CHUNK).map(async (dir) => {
				try {
					await access(join(dir, "project.json"));
					return dir;
				} catch {
					return null;
				}
			}),
		);
		for (const hit of hits) if (hit) found.push(hit);
	}
	return found;
}

async function buildInventory(options: WallpaperHttpOptions): Promise<WallpaperInventory> {
	if (inventoryCache && Date.now() - inventoryCache.at < INVENTORY_TTL_MS) return inventoryCache.value;
	// 枚举先换新 token 集：旧 token 直接失效，白名单不会随时间无限增长。
	mediaTokens.clear();
	dirTokens.clear();
	const roots = await locateWeRoots(options.steamProbe !== false);
	const wallpapers: WallpaperEntry[] = [];
	const seenDirs = new Set<string>();
	const pushAll = async (dirs: string[], source: WallpaperEntry["source"], prefix: string): Promise<void> => {
		// 分块并发建条目；按解析后的目录去重，防止同一目录经不同 root 重复出现
		for (let at = 0; at < dirs.length; at += SCAN_CHUNK) {
			const entries = await Promise.all(
				dirs.slice(at, at + SCAN_CHUNK).map(async (dir) => {
					const dirKey = normalizeDirKey(resolve(dir));
					if (seenDirs.has(dirKey)) return null;
					seenDirs.add(dirKey);
					return entryFromProject(dir, `${prefix}-${basename(dir)}`, source);
				}),
			);
			for (const entry of entries) {
				if (entry) wallpapers.push(entry);
			}
		}
	};
	if (roots.installDir) {
		await pushAll(await scanWallpaperDirs(join(roots.installDir, "projects", "myprojects")), "myprojects", "mp");
		await pushAll(await scanWallpaperDirs(join(roots.installDir, "projects", "defaultprojects")), "default", "dp");
	}
	for (const workshop of roots.workshopDirs) await pushAll(await scanWallpaperDirs(workshop), "workshop", "ws");
	// 用户自定义目录：每个子目录一张壁纸；目录本身直接含 project.json 时整目录算一张。
	const customDir = (await options.getCustomDir?.())?.trim() ?? "";
	if (customDir) {
		const abs = resolve(customDir);
		if (existsSync(join(abs, "project.json"))) {
			const entry = await entryFromProject(abs, "customDir-root", "custom");
			if (entry) wallpapers.push(entry);
		} else {
			await pushAll(await scanWallpaperDirs(abs), "custom", "customDir");
		}
	}
	// 用户指定的单个本地文件（视频/图片/网页），不走 project.json。
	const customPath = (await options.getCustomPath?.())?.trim() ?? "";
	if (customPath) {
		const abs = resolve(customPath);
		const ext = extname(abs).toLowerCase();
		if (
			existsSync(abs) &&
			statSync(abs).isFile() &&
			(VIDEO_EXTS.has(ext) || IMAGE_EXTS.has(ext) || WEB_EXTS.has(ext))
		) {
			const token = registerMediaFile(abs);
			const type = WEB_EXTS.has(ext) ? "web" : "video";
			if (WEB_EXTS.has(ext)) {
				const dirToken = newToken();
				dirTokens.set(dirToken, dirname(abs));
				// 网页文件可能带同目录 project.json（属性面板数据源）；没有则面板不显示
				const customInfo = await readProject(dirname(abs));
				wallpapers.push({
					id: "custom",
					title: basename(abs),
					type,
					mediaUrl: null,
					webUrl: `/wallpaper/files/${dirToken}/${encodeURIComponent(basename(abs))}`,
					previewUrl: null,
					contentRating: "",
					schemeColor: "",
					source: "custom",
					projectUrl: `/wallpaper/files/${dirToken}/project.json`,
					sceneSrc: null,
					pkgBytes: null,
					hasProps: customInfo?.hasProps ?? false,
				});
			} else if (token) {
				wallpapers.push({
					id: "custom",
					title: basename(abs),
					type,
					mediaUrl: `/wallpaper/media/${token}`,
					webUrl: null,
					previewUrl: null,
					contentRating: "",
					schemeColor: "",
					source: "custom",
					projectUrl: null,
					sceneSrc: null,
					pkgBytes: null,
					hasProps: false,
				});
			}
		}
	}
	wallpapers.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
	const value: WallpaperInventory = {
		wallpapers,
		installDir: roots.installDir,
		workshopDirs: roots.workshopDirs,
		usedCustomDir: Boolean(customDir),
	};
	inventoryCache = { value, at: Date.now() };
	return value;
}

// ---------------------------------------------------------------- 文件服务

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(value));
}

/** 带 Range 的文件出流：视频拖动进度条必须 206 分片，否则 WebView2 会拒绝播放。 */
function serveFileBytes(request: IncomingMessage, response: ServerResponse, absPath: string, cacheable: boolean): void {
	let stat: Stats;
	try {
		stat = statSync(absPath);
	} catch {
		sendJson(response, { error: "文件不存在" }, 404);
		return;
	}
	const size = stat.size;
	const mime = mimeFor(absPath);
	const etag = `"${size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
	if (request.headers["if-none-match"] === etag) {
		response.writeHead(304, { ETag: etag });
		response.end();
		return;
	}
	const baseHeaders: Record<string, string | number> = {
		"Content-Type": mime,
		"Accept-Ranges": "bytes",
		ETag: etag,
		"X-Content-Type-Options": "nosniff",
		// 渲染页(含将来可能的跨源载荷页)fetch 壁纸载荷用；上游 scene-files 同款
		"Access-Control-Allow-Origin": "*",
		...(cacheable ? { "Cache-Control": "private, max-age=3600" } : { "Cache-Control": "no-store" }),
	};
	const rangeHeader = request.headers.range;
	if (rangeHeader) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
		let start = 0;
		let end = size - 1;
		if (match && (match[1] || match[2])) {
			if (match[1]) {
				start = Number(match[1]);
				if (match[2]) end = Math.min(Number(match[2]), size - 1);
			} else {
				// bytes=-N：末尾 N 字节
				start = Math.max(0, size - Number(match[2]));
			}
		}
		if (!match || start > end || start >= size) {
			response.writeHead(416, { "Content-Range": `bytes */${size}` });
			response.end();
			return;
		}
		response.writeHead(206, {
			...baseHeaders,
			"Content-Range": `bytes ${start}-${end}/${size}`,
			"Content-Length": end - start + 1,
		});
		createReadStream(absPath, { start, end }).pipe(response);
		return;
	}
	response.writeHead(200, { ...baseHeaders, "Content-Length": size });
	createReadStream(absPath).pipe(response);
}

/**
 * 从 project.json 的 general.properties 抽默认属性表，作为
 * `window.__weSeedProps({ 名: { value } })` 注入网页壁纸（shim 在作者脚本前
 * 把它灌进 wallpaperPropertyListener，属性驱动的壁纸不会先黑一帧再纠正）。
 */
function buildSeedProps(entryDir: string): Record<string, { value: unknown }> {
	try {
		const pj = JSON.parse(readFileSync(join(entryDir, "project.json"), "utf8")) as {
			general?: { properties?: Record<string, { value?: unknown; editable?: boolean }> };
		};
		const seed: Record<string, { value: unknown }> = {};
		for (const [name, prop] of Object.entries(pj.general?.properties ?? {})) {
			if (prop?.editable === false) continue;
			if (prop && "value" in prop && prop.value !== null) seed[name] = { value: prop.value };
		}
		return seed;
	} catch {
		return {};
	}
}

/**
 * 在 <head> 后注入 site-root / seed + shim；没有 <head> 就塞到文档最前面（shim 必须先于作者脚本）。
 * siteRoot = 壁纸目录的 URL 前缀（以 / 开头结尾）：shim 把逃出该前缀的 `..` 夹回根
 * （官方语义：壁纸目录即站点根；spine 类网页壁纸依赖这个，否则整页黑屏）。
 */
function injectWebShim(html: string, seed: Record<string, { value: unknown }>, dirToken: string): string {
	const siteRoot = `/wallpaper/files/${dirToken}/`;
	const inject =
		`<script>window.__weSiteRoot=${JSON.stringify(siteRoot)};window.__weSeedProps=${JSON.stringify(seed)};</script>` +
		`<script src="/wallpaper-shim.js"></script>`;
	const headMatch = /<head[^>]*>/i.exec(html);
	if (headMatch) {
		const at = headMatch.index + headMatch[0].length;
		return html.slice(0, at) + inject + html.slice(at);
	}
	return inject + html;
}

// ---------------------------------------------------------------- HTTP 入口

/** 挂进 serve.ts 的 HTTP handler 链（map/news 同款：处理了返回 true）。 */
export async function handleWallpaperHttp(
	request: IncomingMessage,
	response: ServerResponse,
	options: WallpaperHttpOptions,
): Promise<boolean> {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (!url.pathname.startsWith("/wallpaper/") && url.pathname !== "/wallpaper") return false;
	if (options.authorizeOrigin && !options.authorizeOrigin(request.headers.origin)) {
		sendJson(response, { error: "壁纸接口只接受本地桌面请求" }, 403);
		return true;
	}
	try {
		if (request.method === "GET" && (url.pathname === "/wallpaper" || url.pathname === "/wallpaper/inventory")) {
			// refresh=1：清缓存强制重扫（设置页改了自定义目录/点了刷新按钮）。
			if (url.searchParams.has("refresh")) inventoryCache = null;
			sendJson(response, await buildInventory(options));
			return true;
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.setHeader("Allow", "GET, HEAD");
			sendJson(response, { error: "壁纸接口只支持 GET" }, 405);
			return true;
		}
		const mediaMatch = /^\/wallpaper\/media\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
		if (mediaMatch) {
			const absPath = mediaTokens.get(mediaMatch[1]);
			if (!absPath) {
				sendJson(response, { error: "媒体 token 不存在或已过期，请刷新壁纸列表" }, 404);
				return true;
			}
			serveFileBytes(request, response, absPath, true);
			return true;
		}
		// 网页壁纸子文件：目录 token + 相对子路径，resolve 后必须仍在目录内。
		const filesMatch = /^\/wallpaper\/files\/([A-Za-z0-9_-]+)\/(.+)$/.exec(url.pathname);
		if (filesMatch) {
			const dir = dirTokens.get(filesMatch[1]);
			if (!dir) {
				sendJson(response, { error: "壁纸目录 token 不存在或已过期，请刷新壁纸列表" }, 404);
				return true;
			}
			let subpath: string;
			try {
				subpath = decodeURIComponent(filesMatch[2]);
			} catch {
				sendJson(response, { error: "路径编码非法" }, 400);
				return true;
			}
			const target = resolve(dir, subpath);
			if (target !== dir && !target.startsWith(dir + sep)) {
				sendJson(response, { error: "路径越界" }, 403);
				return true;
			}
			if (!existsSync(target) || !statSync(target).isFile()) {
				sendJson(response, { error: "文件不存在" }, 404);
				return true;
			}
			const ext = extname(target).toLowerCase();
			if (!(ext in MIME_BY_EXT)) {
				sendJson(response, { error: "不支持的文件类型" }, 403);
				return true;
			}
			if (ext === ".html" || ext === ".htm") {
				// 网页壁纸 HTML：注入 site-root / seed 属性 + shim（shim 由桌面端 dist 静态提供）。
				// iframe 沙箱（sandbox="allow-scripts"）在客户端设置，这里只管内容。
				const html = readFileSync(target, "utf8");
				response.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
				});
				response.end(
					request.method === "HEAD" ? undefined : injectWebShim(html, buildSeedProps(dir), filesMatch[1]),
				);
				return true;
			}
			serveFileBytes(request, response, target, true);
			return true;
		}
		sendJson(response, { error: "壁纸接口不存在" }, 404);
		return true;
	} catch (error) {
		sendJson(response, { error: error instanceof Error ? error.message : "壁纸服务失败" }, 500);
		return true;
	}
}

/** 测试与诊断用：清掉全部缓存（token 白名单一并作废）。 */
export function resetWallpaperState(): void {
	mediaTokens.clear();
	dirTokens.clear();
	rootsCache = null;
	inventoryCache = null;
}
