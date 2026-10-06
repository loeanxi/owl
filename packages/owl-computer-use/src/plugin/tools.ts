/**
 * computer-use 的六个模型工具（owl ToolDefinition 版）。
 *
 * 工具层只做三件事：参数校验与归一化、组合键解析与高危键拦截、把结果组装
 * 成 content（截图返回 image block + 坐标元数据文本）。真正的截屏/注入在
 * PowerShell 侧车内核里，坐标换算在 ComputerDriverSession 里。
 *
 * 坐标系约定（写进每个工具的 promptSnippet 与截图返回文本）：click/scroll
 * 的 x,y 是**最近一张 computer_screenshot 截图的像素坐标**；模型必须先截图
 * 再操作、操作后再截图确认。
 * @module owl-computer-use/plugin/tools
 */
import type { ToolDefinition } from "@owl/owl-coding-agent";
import { Type } from "typebox";
import type { ClickButton, ComputerDriverSession } from "../driver/session.ts";

/** 默认截图缩放上限宽（px）。Claude/GPT 系视觉模型在 ~1500px 宽的截图上坐标定位最稳。 */
export const DEFAULT_MAX_IMAGE_WIDTH = 1568;
const JPEG_QUALITY = 80;

export interface ComputerUseSettings {
	enabled?: boolean;
	maxImageWidth?: number;
}

// ---------------------------------------------------------------------------
// 组合键解析：'ctrl+shift+s' → { down:[VK_CONTROL, VK_SHIFT], tap:[VK_S] }
// ---------------------------------------------------------------------------

const VK: Record<string, number> = {
	// 修饰键（只出现在组合前缀里）
	ctrl: 0x11,
	control: 0x11,
	alt: 0x12,
	shift: 0x10,
	win: 0x5b,
	meta: 0x5b,
	cmd: 0x5b,
	// 功能键
	esc: 0x1b,
	escape: 0x1b,
	enter: 0x0d,
	return: 0x0d,
	tab: 0x09,
	space: 0x20,
	backspace: 0x08,
	delete: 0x2e,
	del: 0x2e,
	insert: 0x2d,
	ins: 0x2d,
	home: 0x24,
	end: 0x23,
	pageup: 0x21,
	pgup: 0x21,
	pagedown: 0x22,
	pgdn: 0x22,
	up: 0x26,
	down: 0x28,
	left: 0x25,
	right: 0x27,
	arrowup: 0x26,
	arrowdown: 0x28,
	arrowleft: 0x25,
	arrowright: 0x27,
	printscreen: 0x2c,
	prtsc: 0x2c,
	capslock: 0x14,
	numlock: 0x90,
	menu: 0x5d,
	apps: 0x5d,
	// 媒体键
	volumeup: 0xaf,
	volumedown: 0xae,
	volumemute: 0xad,
	medianext: 0xb0,
	mediaprev: 0xb1,
	mediaplay: 0xb3,
	mediastop: 0xb2,
	// US 键盘标点（VK_OEM_*）
	";": 0xba,
	"=": 0xbb,
	",": 0xbc,
	"-": 0xbd,
	".": 0xbe,
	"/": 0xbf,
	"`": 0xc0,
	"[": 0xdb,
	"\\": 0xdc,
	"]": 0xdd,
	"'": 0xde,
};

const MODIFIER_NAMES = new Set(["ctrl", "control", "alt", "shift", "win", "meta", "cmd"]);

/** 绝对拒绝注入的组合：锁屏与 SAS（后者系统本来也不放行，显式拒绝防误试）。 */
const BLOCKED_COMBOS: ReadonlySet<string> = new Set(["win+l", "meta+l", "cmd+l", "ctrl+alt+delete", "ctrl+alt+del"]);

export interface KeyStroke {
	/** 按住不放的修饰键 VK 序列（按下顺序）。 */
	down: number[];
	/** 依次敲击的 VK 序列。 */
	tap: number[];
}

