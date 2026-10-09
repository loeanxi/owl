import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 原子写（唯一临时名 → fsync → rename，Windows 目标被占用时短暂重试），与宿主
 * utils/atomic-file.ts 同规格。插件运行时只能拿到宿主已发布的导出，新增的宿主工具函数
 * 在旧桥上会直接让插件加载失败，所以这里自带一份。
 */
export function atomicWriteFileSync(path: string, data: string, mode?: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		const fd = openSync(temp, "wx", mode);
		try {
			writeFileSync(fd, data, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		for (let attempt = 1; ; attempt++) {
			try {
				renameSync(temp, path);
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt >= 8) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * attempt);
			}
		}
	} finally {
		if (existsSync(temp)) {
			try {
				unlinkSync(temp);
			} catch {
				// 孤儿临时文件不影响目标文件
			}
		}
	}
}
