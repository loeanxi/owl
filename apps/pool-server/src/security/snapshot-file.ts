/**
 * 快照文件的原子读写 —— 移植自 manager `LoginFailureStore` / `SessionSnapshotStore`
 * 共用的磁盘形态：写 tmp → 原子改名；读损坏一律返回 null（安全侧倾，调用方按空表启动）。
 * 快照失败绝不影响主流程。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 读 JSON 快照；缺失/损坏返回 null（调用方按空表启动）。 */
export function loadSnapshot<T>(file: string | null): T | null {
	if (file === null || !existsSync(file)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

/** 原子写 JSON 快照；任何失败静默吞掉（只影响恢复能力，不影响主流程）。 */
export function saveSnapshot(file: string | null, data: unknown): void {
	if (file === null) {
		return;
	}
	let tmp: string | undefined;
	try {
		const parent = dirname(file);
		if (parent.length > 0) {
			mkdirSync(parent, { recursive: true });
		}
		// 临时名必须唯一：固定的 `${file}.tmp` 在两个进程同时写时会互相截断
		tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(data)}\n`, "utf8");
		try {
			renameSync(tmp, file);
		} catch {
			// Windows 上跨进程占用时原子改名可能失败，退回普通覆盖
			rmSync(file, { force: true });
			renameSync(tmp, file);
		}
	} catch {
		// 快照失败只影响重启恢复，静默
		try {
			if (tmp) rmSync(tmp, { force: true });
		} catch {
			// 忽略
		}
	}
}

/** 删除快照（全员强制下线 / 计数清零）。 */
export function clearSnapshot(file: string | null): void {
	if (file === null) {
		return;
	}
	try {
		rmSync(file, { force: true });
	} catch {
		// 忽略
	}
}