export function parseKeyCombo(combo: string): KeyStroke {
	const normalized = combo.trim().toLowerCase().replace(/\s+/g, "");
	if (normalized === "") throw new Error("Empty key combo.");
	if (BLOCKED_COMBOS.has(normalized))
		throw new Error(`Blocked key combo: "${combo}" (system-level lock/security keys are not injectable).`);

	const parts = normalized.split("+").filter((part) => part !== "");
	if (parts.length === 0) {
		// 组合就是单独一个 "+"。
		parts.push("+");
	}
	const down: number[] = [];
	const tap: number[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		let vk: number | undefined;
		if (part.length === 1) {
			const lower = part;
			const upper = part.toUpperCase();
			const upperCode = upper.charCodeAt(0);
			if (VK[lower] !== undefined) vk = VK[lower];
			else if (upperCode >= 0x41 && upperCode <= 0x5a)
				vk = upperCode; // A-Z
			else if (upperCode >= 0x30 && upperCode <= 0x39) vk = upperCode; // 0-9
		} else if (/^f([1-9]|1\d|2[0-4])$/.test(part)) {
			vk = 0x6f + Number(part.slice(1)); // F1=0x70
		} else {
			vk = VK[part];
		}
		if (vk === undefined) throw new Error(`Unknown key name: "${part}" in combo "${combo}".`);
		if (i < parts.length - 1 && MODIFIER_NAMES.has(part)) down.push(vk);
		else tap.push(vk);
	}
	if (tap.length === 0) {
		// 只写了修饰键（如 "win"）：视为敲击该键本身。
		tap.push(...down.splice(0));
	}
	return { down, tap };
}

// ---------------------------------------------------------------------------
// 参数 schema
// ---------------------------------------------------------------------------

const ScreenshotParams = Type.Object({
	target: Type.Union([Type.Literal("primary"), Type.Literal("all"), Type.Literal("monitor")], {
		description:
			"Which screen area to capture. 'primary' = main monitor (recommended), 'all' = the whole virtual desktop spanning every monitor, 'monitor' = a specific monitor by index (0-based).",
	}),
	monitorIndex: Type.Optional(
		Type.Number({ description: "Only when target is 'monitor'; 0-based index in system monitor order." }),
	),
});

const ClickParams = Type.Object({
	x: Type.Number({ description: "X coordinate in the LAST computer_screenshot image's pixel space." }),
	y: Type.Number({ description: "Y coordinate in the LAST computer_screenshot image's pixel space." }),
	button: Type.Optional(
		Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
			description: "Mouse button; default left.",
		}),
	),
	double: Type.Optional(Type.Boolean({ description: "Double-click; default false." })),
	expectHwnd: Type.Optional(
		Type.Number({
			description:
				"Safety guard: hwnd of the window you intend to click (from computer_windows or a previous click result). If another window is on top at that point, the click is NOT injected and the actual window is returned. Use it whenever the target window is known.",
		}),
	),
});

const TypeParams = Type.Object({
	text: Type.String({
		description:
			"Text to type into the currently focused window. Use \\n for Enter. For key shortcuts use computer_key instead.",
	}),
	expectHwnd: Type.Optional(
		Type.Number({
			description:
				"Safety guard: hwnd of the window that should have keyboard focus. If the foreground window differs, NOTHING is typed (stray keystrokes can trigger shortcuts in other apps).",
		}),
	),
});

const KeyParams = Type.Object({
	combo: Type.String({
		description:
			"A single key or combo, e.g. 'enter', 'esc', 'ctrl+s', 'alt+tab', 'ctrl+shift+esc', 'win', 'f5'. One combo per call; modifiers: ctrl/alt/shift/win.",
	}),
	expectHwnd: Type.Optional(
		Type.Number({
			description:
				"Safety guard: hwnd of the window that should receive the keystroke; refused if the foreground window differs.",
		}),
	),
});

const ScrollParams = Type.Object({
	x: Type.Number({
		description: "X coordinate in the LAST computer_screenshot image's pixel space (scroll position).",
	}),
	y: Type.Number({
		description: "Y coordinate in the LAST computer_screenshot image's pixel space (scroll position).",
	}),
	direction: Type.Optional(
		Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")], {
			description: "Scroll direction; default down.",
		}),
	),
	amount: Type.Optional(Type.Number({ description: "Wheel notches (3 ≈ one typical page step); default 3." })),
	expectHwnd: Type.Optional(
		Type.Number({
			description: "Safety guard: hwnd of the window expected under the scroll point; refused otherwise.",
		}),
	),
});

const WindowsParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("focus"), Type.Literal("restore")], {
		description: "'list' enumerates windows; 'focus' brings one to the foreground; 'restore' un-minimizes it.",
	}),
	hwnd: Type.Optional(
		Type.Number({ description: "Target window handle from a previous 'list' (for focus/restore)." }),
	),
	title: Type.Optional(
		Type.String({ description: "Case-insensitive substring of the window title (fallback when hwnd is not given)." }),
	),
});

// ---------------------------------------------------------------------------
// 工具工厂
// ---------------------------------------------------------------------------

