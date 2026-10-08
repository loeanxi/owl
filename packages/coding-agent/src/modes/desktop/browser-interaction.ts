import type { Locator, Page } from "playwright-core";
import pw from "playwright-core";

export interface BrowserTarget {
	ref?: number;
	selector?: string;
}

export interface BrowserClickOptions {
	button?: "left" | "right" | "middle";
	clickCount?: number;
}

export interface BrowserFillResult {
	verified: true;
	characters: number;
	redacted: boolean;
}

export interface BrowserSelectResult {
	verified: true;
	values: string[];
}

interface ControlState {
	kind: "input" | "textarea" | "contenteditable" | "other";
	inputType: string;
	disabled: boolean;
	readOnly: boolean;
	value: string;
	password: boolean;
}

// Browser-side structural types keep this Node package independent of the DOM lib.
interface BrowserElement {
	tagName: string;
	type?: string;
	readOnly?: boolean;
	isContentEditable: boolean;
	innerText: string;
	value?: string;
	multiple?: boolean;
	options?: ArrayLike<BrowserOption>;
	selectedOptions?: ArrayLike<BrowserOption>;
	ownerDocument: { activeElement: unknown };
	matches(selector: string): boolean;
	closest(selector: string): unknown;
	getAttribute(name: string): string | null;
}

interface BrowserOption {
	value: string;
	disabled: boolean;
	closest(selector: string): unknown;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const VERIFY_POLL_MS = 50;
const VERIFY_STABLE_MS = 200;
const NON_EDITABLE_INPUT_TYPES = new Set([
	"checkbox",
	"radio",
	"button",
	"submit",
	"reset",
	"file",
	"hidden",
	"image",
	"range",
	"color",
]);
let selectorRegistration: Promise<void> | undefined;

/** Register before BrowserHub creates its first page. Keep refs in the page's main world. */
export function initializeBrowserInteraction(): Promise<void> {
	selectorRegistration ??= pw.selectors.register(
		"owl_ref",
		`(() => {
			const resolve = (root, selector) => {
				const el = window.__owlRefs?.map.get(Number(selector));
				return el && el.isConnected && root.contains(el) ? el : null;
			};
			return {
				query: resolve,
				queryAll: (root, selector) => { const el = resolve(root, selector); return el ? [el] : []; },
			};
		})()`,
		{ contentScript: false },
	);
	return selectorRegistration;
}

/** Locator actions retain Playwright's visibility, enabled, stability and hit-target checks. */
export class BrowserInteraction {
	private readonly page: Page;
	private readonly timeoutMs: number;

	constructor(page: Page, options: { timeoutMs?: number } = {}) {
		this.page = page;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 30_000) {
			throw new Error("操作超时必须在 1–30000 毫秒之间。");
		}
	}

