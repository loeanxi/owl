/**
 * 浏览器不可逆动作的识别。
 *
 * 页面上「支付」「删除」「发布」这类按钮一旦点下去就是对外部可见、常常不可撤销的
 * 动作。owl 的审批模式是会话级的三分（auto / confirm / plan）：
 *
 * - auto 是用户明确把裁量权交给 agent，因此**不再额外弹窗**——这类动作靠技能里的
 *   纪律让模型自己判断要不要先问用户；
 * - confirm 本来就会逐次询问，这里只补上目标名，让弹窗写清「要点的是什么」；
 * - plan 直接挡掉写类调用。
 *
 * 判定只覆盖点击类工具：填写、勾选、下拉本身不改外部状态，真正的提交动作是那次点击。
 * 名字判不出高危时返回 undefined，不乱拦——宁可漏判也不误报。
 */

import type { BrowserHub } from "./browser-hub.ts";

export interface BrowserActionTarget {
	ref?: number;
	selector?: string;
}

export interface IrreversibleBrowserAction {
	/** 命中的动作类别，给用户看「这是哪一类不可逆动作」。 */
	kind: string;
	/** 目标控件的可访问名。 */
	targetName: string;
}

/**
 * 强命中：控件名里出现即判定为不可逆动作。
 *
 * 覆盖资金变动、不可逆删除、对外发布与账号权限变更。
 *
 * 「提交」「发送」「移除」这类弱词**不**在这里判：页面里太常见（提交查询条件、
 * 发送验证码、购物车移除商品），实测一个普通「提交」按钮就误触了确认弹窗。
 */
const STRONG_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
	{ kind: "支付", pattern: /支付|付款|打款|扣款|充值|续费|结算/ },
	{ kind: "转账", pattern: /转账|汇款|提现/ },
	{ kind: "购买", pattern: /购买|立即购买|下单|提交订单/ },
	{ kind: "订阅", pattern: /订阅|退订/ },
	{ kind: "删除", pattern: /删除|销毁|清空/ },
	{ kind: "移除", pattern: /注销|吊销|解绑/ },
	{ kind: "发布", pattern: /发布|发表|投递/ },
	{ kind: "授权", pattern: /授权|开通|激活/ },
	{
		kind: "不可逆操作",
		pattern:
			/\b(?:pay|purchase|checkout|delete|destroy|publish|transfer|withdraw|subscribe|unsubscribe|revoke|authorize)\b/i,
	},
];

export function matchIrreversibleActionName(name: string): string | undefined {
	const label = name.trim();
	if (label === "") return undefined;
	for (const { kind, pattern } of STRONG_PATTERNS) {
		if (pattern.test(label)) return kind;
	}
	return undefined;
}

/** 会触发对外可见动作的工具：只有点击类。 */
export function isIrreversibleBrowserTool(toolName: string): boolean {
	return toolName === "browser_click" || toolName === "browser_click_and_wait";
}

function readTarget(input: unknown): BrowserActionTarget | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	const ref = typeof record.ref === "number" && Number.isFinite(record.ref) ? record.ref : undefined;
	const selector = typeof record.selector === "string" && record.selector !== "" ? record.selector : undefined;
	if (ref === undefined && selector === undefined) return undefined;
	return { ref, selector };
}

/**
 * 判断这次工具调用是否要点在不可逆动作上。
 *
 * 目标解析不出来（页面正在导航、ref 已失效）时返回 undefined：此时无法判断点的
 * 是什么，交给技能里的「不可逆动作前先确认」纪律兜底，不在这里乱拦。
 */
export async function describeIrreversibleBrowserAction(
	hub: BrowserHub,
	sessionId: string,
	toolName: string,
	input: unknown,
): Promise<IrreversibleBrowserAction | undefined> {
	if (!isIrreversibleBrowserTool(toolName)) return undefined;
	const target = readTarget(input);
	if (!target) return undefined;
	const pageId = input !== null && typeof input === "object" ? (input as Record<string, unknown>).pageId : undefined;
	const described = await hub.describeTarget(
		sessionId,
		typeof pageId === "string" && pageId !== "" ? pageId : undefined,
		target,
	);
	const name = described?.name;
	if (!name) return undefined;
	const kind = matchIrreversibleActionName(name);
	return kind ? { kind, targetName: name.trim() } : undefined;
}
