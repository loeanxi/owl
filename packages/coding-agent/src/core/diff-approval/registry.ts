/**
 * owl-diff-approval 的进程级单例接缝（与 question-channel / rewind-registry
 * 同一套模式）：捕获钩子在插件包（owl-diff-approval，settings plugins 加载），
 * 查询/保留/回滚在桌面桥 serve.ts 的 case 块，两边经这里拿到同一份工作区
 * 存储实例；桥启动时注入 broadcast，插件的每次落库都推 diffApproval.changed。
 */
import { resolve } from "node:path";
import type { DesktopServerMessage } from "../../modes/desktop/protocol.ts";
import {
	DIFF_APPROVAL_DEFAULT_MAX_FILE_BYTES,
	diffApprovalStorePath,
	DiffApprovalStore,
} from "./store.ts";

const stores = new Map<string, DiffApprovalStore>();

let broadcaster: ((message: DesktopServerMessage) => void) | undefined;

/** 桥启动时注入广播通道；close 时传 undefined 摘除（之后只静默落盘）。 */
export function setDiffApprovalBroadcaster(next: ((message: DesktopServerMessage) => void) | undefined): void {
	broadcaster = next;
}

/** 工作区存储的进程内共享实例（按归一化 cwd 一份，磁盘状态跨会话存续）。 */
export function getWorkspaceDiffApprovalStore(
	agentDir: string,
	cwd: string,
	options?: { maxFileBytes?: number },
): DiffApprovalStore {
	const normalized = resolve(cwd);
	const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
	let store = stores.get(key);
	if (!store) {
		store = new DiffApprovalStore({
			filePath: diffApprovalStorePath(agentDir, normalized),
			workspaceDir: normalized,
			maxFileBytes: options?.maxFileBytes ?? DIFF_APPROVAL_DEFAULT_MAX_FILE_BYTES,
		});
		store.onChanged = () => notifyDiffApprovalChanged(normalized);
		store.load();
		stores.set(key, store);
	}
	return store;
}

/** 向桌面 UI 推送某工作区的待审清单已变化（无桥/非桌面模式为 no-op）。 */
export function notifyDiffApprovalChanged(cwd: string): void {
	broadcaster?.({ type: "diffApproval.changed", cwd: resolve(cwd) });
}
