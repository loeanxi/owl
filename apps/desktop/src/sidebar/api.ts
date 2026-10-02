/**
 * 侧边栏工作台的类型化 API：把桥的 request/response 包成领域函数。
 *
 * 与 dsh-better-sidebar 的 /sidebar/api JSON 路由对应，但传输走 owl 现有的
 * WebSocket 桥（同一条连接、同一套 request id），路径全部是 workspace 相对
 * （POSIX 分隔符），cwd 由调用方（App 显式跟踪的项目目录）提供。
 */
import type { BridgeClient } from "../bridge/client.ts";
import type {
	FsListing,
	FsReadBinResult,
	FsReadResult,
	FsSearchHit,
	GitLogEntry,
	GitStatusResult,
} from "../bridge/protocol.ts";

/** 桥错误字符串按 "code: message" 过线（serve.ts 的 SidebarError 约定）。 */
export function parseBridgeError(error: string | undefined): { code: string; message: string } {
	const text = error ?? "未知错误";
	const sep = text.indexOf(": ");
	if (sep > 0 && /^[a-z-]+$/i.test(text.slice(0, sep))) {
		return { code: text.slice(0, sep), message: text.slice(sep + 2) };
	}
	return { code: "error", message: text };
}

function unwrap<T>(result: { ok: boolean; result?: T; error?: string }, what: string): T {
	if (!result.ok) throw new Error(result.error ?? `${what} 失败`);
	return result.result as T;
}

export function createSidebarApi(client: BridgeClient) {
	return {
		fsTree: (cwd: string, path = "") =>
			client
				.request<FsListing>({ type: "fs.tree", cwd, path })
				.then((r) => unwrap(r, "读取目录")),
		fsRead: (cwd: string, path: string) =>
			client
				.request<FsReadResult>({ type: "fs.read", cwd, path })
				.then((r) => unwrap(r, "读取文件")),
		fsReadBin: (cwd: string, path: string) =>
			client
				.request<FsReadBinResult>({ type: "fs.readBin", cwd, path })
				.then((r) => unwrap(r, "读取文件")),
		fsWrite: (cwd: string, path: string, content: string) =>
			client
				.request<{ path: string; size: number }>({ type: "fs.write", cwd, path, content })
				.then((r) => unwrap(r, "保存文件")),
		fsMkdir: (cwd: string, path: string, name: string) =>
			client
				.request<{ path: string }>({ type: "fs.mkdir", cwd, path, name })
				.then((r) => unwrap(r, "新建文件夹")),
		fsRename: (cwd: string, path: string, name: string) =>
			client
				.request<{ path: string }>({ type: "fs.rename", cwd, path, name })
				.then((r) => unwrap(r, "重命名")),
		fsRemove: (cwd: string, path: string) =>
			client
				.request<{ path: string }>({ type: "fs.remove", cwd, path })
				.then((r) => unwrap(r, "删除")),
		fsSearch: (cwd: string, query: string) =>
			client
				.request<FsSearchHit[]>({ type: "fs.search", cwd, query })
				.then((r) => unwrap(r, "搜索")),
		gitStatus: (cwd: string) =>
			client
				.request<GitStatusResult>({ type: "git.status", cwd })
				.then((r) => unwrap(r, "读取 Git 状态")),
		gitDiff: (cwd: string, path?: string, staged = false) =>
			client
				.request<{ diff: string }>({ type: "git.diff", cwd, ...(path !== undefined ? { path } : {}), staged })
				.then((r) => unwrap(r, "读取 diff").diff),
		gitStage: (cwd: string, paths: string[]) =>
			client.request({ type: "git.stage", cwd, paths }).then((r) => unwrap(r, "暂存")),
		gitUnstage: (cwd: string, paths: string[]) =>
			client.request({ type: "git.unstage", cwd, paths }).then((r) => unwrap(r, "取消暂存")),
		gitCommit: (cwd: string, message: string) =>
			client.request({ type: "git.commit", cwd, message }).then((r) => unwrap(r, "提交")),
		gitDiscard: (cwd: string, path: string) =>
			client.request({ type: "git.discard", cwd, path }).then((r) => unwrap(r, "还原")),
		gitLog: (cwd: string, count = 50) =>
			client
				.request<GitLogEntry[]>({ type: "git.log", cwd, count })
				.then((r) => unwrap(r, "读取历史")),
		watchSet: (cwd: string, dirs: string[]) =>
			client.request({ type: "watch.set", cwd, dirs }).then((r) => unwrap(r, "订阅目录变更")),
		openExternal: (action: "reveal" | "url", target: string, cwd?: string) =>
			client
				.request({ type: "open.external", action, target, ...(cwd !== undefined ? { cwd } : {}) })
				.then((r) => unwrap(r, "打开")),
	};
}

export type SidebarApi = ReturnType<typeof createSidebarApi>;

/** 归一化路径比较（Windows 大小写不敏感 + 分隔符统一），与 App 的 samePath 同规则。 */
export function samePath(a: string | undefined, b: string | undefined): boolean {
	const norm = (p: string | undefined): string => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return norm(a) === norm(b) && norm(a) !== "";
}
