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

import { type FSWatcher, watch } from "node:fs";
import { invalidateDirectoryCache } from "./sidebar-fs.ts";

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