export function createScreenshotTool(
	session: ComputerDriverSession,
	options: { maxImageWidth?: number } = {},
): ToolDefinition<typeof ScreenshotParams, undefined> {
	const maxImageWidth = options.maxImageWidth ?? DEFAULT_MAX_IMAGE_WIDTH;
	return {
		name: "computer_screenshot",
		label: "屏幕截图",
		description:
			"Take a screenshot of this Windows desktop and return it as an image. Call this BEFORE any mouse/keyboard action to see the screen, and again AFTER acting to verify the result. Coordinates for computer_click/computer_scroll are pixel positions in this image.",
		promptSnippet: "computer_screenshot: 截屏并返回图片（操作的坐标依据，先截后动、动后再截确认）",
		promptGuidelines: [
			"computer_click/computer_scroll 的 x,y 是最近一张 computer_screenshot 截图里的像素坐标；窗口移动或页面变化后必须重新截图再取坐标。",
			"目标窗口已知时给 click/type/key/scroll 带 expectHwnd（computer_windows 列表或上次 clickedWindow.hwnd）：被别的窗口挡住/前台被抢时会拒绝注入并返回实际窗口，而不是误触。",
		],
		parameters: ScreenshotParams,
		annotations: { readOnlyHint: true },
		execute: async (_toolCallId, params, signal) => {
			const monitor =
				params.target === "all"
					? -2
					: params.target === "monitor"
						? Math.max(0, Math.trunc(params.monitorIndex ?? 0))
						: -1;
			const shot = await session.screenshot(monitor, maxImageWidth, JPEG_QUALITY, signal);
			const meta = {
				imageWidth: shot.imageWidth,
				imageHeight: shot.imageHeight,
				screenWidth: shot.screenWidth,
				screenHeight: shot.screenHeight,
				originX: shot.originX,
				originY: shot.originY,
				note: "computer_click / computer_scroll 的 x,y 以这张截图的像素为坐标系。",
			};
			return {
				content: [
					{ type: "text", text: JSON.stringify(meta) },
					{ type: "image", data: shot.jpeg, mimeType: "image/jpeg" },
				],
				details: undefined,
			};
		},
	};
}

export function createClickTool(session: ComputerDriverSession): ToolDefinition<typeof ClickParams, undefined> {
	return {
		name: "computer_click",
		label: "鼠标点击",
		description:
			"Move the mouse and click at a position given in the LAST computer_screenshot image's pixel coordinates. Take a fresh screenshot first whenever the screen may have changed.",
		promptSnippet: "computer_click: 按最近截图的像素坐标移动并点击鼠标",
		parameters: ClickParams,
		annotations: { readOnlyHint: false },
		execute: async (_toolCallId, params, signal) => {
			const button: ClickButton = params.button ?? "left";
			const result = await session.click(
				params.x,
				params.y,
				button,
				params.double === true,
				signal,
				params.expectHwnd,
			);
			return {
				content: [
					{
						type: "text",
						text:
							JSON.stringify(result) +
							// 命中窗口直接点名：模型据此发现「点到了别的窗口」并重截/重聚焦。
							(result.window ? `\nclickedWindow: ${result.window.process} 「${result.window.title}」` : ""),
					},
				],
				details: undefined,
			};
		},
	};
}

export function createTypeTool(session: ComputerDriverSession): ToolDefinition<typeof TypeParams, undefined> {
	return {
		name: "computer_type",
		label: "键盘输入",
		description:
			"Type text into the currently focused window as real keystrokes (Unicode). Click the target field first (computer_click) if the window is not focused; use computer_windows to focus a window, computer_key for shortcuts.",
		promptSnippet: "computer_type: 向当前焦点窗口键入文本",
		parameters: TypeParams,
		annotations: { readOnlyHint: false },
		execute: async (_toolCallId, params, signal) => {
			const result = await session.type(params.text, signal, params.expectHwnd);
			return {
				content: [
					{
						type: "text",
						text:
							JSON.stringify({ typed: result.blocked !== true, length: params.text.length }) +
							(result.foreground
								? `\nforegroundWindow: ${result.foreground.process} 「${result.foreground.title}」`
								: ""),
					},
				],
				details: undefined,
			};
		},
	};
}

