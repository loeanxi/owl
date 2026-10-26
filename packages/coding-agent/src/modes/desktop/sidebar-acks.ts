/**
 * 侧栏请求回执队列 —— 让「模型说已打开」变成「界面确认已打开」。
 *
 * 模型侧发起侧栏请求前先登记 requestId，桌面端处理完回一条回执，本队列把回执
 * 交回等待中的工具调用。没有界面连着、界面版本对不上等情况收不到回执，由超时
 * 兜底结算成 timeout —— 工具据此如实告诉模型「用户没看到」，不再盲报成功。
 */
import type { SidebarFocusState } from "./protocol.ts";

/** 侧栏动作的送达结果：timeout 是桥侧兜底（UI 没回），UI 自己只回前三种。 */
export type SidebarShowAckStatus = "delivered" | "ignored" | "failed" | "timeout";

export interface SidebarShowAck {
	status: SidebarShowAckStatus;
	/** 失败或忽略的原因（给模型看的简短说明）。 */
	detail?: string;
}

/** 侧栏焦点快照的答案：界面给了 state，或说明为什么没有。 */
export interface SidebarContextAck {
	/** 界面此刻的焦点快照（没有就 undefined）。 */
	state?: SidebarFocusState;
	/** 没有快照的原因（给模型看的简短说明）。 */
	detail?: string;
}

interface PendingAck<T> {
	resolve: (ack: T) => void;
	timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 4000;

export class SidebarAckQueue<T> {
	private readonly pending = new Map<string, PendingAck<T>>();
	private readonly timeoutMs: number;

	constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
		this.timeoutMs = timeoutMs;
	}

	/**
	 * 登记一次等待。UI 回执或超时都会兑现这个 promise（只兑现一次）。
	 * 必须在广播之前调用：UI 可能瞬间回执，晚登记会漏掉这次回执。
	 */
	wait(requestId: string, timeoutAck: T): Promise<T> {
		return new Promise((resolve) => {
			const entry: PendingAck<T> = { resolve };
			if (this.timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					this.resolve(requestId, timeoutAck);
				}, this.timeoutMs);
			}
			this.pending.set(requestId, entry);
		});
	}

	/** UI 回执到达：唤醒等待者。requestId 不认识时返回 false（重复回执 / 过期回执）。 */
	resolve(requestId: string, ack: T): boolean {
		const entry = this.pending.get(requestId);
		if (entry === undefined) return false;
		this.pending.delete(requestId);
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.resolve(ack);
		return true;
	}

	/** 桥关闭 / 会话结束：挂起的等待全部结算，不留悬挂 promise。 */
	cancelAll(fallback: T): void {
		for (const requestId of [...this.pending.keys()]) {
			this.resolve(requestId, fallback);
		}
	}

	/** 当前挂起的等待数（诊断用）。 */
	get size(): number {
		return this.pending.size;
	}
}
