/**
 * 浏览器上传的路径围栏。
 *
 * agent 能让页面拿到任意本机文件：把路径交给页面后，页面脚本就能读走并外传
 * （私钥、token、浏览器 profile 里的 cookie）。因此浏览器上传只放行工作区内的
 * 文件，且用 realpath 复核——词法前缀拦不住符号链接指向工作区外。
 *
 * 与 sidebar-fs.ts 的工作区围栏同源思路，但两处规则不同：侧栏文件树操作的是
 * 工作区**相对**路径，浏览器上传拿到的是**绝对**路径（Playwright 的 setFiles
 * 直接吃绝对路径），所以这里允许绝对输入，但要求规范化后仍落在工作区内。
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { BrowserToolError } from "./browser-errors.ts";

/** 单次上传的总字节上限（对齐浏览器插件的 512MB 档）。 */
export const MAX_BROWSER_UPLOAD_BYTES = 512 * 1024 * 1024;

export interface BrowserUploadScope {
	/** 本会话的工作区根目录（绝对路径）。 */
	workspaceRoot: string;
}

const UPLOAD_TEMPLATE =
	'标准格式：{"paths":["<工作区内的文件绝对路径>"]}；只接受当前工作区内的文件，本轮附件路径同样在工作区内。';

async function resolveRoot(workspaceRoot: string): Promise<string> {
	const root = await realpath(workspaceRoot).catch(() => undefined);
	if (!root) {
		throw new BrowserToolError("FILE_NOT_AUTHORIZED", `无法解析工作区目录，浏览器上传不可用。${UPLOAD_TEMPLATE}`);
	}
	return root;
}

/**
 * 校验上传路径并返回可交给浏览器的绝对路径。
 *
 * - 路径必须落在工作区内（realpath 之后判定，符号链接穿越被拦）；
 * - 目标必须是可读的普通文件；
 * - 本次上传的总字节不超过上限。
 */
export async function authorizeBrowserUpload(
	paths: string[],
	scope: BrowserUploadScope | undefined,
): Promise<string[]> {
	if (!scope) {
		throw new BrowserToolError(
			"FILE_NOT_AUTHORIZED",
			`浏览器上传需要绑定到会话工作区，当前调用没有工作区授权。${UPLOAD_TEMPLATE}`,
		);
	}
	const requested = paths.map((path) => path.trim()).filter((path) => path !== "");
	if (requested.length === 0) {
		throw new BrowserToolError("FILE_NOT_AUTHORIZED", `paths 为空，没有可上传的文件。${UPLOAD_TEMPLATE}`);
	}
	const root = await resolveRoot(scope.workspaceRoot);
	const resolved: string[] = [];
	let total = 0;
	for (const path of requested) {
		const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
		const real = await realpath(absolute).catch(() => undefined);
		if (!real) {
			throw new BrowserToolError("FILE_UNAVAILABLE", `文件不存在或不可访问："${path}"。${UPLOAD_TEMPLATE}`);
		}
		if (real !== root && !real.startsWith(root + sep)) {
			throw new BrowserToolError(
				"FILE_NOT_AUTHORIZED",
				`文件在工作区之外，浏览器上传只允许工作区内的文件："${path}"。${UPLOAD_TEMPLATE}`,
			);
		}
		const info = await stat(real).catch(() => undefined);
		if (!info || !info.isFile() || !Number.isFinite(info.size) || info.size < 0) {
			throw new BrowserToolError("FILE_UNAVAILABLE", `目标不是可读的普通文件："${path}"。${UPLOAD_TEMPLATE}`);
		}
		total += info.size;
		if (total > MAX_BROWSER_UPLOAD_BYTES) {
			throw new BrowserToolError(
				"FILE_TOO_LARGE",
				`浏览器上传超过 ${MAX_BROWSER_UPLOAD_BYTES} 字节上限。${UPLOAD_TEMPLATE}`,
			);
		}
		resolved.push(real);
	}
	return resolved;
}