export function createKeyTool(session: ComputerDriverSession): ToolDefinition<typeof KeyParams, undefined> {
	return {
		name: "computer_key",
		label: "按键/快捷键",
		description:
			"Press a single key or a shortcut combo (real keystrokes into the focused window): 'enter', 'esc', 'tab', 'ctrl+s', 'alt+f4', 'ctrl+shift+esc', 'win', 'f5'. One combo per call.",
		promptSnippet: "computer_key: 向当前焦点窗口发送单个按键或组合键",
		parameters: KeyParams,
		annotations: { readOnlyHint: false },
		execute: async (_toolCallId, params, signal) => {
			const stroke = parseKeyCombo(params.combo);
			const result = await session.key(stroke.down, stroke.tap, signal, params.expectHwnd);
			return {
				content: [
					{
						type: "text",
						text:
							JSON.stringify({ sent: result.blocked !== true, combo: params.combo.trim() }) +
							(result.foreground
								? `\nforegroundWindow: ${result.foreground.process} 「${result.foreground.title}」`
								: ""),
					},
				],
				details: undefined,
			};
		},
	};
}

export function createScrollTool(session: ComputerDriverSession): ToolDefinition<typeof ScrollParams, undefined> {
	return {
		name: "computer_scroll",
		label: "滚轮滚动",
		description:
			"Scroll the mouse wheel at a position given in the LAST computer_screenshot image's pixel coordinates. 'up'/'down' scroll vertically, 'left'/'right' horizontally.",
		promptSnippet: "computer_scroll: 在最近截图的像素坐标处滚动滚轮",
		parameters: ScrollParams,
		annotations: { readOnlyHint: false },
		execute: async (_toolCallId, params, signal) => {
			const direction = params.direction ?? "down";
			const amount = normalizeAmount(params.amount);
			const notches = direction === "up" || direction === "right" ? amount : -amount;
			const result = await session.scroll(
				params.x,
				params.y,
				notches * 120,
				direction === "left" || direction === "right",
				signal,
				params.expectHwnd,
			);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ scrolled: result.blocked === true ? false : direction, amount }),
					},
				],
				details: undefined,
			};
		},
	};
}

export function createWindowsTool(session: ComputerDriverSession): ToolDefinition<typeof WindowsParams, undefined> {
	return {
		name: "computer_windows",
		label: "窗口管理",
		description:
			"List visible top-level windows (returns hwnd, title, process, rect, minimized/foreground flags), or bring a window to the foreground ('focus'), or un-minimize it ('restore') so you can screenshot and interact with it.",
		promptSnippet: "computer_windows: 枚举/聚焦/恢复桌面窗口（输入前先 focus 目标窗口）",
		parameters: WindowsParams,
		annotations: { readOnlyHint: false },
		execute: async (_toolCallId, params, signal) => {
			if (params.action === "list") {
				const windows = await session.windows(signal);
				return { content: [{ type: "text", text: JSON.stringify({ windows }) }], details: undefined };
			}
			const hwnd = await resolveHwnd(session, params.hwnd, params.title, signal);
			const ok = params.action === "focus" ? await session.focus(hwnd, signal) : await session.restore(hwnd, signal);
			return {
				content: [{ type: "text", text: JSON.stringify({ action: params.action, hwnd, ok }) }],
				details: undefined,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

async function resolveHwnd(
	session: ComputerDriverSession,
	hwnd: number | undefined,
	title: string | undefined,
	signal: AbortSignal | undefined,
): Promise<number> {
	if (hwnd !== undefined && Number.isFinite(hwnd) && hwnd > 0) return Math.trunc(hwnd);
	const needle = title?.trim().toLowerCase();
	if (needle === undefined || needle === "") {
		throw new Error("computer_windows focus/restore requires 'hwnd' (from a previous list) or a 'title' substring.");
	}
	const windows = await session.windows(signal);
	const matches = windows.filter((row) => row.title.toLowerCase().includes(needle));
	if (matches.length === 0) {
		throw new Error(`No visible window title contains "${title}". Call computer_windows with action 'list' first.`);
	}
	// 前台优先，其次完全匹配，再次标题最长（信息量最大的匹配）。
	matches.sort((a, b) => {
		if (a.foreground !== b.foreground) return a.foreground ? -1 : 1;
		const exactA = a.title.toLowerCase() === needle ? 0 : 1;
		const exactB = b.title.toLowerCase() === needle ? 0 : 1;
		if (exactA !== exactB) return exactA - exactB;
		return b.title.length - a.title.length;
	});
	return matches[0].hwnd;
}

function normalizeAmount(amount: number | undefined): number {
	if (amount === undefined) return 3;
	if (!Number.isFinite(amount) || amount < 1) return 1;
	return Math.min(10, Math.trunc(amount));
}