	async click(target: BrowserTarget, options: BrowserClickOptions = {}): Promise<void> {
		const button = options.button ?? "left";
		const clickCount = options.clickCount ?? 1;
		if (!["left", "right", "middle"].includes(button)) throw new Error("button 必须是 left、right 或 middle。");
		if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) {
			throw new Error("clickCount 必须是 1、2 或 3。");
		}
		await this.act(target, "点击", async (locator) => {
			await locator.click({ button, clickCount, timeout: this.timeoutMs });
		});
	}

	async fill(target: BrowserTarget, text: string, options: { append?: boolean } = {}): Promise<BrowserFillResult> {
		return this.act(target, "输入", async (locator) => {
			const state = await locator.evaluate(
				(element): ControlState => {
					const el = element as unknown as BrowserElement;
					return {
						kind:
							el.tagName === "INPUT"
								? "input"
								: el.tagName === "TEXTAREA"
									? "textarea"
									: el.isContentEditable
										? "contenteditable"
										: "other",
						inputType: el.tagName === "INPUT" ? (el.type ?? "text") : "",
						disabled: el.matches(":disabled") || !!el.closest('[aria-disabled="true"]'),
						readOnly: !!el.readOnly || el.getAttribute("aria-readonly") === "true",
						value: el.isContentEditable ? el.innerText : String(el.value ?? ""),
						password: el.tagName === "INPUT" && el.type === "password",
					};
				},
				undefined,
				{ timeout: this.timeoutMs },
			);
			if (state.disabled) throw new InteractionError("目标已禁用，不能输入。");
			if (state.readOnly) throw new InteractionError("目标是只读字段，不能输入。");
			if (state.kind === "other" || (state.kind === "input" && NON_EDITABLE_INPUT_TYPES.has(state.inputType))) {
				throw new InteractionError("目标不可编辑；请选择 input、textarea 或 contenteditable 元素。");
			}
			const expected = options.append ? state.value + text : text;
			const dateInput = state.kind === "input" && state.inputType === "date";
			if (dateInput && options.append && state.value && text) {
				throw new InteractionError(
					"日期字段已有值，不能追加文本；请用 browser_fill 或 browser_type clear=true 替换完整 YYYY-MM-DD 日期。",
				);
			}
			if (dateInput && expected && !/^\d{4,}-\d{2}-\d{2}$/.test(expected)) {
				throw new InteractionError(
					"日期字段需要完整 YYYY-MM-DD 格式；请用 browser_fill 或 browser_type clear=true 填写。",
				);
			}
			if (options.append && !dateInput) {
				await locator.click({ timeout: this.timeoutMs });
				await locator.press("ControlOrMeta+End", { timeout: this.timeoutMs });
				await locator.pressSequentially(text, { timeout: this.timeoutMs });
			} else {
				// Native date controls edit separate year/month/day segments; sequential typing cannot
				// reliably enter the full ISO value even when the field starts empty.
				await locator.fill(expected, { timeout: this.timeoutMs });
			}
			const actual = await this.verify(
				() =>
					locator.evaluate(
						(element) => {
							const el = element as unknown as BrowserElement;
							return el.isContentEditable ? el.innerText : String(el.value ?? "");
						},
						undefined,
						{ timeout: this.timeoutMs },
					),
				(value) => value.replace(/\r\n/g, "\n") === expected.replace(/\r\n/g, "\n"),
				"输入后的读回校验失败；页面可能限制长度、格式化内容或拒绝了输入，请重新观察字段。",
			);
			return { verified: true, characters: actual.length, redacted: state.password };
		});
	}

	/** Preflight a bulk field without changing the page. Each action still checks again when executed. */
	async validateFormTarget(
		target: BrowserTarget,
		kind: "fill" | "select" | "check",
		checked?: boolean,
	): Promise<void> {
		await this.act(target, "检查表单目标", async (locator) => {
			const state = await locator.evaluate(
				(element) => {
					const el = element as unknown as BrowserElement;
					return {
						tag: el.tagName,
						type: el.type ?? "text",
						editable: el.isContentEditable,
						disabled: el.matches(":disabled") || !!el.closest('[aria-disabled="true"]'),
						readOnly: !!el.readOnly || el.getAttribute("aria-readonly") === "true",
					};
				},
				undefined,
				{ timeout: this.timeoutMs },
			);
			if (state.disabled || state.readOnly || !(await locator.isVisible()))
				throw new InteractionError("表单目标隐藏、禁用或只读，不能修改。");
			const valid =
				kind === "select"
					? state.tag === "SELECT"
					: kind === "check"
						? state.tag === "INPUT" && ["checkbox", "radio"].includes(state.type)
						: state.editable ||
							state.tag === "TEXTAREA" ||
							(state.tag === "INPUT" && !NON_EDITABLE_INPUT_TYPES.has(state.type));
			if (!valid) throw new InteractionError(`表单目标的控件类型不支持 kind=${kind}。`);
			if (kind === "check" && state.type === "radio" && checked === false)
				throw new InteractionError("radio 不能单独取消；请将同组的目标 radio 设为 checked=true。");
		});
	}

	async setChecked(target: BrowserTarget, checked: boolean): Promise<{ verified: true; checked: boolean }> {
		await this.validateFormTarget(target, "check", checked);
		return this.act(target, "设置选中状态", async (locator) => {
			await locator.setChecked(checked, { timeout: this.timeoutMs });
			const actual = await this.verify(
				() => locator.isChecked({ timeout: this.timeoutMs }),
				(value) => value === checked,
				"选中状态读回校验失败；页面可能重置了选择，请重新观察。",
			);
			return { verified: true, checked: actual };
		});
	}

	/** Read the final form state without repeating actions or emitting change events. */
	async verifyFormField(target: BrowserTarget, expected: string | string[] | boolean): Promise<void> {
		await this.act(target, "验收表单状态", async (locator) => {
			const read: () => Promise<unknown> =
				typeof expected === "boolean"
					? () => locator.isChecked({ timeout: this.timeoutMs })
					: Array.isArray(expected)
						? () =>
								locator.evaluate(
									(element) =>
										Array.from((element as unknown as BrowserElement).selectedOptions ?? []).map(
											(option) => option.value,
										),
									undefined,
									{ timeout: this.timeoutMs },
								)
						: () =>
								locator.evaluate(
									(element) => {
										const el = element as unknown as BrowserElement;
										return el.isContentEditable ? el.innerText : String(el.value ?? "");
									},
									undefined,
									{ timeout: this.timeoutMs },
								);
			await this.verify(
				read,
				(value) =>
					typeof expected === "string"
						? typeof value === "string" && value.replace(/\r\n/g, "\n") === expected.replace(/\r\n/g, "\n")
						: Array.isArray(expected)
							? Array.isArray(value) &&
								JSON.stringify([...new Set(value)].sort()) === JSON.stringify([...new Set(expected)].sort())
							: value === expected,
				"表单最终读回校验失败；后续操作可能重置了已填字段，请重新观察。",
			);
		});
	}

	async selectOptions(target: BrowserTarget, values: string[]): Promise<BrowserSelectResult> {
		return this.act(target, "选择选项", async (locator) => {
			const state = await locator.evaluate(
				(element) => {
					const el = element as unknown as BrowserElement;
					return {
						isSelect: el.tagName === "SELECT",
						disabled: el.matches(":disabled") || !!el.closest('[aria-disabled="true"]'),
						multiple: !!el.multiple,
						options: Array.from(el.options ?? []).map((option) => ({
							value: option.value,
							disabled: option.disabled || !!option.closest("optgroup[disabled]"),
						})),
					};
				},
				undefined,
				{ timeout: this.timeoutMs },
			);
			if (!state.isSelect) throw new InteractionError("目标不是原生 select；自定义下拉请点击展开后选择实际选项。");
			if (state.disabled) throw new InteractionError("下拉框已禁用，不能选择。");
			const uniqueValues = [...new Set(values)];
			if (!state.multiple && uniqueValues.length > 1) throw new InteractionError("该下拉框只允许单选。");
			for (const value of uniqueValues) {
				const option = state.options.find((candidate) => candidate.value === value);
				if (!option) throw new InteractionError("指定的 option value 不存在，请重新观察下拉选项。");
				if (option.disabled) throw new InteractionError("指定的下拉选项已禁用。");
			}
			await locator.selectOption(
				uniqueValues.map((value) => ({ value })),
				{ timeout: this.timeoutMs },
			);
			const actual = await this.verify(
				() =>
					locator.evaluate(
						(element) => {
							const el = element as unknown as BrowserElement;
							return Array.from(el.selectedOptions ?? []).map((option) => option.value);
						},
						undefined,
						{ timeout: this.timeoutMs },
					),
				(value) => JSON.stringify([...value].sort()) === JSON.stringify([...uniqueValues].sort()),
				"选中值读回校验失败；页面可能重置了选择，请重新观察下拉框。",
			);
			return { verified: true, values: actual };
		});
	}

	async hover(target: BrowserTarget): Promise<void> {
		await this.act(target, "悬停", async (locator) => {
			await locator.hover({ timeout: this.timeoutMs });
		});
	}

	async focus(target: BrowserTarget): Promise<void> {
		await this.act(target, "聚焦", async (locator) => {
			await locator.waitFor({ state: "visible", timeout: this.timeoutMs });
			if (!(await locator.isEnabled({ timeout: this.timeoutMs })))
				throw new InteractionError("目标已禁用，不能聚焦。");
			await locator.focus({ timeout: this.timeoutMs });
			if (
				!(await locator.evaluate(
					(element) => {
						const el = element as unknown as BrowserElement;
						return el === el.ownerDocument.activeElement;
					},
					undefined,
					{ timeout: this.timeoutMs },
				))
			) {
				throw new InteractionError("目标未获得焦点；该元素可能不支持聚焦。");
			}
		});
	}

	async blur(target: BrowserTarget): Promise<void> {
		await this.act(target, "取消焦点", async (locator) => {
			await locator.blur({ timeout: this.timeoutMs });
			if (
				await locator.evaluate(
					(element) => {
						const el = element as unknown as BrowserElement;
						return el === el.ownerDocument.activeElement;
					},
					undefined,
					{ timeout: this.timeoutMs },
				)
			) {
				throw new InteractionError("页面阻止了焦点离开，请重新观察当前焦点。");
			}
		});
	}

	async scrollIntoView(target: BrowserTarget): Promise<void> {
		await this.act(target, "滚动到元素", async (locator) => {
			await locator.scrollIntoViewIfNeeded({ timeout: this.timeoutMs });
		});
	}

	async scroll(target: BrowserTarget, options: { deltaX?: number; deltaY: number }): Promise<void> {
		const deltaX = options.deltaX ?? 0;
		if (
			!Number.isFinite(deltaX) ||
			!Number.isFinite(options.deltaY) ||
			Math.abs(deltaX) > 100_000 ||
			Math.abs(options.deltaY) > 100_000
		) {
			throw new Error("滚动距离必须是有限数字，且每个方向不超过 100000 像素。");
		}
		await this.act(target, "滚动指定区域", async (locator) => {
			await locator.hover({ timeout: this.timeoutMs });
			await this.page.mouse.wheel(deltaX, options.deltaY);
		});
	}

	private async resolve(target: BrowserTarget): Promise<Locator> {
		const hasRef = target.ref !== undefined;
		const hasSelector = target.selector !== undefined;
		if (hasRef === hasSelector)
			throw new InteractionError(
				"必须且只能提供 ref（快照中的正整数）或 selector（唯一 CSS 选择器）其中一个，请使用这两个准确的字段名。",
			);
		let locator: Locator;
		if (hasRef) {
			if (!Number.isSafeInteger(target.ref) || (target.ref ?? 0) < 1)
				throw new InteractionError("ref 必须是正整数。");
			await initializeBrowserInteraction();
			locator = this.page.locator(`owl_ref=${target.ref}`);
		} else {
			const selector = target.selector?.trim();
			if (!selector) throw new InteractionError("selector 不能为空。");
			locator = this.page.locator(`css=${selector}`);
		}
		let count: number;
		try {
			count = await locator.count();
		} catch {
			throw new InteractionError("selector 无法解析；请使用有效的 CSS 选择器。");
		}
		if (count === 0) {
			throw new InteractionError(
				hasRef ? `ref=${target.ref} 已失效，请重新 browser_snapshot。` : "selector 未匹配到元素，请重新观察页面。",
			);
		}
		if (count > 1) throw new InteractionError(`selector 匹配到 ${count} 个元素，目标不唯一，请缩小选择范围。`);
		return locator;
	}

	private async verify<T>(read: () => Promise<T>, matches: (value: T) => boolean, failure: string): Promise<T> {
		const deadline = Date.now() + Math.min(this.timeoutMs, 1_000);
		let matchedSince: number | undefined;
		do {
			const value = await read();
			if (matches(value)) {
				matchedSince ??= Date.now();
				if (Date.now() - matchedSince >= VERIFY_STABLE_MS) return value;
			} else {
				matchedSince = undefined;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, VERIFY_POLL_MS));
		} while (Date.now() < deadline);
		throw new InteractionError(failure);
	}

	private async act<T>(
		target: BrowserTarget,
		action: string,
		operation: (locator: Locator) => Promise<T>,
	): Promise<T> {
		try {
			return await operation(await this.resolve(target));
		} catch (error) {
			if (error instanceof InteractionError) throw error;
			const message = error instanceof Error ? error.message : "";
			if (/strict mode violation/i.test(message))
				throw new InteractionError("目标匹配到多个元素，请缩小 selector 范围。");
			if (/closed|has been disposed/i.test(message))
				throw new InteractionError("浏览器页面已关闭，请重新打开页面。");
			if (/detached|not attached/i.test(message))
				throw new InteractionError("目标元素已从页面移除，请重新 browser_snapshot。");
			// Playwright call logs may contain input values, including passwords. Do not forward them.
			throw new InteractionError(
				`${action}失败；元素可能隐藏、被遮挡、禁用或已改变，请重新 browser_snapshot 确认可操作状态。`,
			);
		}
	}
}

class InteractionError extends Error {}
