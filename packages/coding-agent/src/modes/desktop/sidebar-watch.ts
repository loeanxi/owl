/**
 * 侧边栏文件树的目录变更 watch。
 *
 * 移植自 dsh-better-sidebar 的 fs-watch.ts：树只对**已展开**的目录建
 * `fs.watch`（一个目录一个 OS 句柄，全工作区递归会耗尽句柄），收起即释放。
 * 一阵文件系统事件被 150ms 防抖折叠成一次推送；推送前失效目录列目缓存，
 * 保证客户端随后的重列不会拿到变更前的旧层。
 *
 * owl 的差异：watcher 集按项目 cwd 归属（一个项目一个集合，serve.ts 持有），
 * 变更通过现有 WS 协议以 fs_changed 事件广播，不单独开 socket。
 */

import { type FSWatcher, statSync, watch } from "node:fs";
import { join } from "node:path";
import { invalidateDirectoryCache } from "./sidebar-fs.ts";
import { gitMetadataDirs } from "./sidebar-git.ts";

/** 一阵文件系统事件折叠成一次推送的窗口。 */
const DEBOUNCE_MS = 150;

/** 单个 watcher 集的句柄上限（资源护栏，不是策略）。 */
const MAX_WATCHES = 64;

/** watcher 集的所有者（serve.ts 里 = 一个项目 cwd）。 */
export interface DirectoryWatchers {
	/** 开始 watch 一个绝对目录；已在 watch 则 no-op。满了返回 false。 */
	add(dir: string): boolean;
	/** 停止 watch 一个目录（幂等）。 */
	remove(dir: string): void;
	/** 当前在 watch 的目录（绝对路径）。 */
	dirs(): string[];
	/** 停止全部。 */
	close(): void;
}

/**
 * 创建一个 watcher 集。
 * @param push - 防抖后的目录变更回调（绝对路径）。
 * @param onError - 目录不可 watch 或 watcher 出错（目录已被丢弃，调用方只需上报）。
 */
export function createDirectoryWatchers(
	push: (dir: string) => void,
	onError: (dir: string, error: unknown) => void,
): DirectoryWatchers {
	const watchers = new Map<string, { watcher: FSWatcher; timer: NodeJS.Timeout | undefined }>();

	const drop = (dir: string): void => {
		const entry = watchers.get(dir);
		if (entry === undefined) return;
		watchers.delete(dir);
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.watcher.close();
	};

	const notify = (dir: string): void => {
		const entry = watchers.get(dir);
		if (entry === undefined || entry.timer !== undefined) return;
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			if (!watchers.has(dir)) return;
			// 写路由会自失效缓存；这里覆盖的是插件之外发生的变更（编辑器、
			// 构建、模型的 bash）——这正是 watcher 存在的理由。
			invalidateDirectoryCache(dir);
			push(dir);
		}, DEBOUNCE_MS);
		// 挂起的重列绝不许拖住宿主进程退出。
		entry.timer.unref();
	};

	return {
		add(dir) {
			if (watchers.has(dir)) return true;
			if (watchers.size >= MAX_WATCHES) return false;
			let watcher: FSWatcher;
			try {
				watcher = watch(dir, { persistent: false });
			} catch (error) {
				onError(dir, error);
				return false;
			}
			watcher.on("change", () => {
				notify(dir);
			});
			watcher.on("error", (error) => {
				onError(dir, error);
				drop(dir);
			});
			watchers.set(dir, { watcher, timer: undefined });
			return true;
		},
		remove: drop,
		dirs() {
			return [...watchers.keys()];
		},
		close() {
			for (const dir of [...watchers.keys()]) drop(dir);
		},
	};
}

/** 一阵 git 相关变更折叠成一次 git_changed（npm install、checkout 这类风暴只推一次）。 */
const GIT_DEBOUNCE_MS = 250;

/** `.git` 目录里会改变 status 结果的条目；objects、logs、*.lock 等都是噪音。 */
const GIT_STATE_FILES = new Set(["index", "HEAD", "packed-refs", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD"]);

/**
 * 递归事件里的相对路径是否可能改变 git 状态。工作区文件都算（未展开目录里的
 * 改动也要能把父目录染色）；`.git` 内只认 index/HEAD/refs；node_modules 内部
 * 不看——它整体被忽略，只有目录本身出现/消失才影响置灰。
 */
export function affectsGitState(filename: string): boolean {
	const segments = filename.split(/[\\/]/).filter((segment) => segment !== "");
	const gitIndex = segments.indexOf(".git");
	if (gitIndex >= 0) {
		const inner = segments.slice(gitIndex + 1);
		if (inner.length === 0) return true;
		return inner[0] === "refs" ? !inner.at(-1)!.endsWith(".lock") : GIT_STATE_FILES.has(inner.join("/"));
	}
	const modules = segments.indexOf("node_modules");
	return modules < 0 || modules === segments.length - 1;
}

export interface GitStateWatcher {
	close(): void;
}

/**
 * 盯住会改变 git 状态的一切：外部终端的 stage/commit/checkout、未展开目录里
 * 的文件变化。和按展开目录建的 DirectoryWatchers 互补，只推送「该重取 status
 * 了」，不失效列目缓存。Windows/macOS 的递归 watch 是单个系统句柄；其他平台
 * 递归 watch 要逐目录建句柄，退化为只盯各仓库的 .git 目录。
 */
export function createGitStateWatcher(
	root: string,
	push: () => void,
	onError: (target: string, error: unknown) => void,
): GitStateWatcher {
	const watchers: FSWatcher[] = [];
	let timer: NodeJS.Timeout | undefined;
	let closed = false;
	const notify = (): void => {
		if (closed || timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			if (!closed) push();
		}, GIT_DEBOUNCE_MS);
		timer.unref();
	};
	// Windows 上光是读目录/文件也会报 change（访问时间），git status 扫一遍工作区就会自己触发自己。
	// 目录的 change 只可能是元数据；文件的 change 要看修改时间和大小是否真的变了。
	const lastWrite = new Map<string, string>();
	const contentChanged = (absolute: string): boolean => {
		const stats = statSync(absolute, { throwIfNoEntry: false });
		if (stats === undefined) return true;
		if (stats.isDirectory()) return false;
		const stamp = `${stats.mtimeMs}:${stats.size}`;
		if (lastWrite.get(absolute) === stamp) return false;
		if (lastWrite.size >= 5_000) lastWrite.clear();
		lastWrite.set(absolute, stamp);
		return true;
	};
	const open = (target: string, recursive: boolean, relevant: (filename: string) => boolean): void => {
		try {
			const watcher = watch(target, { persistent: false, recursive }, (event, filename) => {
				if (filename === null) {
					notify();
					return;
				}
				const name = String(filename);
				if (!relevant(name)) return;
				if (event === "change" && !contentChanged(join(target, name))) return;
				notify();
			});
			watcher.on("error", (error) => {
				onError(target, error);
				watcher.close();
			});
			watchers.push(watcher);
		} catch (error) {
			onError(target, error);
		}
	};
	if (process.platform === "win32" || process.platform === "darwin") {
		open(root, true, affectsGitState);
	} else {
		void gitMetadataDirs(root).then((dirs) => {
			if (closed) return;
			for (const dir of dirs) open(dir, false, (filename) => !filename.endsWith(".lock"));
		});
	}
	return {
		close() {
			closed = true;
			if (timer !== undefined) clearTimeout(timer);
			for (const watcher of watchers) watcher.close();
		},
	};
}
