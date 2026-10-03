import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Frame, type Page } from "playwright-core";
import { EVALUATION_BOARD, EVALUATION_ORDERS, EVALUATION_RECORDS } from "./tasks.ts";
import type { EvaluationArtifact, EvaluationCheck, EvaluationCheckSpec, EvaluationTask } from "./types.ts";

const WORK_BUDGET_MS = 12_500;
const PREVIEW_CSP =
	"default-src 'none'; base-uri 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; navigate-to 'none'; img-src data:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/** Uses an installed browser, never downloads one or opens a user's browser profile. */
export function findEvaluationBrowserPath(): string | undefined {
	if (process.env.OWL_EVALUATION_BROWSER_PATH)
		return existsSync(process.env.OWL_EVALUATION_BROWSER_PATH) ? process.env.OWL_EVALUATION_BROWSER_PATH : undefined;
	const candidates =
		process.platform === "win32"
			? [
					join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
					join(
						process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
						"Microsoft",
						"Edge",
						"Application",
						"msedge.exe",
					),
					join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
					...(process.env.LOCALAPPDATA
						? [join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")]
						: []),
				]
			: process.platform === "darwin"
				? [
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
						"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
					]
				: [];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		for (const name of [
			"google-chrome",
			"google-chrome-stable",
			"chromium",
			"chromium-browser",
			"microsoft-edge",
			"chrome.exe",
			"msedge.exe",
		])
			candidates.push(join(directory, name));
	}
	candidates.push(chromium.executablePath());
	return candidates.find((candidate) => existsSync(candidate));
}

function assertBehavior(condition: unknown, description: string): asserts condition {
	if (!condition) throw new Error(description);
}

async function visibleAttributes(frame: Frame, selector: string, attribute: string): Promise<string[]> {
	return frame.evaluate<string[]>(
		`[...document.querySelectorAll(${JSON.stringify(selector)})].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').map(el => el.getAttribute(${JSON.stringify(attribute)}) || '')`,
	);
}

async function fillInput(frame: Frame, id: string, value: string): Promise<void> {
	await frame.locator(`#${id}`).fill(value);
	await frame.locator(`#${id}`).press("Tab");
}

async function amount(frame: Frame, id: string, expected: number, twoDecimals = false): Promise<void> {
	await frame.waitForFunction(
		`({id,expected,twoDecimals}) => { const text=document.getElementById(id)?.textContent || ''; const match=text.replace(/,/g,'').match(/[-+]?\\d+(?:\\.\\d+)?/); return match && Math.abs(Number(match[0])-expected)<0.005 && (!twoDecimals || /\\d+\\.\\d{2}(?!\\d)/.test(text)); }`,
		{ id, expected, twoDecimals },
		{ timeout: 900 },
	);
}

async function visibleError(frame: Frame, id: string): Promise<void> {
	const error = frame.locator(`#${id}`);
	assertBehavior((await error.isVisible()) && (await error.textContent())?.trim(), `${id} 没有显示可读的错误提示。`);
}

async function numericValue(frame: Frame, id: string): Promise<number> {
	const value = await frame.evaluate<string>(
		`(() => {const el=document.getElementById(${JSON.stringify(id)});return 'value' in el ? String(el.value) : el.textContent || ''})()`,
	);
	return Number(value.match(/[-+]?\d+(?:\.\d+)?/)?.[0]);
}

function sameList(actual: string[], expected: string[], description: string): void {
	assertBehavior(
		JSON.stringify(actual) === JSON.stringify(expected),
		`${description}；实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}。`,
	);
}

async function orders(frame: Frame): Promise<void> {
	const initialSort = await frame.locator("#amount-sort").inputValue();
	assertBehavior(
		(await visibleAttributes(frame, "#orders-body tr[data-order-id]", "data-order-id")).length === 5,
		"初始每页应有5笔订单。",
	);
	await frame.locator("#next-page").click();
	assertBehavior(/2/.test((await frame.locator("#page-info").textContent()) ?? ""), "下一页未显示第2页。");
	await frame.locator("#status-filter").selectOption("completed");
	await frame.locator("#amount-sort").selectOption("asc");
	sameList(
		await visibleAttributes(frame, "#orders-body tr[data-order-id]", "data-order-id"),
		EVALUATION_ORDERS.filter((order) => order.status === "completed")
			.sort((a, b) => a.amount - b.amount)
			.map((order) => order.id),
		"完成状态筛选与数值升序错误",
	);
	assertBehavior(/1/.test((await frame.locator("#page-info").textContent()) ?? ""), "筛选后没有回到第1页。");
	await frame.locator("#status-filter").selectOption("all");
	await frame.locator("#amount-sort").selectOption("desc");
	sameList(
		await visibleAttributes(frame, "#orders-body tr[data-order-id]", "data-order-id"),
		[...EVALUATION_ORDERS]
			.sort((a, b) => b.amount - a.amount)
			.slice(0, 5)
			.map((order) => order.id),
		"金额降序或每页5条错误",
	);
	await fillInput(frame, "order-search", "ORD-012");
	sameList(
		await visibleAttributes(frame, "#orders-body tr[data-order-id]", "data-order-id"),
		["ORD-012"],
		"按订单编号搜索错误",
	);
	await fillInput(frame, "order-search", "NO-MATCH-OWL");
	assertBehavior(
		(await visibleAttributes(frame, "#orders-body tr[data-order-id]", "data-order-id")).length === 0 &&
			(await frame.locator("#empty-state").isVisible()),
		"无结果时记录未清空或缺少空态。",
	);
	await frame.locator("#reset-filters").click();
	assertBehavior(
		(await frame.locator("#status-filter").inputValue()) === "all" &&
			(await frame.locator("#order-search").inputValue()) === "" &&
			(await frame.locator("#amount-sort").inputValue()) === initialSort,
		"重置没有恢复全部筛选条件。",
	);
	assertBehavior(
		(await visibleAttributes(frame, "#orders-body tr[data-order-id]", "data-order-id")).length === 5,
		"重置后每页记录数错误。",
	);
	await frame.locator("#next-page").click();
	await frame.locator("#previous-page").click();
	assertBehavior(/1/.test((await frame.locator("#page-info").textContent()) ?? ""), "上一页没有返回第1页。");
}

async function quotation(frame: Frame): Promise<void> {
	await amount(frame, "total", 360, true);
	await fillInput(frame, "discount", "10");
	await amount(frame, "total", 324, true);
	await fillInput(frame, "qty-device", "3");
	await amount(frame, "total", 459, true);
	await fillInput(frame, "qty-consumable", "0");
	await amount(frame, "total", 405, true);
	for (const value of ["-1", "0.5"]) {
		await fillInput(frame, "qty-device", value);
		await visibleError(frame, "error");
		const total = (await frame.locator("#total").textContent()) ?? "";
		assertBehavior(!/NaN|Infinity|-\s*\d/.test(total), "非法数量产生NaN、无穷或负金额。");
	}
	await fillInput(frame, "qty-device", "2");
	await fillInput(frame, "qty-consumable", "3");
	await fillInput(frame, "discount", "101");
	await visibleError(frame, "error");
	await fillInput(frame, "discount", "-1");
	await visibleError(frame, "error");
	await fillInput(frame, "discount", "0");
	await amount(frame, "total", 360, true);
}

async function repairForm(frame: Frame): Promise<void> {
	assertBehavior((await frame.locator("#device").inputValue()) === "", "设备初始应为空。");
	await frame.locator("#workshop").selectOption("A");
	await frame.locator("#device").selectOption("E01");
	await frame.locator("#workshop").selectOption("B");
	assertBehavior((await frame.locator("#device").inputValue()) === "", "切换到车间B后没有清除E01。");
	const choices = await frame.evaluate<string[]>(
		"[...document.querySelectorAll('#device option')].map(el => el.value)",
	);
	assertBehavior(
		choices.includes("E03") && !choices.includes("E01") && !choices.includes("E02"),
		"车间B设备列表不符合E03联动要求。",
	);
	await frame.locator("#submit").click();
	await visibleError(frame, "form-error");
	await frame.locator("#device").selectOption("E03");
	await fillInput(frame, "fault", "");
	await frame.locator("#submit").click();
	await visibleError(frame, "form-error");
	await fillInput(frame, "fault", "设备无法启动，等待检修");
	await frame.locator("#submit").click();
	const submitted = (await frame.locator("#submitted-data").textContent()) ?? "";
	assertBehavior(
		submitted.includes("E03") && submitted.includes("设备无法启动，等待检修"),
		"提交结果缺少选定设备或故障描述。",
	);
	await frame.locator("#workshop").selectOption("A");
	assertBehavior((await frame.locator("#device").inputValue()) === "", "切回车间A后没有清除E03。");
}

async function cart(frame: Frame): Promise<void> {
	assertBehavior(await frame.locator("#cart-empty").isVisible(), "初始购物车缺少空态。");
	assertBehavior(await frame.locator("#add-C").isDisabled(), "售罄商品C仍可加入。");
	for (let i = 0; i < 5; i++) await frame.evaluate("document.getElementById('add-A').click()");
	for (let i = 0; i < 8; i++) await frame.evaluate("document.getElementById('add-B').click()");
	assertBehavior(
		(await numericValue(frame, "qty-A")) === 2 && (await numericValue(frame, "qty-B")) === 5,
		"重复加入超出库存，或未正确累加数量。",
	);
	assertBehavior(
		(await frame.locator("#cart-A").isVisible()) && (await frame.locator("#cart-B").isVisible()),
		"购物车行未显示。",
	);
	await amount(frame, "cart-total", 300);
	await frame.locator("#remove-A").click();
	await amount(frame, "cart-total", 100);
	await frame.locator("#remove-B").click();
	await amount(frame, "cart-total", 0);
	assertBehavior(await frame.locator("#cart-empty").isVisible(), "删除全部商品后没有购物车空态。");
}

async function board(frame: Frame): Promise<void> {
	for (const status of ["todo", "doing", "done"]) {
		const expected = EVALUATION_BOARD.filter((task) => task.status === status).map((task) => task.id);
		sameList(
			await visibleAttributes(frame, `#${status}-list [data-task-id]`, "data-task-id"),
			expected,
			`${status} 初始任务不正确`,
		);
		assertBehavior((await numericValue(frame, `${status}-count`)) === expected.length, `${status} 初始计数错误。`);
	}
	await frame.locator("#status-T01").selectOption("done");
	assertBehavior(
		(await frame.locator('#done-list [data-task-id="T01"]').count()) === 1 &&
			(await numericValue(frame, "todo-count")) === 2 &&
			(await numericValue(frame, "done-count")) === 2,
		"任务移列或计数未同步。",
	);
	await fillInput(frame, "task-title", "   ");
	await frame.locator("#add-task").click();
	await visibleError(frame, "task-error");
	assertBehavior(
		(await visibleAttributes(frame, "[data-task-id]", "data-task-id")).length === 6,
		"空标题新增了任务。",
	);
	await fillInput(frame, "task-title", "浏览器验收新增任务");
	await frame.locator("#new-task-status").selectOption("doing");
	await frame.locator("#add-task").click();
	assertBehavior(
		(await numericValue(frame, "doing-count")) === 3 &&
			(await frame.locator("#doing-list").textContent())?.includes("浏览器验收新增任务"),
		"新增任务没有进入指定列或未更新计数。",
	);
}

async function sales(frame: Frame): Promise<void> {
	await amount(frame, "total-sale", 600);
	sameList(
		await visibleAttributes(frame, "#sales-body tr[data-category]", "data-category"),
		["A", "B", "C"],
		"初始明细不正确",
	);
	await frame.locator("#category-filter").selectOption("B");
	await amount(frame, "total-sale", 200);
	sameList(
		await visibleAttributes(frame, "#sales-body tr[data-category]", "data-category"),
		["B"],
		"类别筛选未更新明细",
	);
	const chart = await frame.evaluate<{ category: string; value: number }[]>(
		"[...document.querySelectorAll('[data-category][data-value]')].filter(el => !el.closest('table') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').map(el => ({category:el.getAttribute('data-category'),value:Number(el.getAttribute('data-value'))}))",
	);
	assertBehavior(
		chart.length > 0 && chart.every((entry) => entry.category === "B" && entry.value === 200),
		"图表与B=200筛选结果不一致。",
	);
	await fillInput(frame, "sales-search", "NO-MATCH-OWL");
	await amount(frame, "total-sale", 0);
	assertBehavior(
		(await frame.locator("#no-data").isVisible()) &&
			(await visibleAttributes(frame, "#sales-body tr[data-category]", "data-category")).length === 0,
		"无数据状态不正确。",
	);
	await fillInput(frame, "sales-search", "");
	await frame.locator("#category-filter").selectOption("all");
	await amount(frame, "total-sale", 600);
}

async function recordDialog(frame: Frame, page: Page): Promise<void> {
	assertBehavior(
		(await visibleAttributes(frame, "#record-list [data-record-id]", "data-record-id")).length === 8,
		"初始记录不是固定八项。",
	);
	await fillInput(frame, "record-search", "设备记录 3");
	sameList(await visibleAttributes(frame, "#record-list [data-record-id]", "data-record-id"), ["R03"], "标题搜索错误");
	await frame.locator('#record-list [data-record-id="R03"]').click();
	assertBehavior(await frame.locator("#detail-dialog").isVisible(), "详情弹窗没有打开。");
	assertBehavior(
		await frame.evaluate<boolean>(
			"(() => {const el=document.getElementById('detail-dialog');return el.tagName === 'DIALOG' || el.getAttribute('role') === 'dialog'})()",
		),
		"弹窗没有dialog语义。",
	);
	assertBehavior(
		(await frame.locator("#detail-content").textContent())?.includes(EVALUATION_RECORDS[2].detail),
		"详情与R03不对应。",
	);
	const focusSelector =
		"button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex='-1'])";
	assertBehavior(
		await frame.evaluate<boolean>("document.getElementById('detail-dialog').contains(document.activeElement)"),
		"打开弹窗后焦点没有进入弹窗。",
	);
	await frame.evaluate(
		`(() => {const elements=[...document.getElementById('detail-dialog').querySelectorAll(${JSON.stringify(focusSelector)})].filter(el=>el.getClientRects().length);if(!elements.length)throw Error('弹窗没有可聚焦控件');elements[elements.length-1].focus();})()`,
	);
	await page.keyboard.press("Tab");
	assertBehavior(
		await frame.evaluate<boolean>(
			`(() => {const elements=[...document.getElementById('detail-dialog').querySelectorAll(${JSON.stringify(focusSelector)})].filter(el=>el.getClientRects().length);return document.activeElement===elements[0]})()`,
		),
		"Tab没有从末尾循环至首个弹窗控件。",
	);
	await page.keyboard.press("Shift+Tab");
	assertBehavior(
		await frame.evaluate<boolean>(
			`(() => {const elements=[...document.getElementById('detail-dialog').querySelectorAll(${JSON.stringify(focusSelector)})].filter(el=>el.getClientRects().length);return document.activeElement===elements[elements.length-1]})()`,
		),
		"Shift+Tab没有在弹窗内循环。",
	);
	await page.keyboard.press("Escape");
	assertBehavior(!(await frame.locator("#detail-dialog").isVisible()), "Esc没有关闭弹窗。");
	assertBehavior(
		(await frame.evaluate<string>("document.activeElement?.getAttribute('data-record-id')")) === "R03",
		"关闭后焦点没有返回打开按钮。",
	);
	await frame.locator('#record-list [data-record-id="R03"]').click();
	await frame.locator("#close-detail").click();
	assertBehavior(!(await frame.locator("#detail-dialog").isVisible()), "关闭按钮没有关闭弹窗。");
	await fillInput(frame, "record-search", "NO-MATCH-OWL");
	assertBehavior(
		(await frame.locator("#empty-records").isVisible()) &&
			(await visibleAttributes(frame, "#record-list [data-record-id]", "data-record-id")).length === 0,
		"记录搜索无结果时空态不正确。",
	);
}

async function responsive(frame: Frame, page: Page): Promise<void> {
	assertBehavior((await frame.locator(".knowledge-card").count()) === 9, "知识卡片不是9张。");
	for (const width of [1280, 375]) {
		await page.setViewportSize({ width, height: 800 });
		assertBehavior(
			await frame.evaluate<boolean>(
				"document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1",
			),
			`${width}px布局存在横向溢出。`,
		);
	}
	const mobileNav = frame.locator("#mobile-nav");
	assertBehavior(!(await mobileNav.isVisible()), "移动导航初始应收起。");
	await frame.locator("#nav-toggle").click();
	assertBehavior(await mobileNav.isVisible(), "移动导航未打开。");
	await frame.locator("#nav-toggle").click();
	assertBehavior(!(await mobileNav.isVisible()), "移动导航未关闭。");
	const overlaps = await frame.evaluate<boolean>(
		`(() => {for(const card of document.querySelectorAll('.knowledge-card')){const buttons=[...card.querySelectorAll('button,a,[role="button"]')].filter(el=>el.getClientRects().length);const walker=document.createTreeWalker(card,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(!node.textContent.includes('知识卡片 9'))continue;const range=document.createRange();range.selectNodeContents(node);for(const text of range.getClientRects())for(const button of buttons){const rect=button.getBoundingClientRect();if(text.left<rect.right-1 && text.right>rect.left+1 && text.top<rect.bottom-1 && text.bottom>rect.top+1)return true;}}}return false;})()`,
	);
	assertBehavior(!overlaps, "第9张卡片的长标题覆盖操作按钮。");
}

const WEB_CHECKS: Record<string, (frame: Frame, page: Page) => Promise<void>> = {
	"web-W01": orders,
	"web-W02": quotation,
	"web-W03": repairForm,
	"web-W04": cart,
	"web-W05": board,
	"web-W06": sales,
	"web-W07": recordDialog,
	"web-W08": responsive,
};

/** A free, isolated headless check. Missing browser infrastructure is never scored as a pass. */
export async function checkEvaluationBrowser(
	task: EvaluationTask,
	artifact: EvaluationArtifact,
	signal?: AbortSignal,
): Promise<EvaluationCheck[]> {
	if (artifact.type !== "svg" && artifact.type !== "html") return [];
	signal?.throwIfAborted();
	const render = task.checks.find((spec) => spec.kind === "render") ?? {
		id: "render",
		label: "浏览器渲染检查",
		kind: "render",
	};
	const specs: EvaluationCheckSpec[] = [render, ...task.checks.filter((spec) => /^web-W\d{2}$/.test(spec.kind))];
	const browserPath = findEvaluationBrowserPath();
	if (!browserPath || !artifact.previewAllowed)
		return specs.map((spec) => ({
			id: spec.id,
			label: spec.label,
			status: "unchecked",
			detail: !browserPath
				? "未找到可用Chrome/Edge；可设置OWL_EVALUATION_BROWSER_PATH，浏览器检查未执行。"
				: "产物未通过格式或安全检查，浏览器检查未执行。",
		}));
	let browser: Browser | undefined;
	let context: BrowserContext | undefined;
	let executingArtifact = false;
	let budgetExceeded = false;
	const completed = new Map<string, EvaluationCheck>();
	const close = () => {
		void context?.close().catch(() => {});
		void browser?.close().catch(() => {});
	};
	const abort = () => close();
	signal?.addEventListener("abort", abort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const work = async () => {
			browser = await chromium.launch({
				executablePath: browserPath,
				headless: true,
				timeout: 5000,
				args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
			});
			signal?.throwIfAborted();
			context = await browser.newContext({
				acceptDownloads: false,
				serviceWorkers: "block",
				viewport: { width: 1280, height: 800 },
				permissions: [],
			});
			context.setDefaultTimeout(900);
			context.setDefaultNavigationTimeout(1800);
			await context.route("**/*", (route) => route.abort("blockedbyclient"));
			await context.routeWebSocket("**/*", (socket) => socket.close());
			const page = await context.newPage();
			context.on("page", (popup) => {
				if (popup !== page) void popup.close().catch(() => {});
			});
			page.on("dialog", (dialog) => {
				void dialog.dismiss().catch(() => {});
			});
			executingArtifact = true;
			if (artifact.type === "svg") {
				const validity = await page.evaluate<{ valid: boolean; reason: string }>(
					`(() => {const document=new DOMParser().parseFromString(${JSON.stringify(artifact.content)},'image/svg+xml');return {valid:document.documentElement.localName==='svg' && !document.querySelector('parsererror'),reason:document.querySelector('parsererror')?.textContent||''}})()`,
				);
				assertBehavior(validity.valid, `浏览器原生SVG解析失败：${validity.reason.slice(0, 250)}`);
			}
			const policy =
				artifact.type === "svg"
					? PREVIEW_CSP.replace("script-src 'unsafe-inline'", "script-src 'none'")
					: PREVIEW_CSP;
			const content = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${artifact.type === "svg" ? "<style>html,body{margin:0;width:100%;height:100%;display:grid;place-items:center}svg{max-width:100%;max-height:100%}</style>" : ""}${artifact.content}`;
			const escaped = content
				.replaceAll("&", "&amp;")
				.replaceAll('"', "&quot;")
				.replaceAll("<", "&lt;")
				.replaceAll(">", "&gt;");
			await page.setContent(
				`<style>html,body{margin:0;width:100%;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe id="artifact" sandbox="${artifact.type === "html" ? "allow-scripts allow-forms" : ""}" srcdoc="${escaped}"></iframe>`,
				{ waitUntil: "domcontentloaded", timeout: 1800 },
			);
			const handle = await page.$("#artifact");
			const frame = await handle?.contentFrame();
			assertBehavior(frame, "产物预览frame没有建立。");
			await frame.waitForLoadState("domcontentloaded", { timeout: 1800 });
			const nonempty =
				artifact.type === "svg"
					? await frame.evaluate<boolean>(
							"(() => {const svg=document.querySelector('svg');if(!svg || !svg.getBoundingClientRect().width || !svg.getBoundingClientRect().height)return false;return [...svg.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon,text,use')].some(el=>{if(el.closest('defs,clipPath,mask,symbol'))return false;const style=getComputedStyle(el);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return false;try{const box=el.getBBox();return (box.width>0||box.height>0) && (style.fill!=='none'||style.stroke!=='none')}catch{return false}})})()",
						)
					: await frame.evaluate<boolean>(
							"(() => {const body=document.body;if(!body||!body.getBoundingClientRect().width)return false;return [...body.querySelectorAll('h1,h2,h3,p,button,input,select,textarea,table,canvas,svg,article,section,div')].some(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&(el.textContent.trim()||/^(INPUT|SELECT|TEXTAREA|CANVAS|svg)$/.test(el.tagName)))})()",
						);
			assertBehavior(nonempty, "产物未形成可见的非空页面或SVG图形。");
			completed.set(render.id, {
				id: render.id,
				label: render.label,
				status: "passed",
				detail: "真实无凭据浏览器已完成解析和非空渲染；所有外部请求已拦截，产物在独立沙箱中运行。",
			});
			for (const spec of specs.slice(1)) {
				signal?.throwIfAborted();
				const checker = WEB_CHECKS[spec.kind];
				if (!checker) {
					completed.set(spec.id, {
						id: spec.id,
						label: spec.label,
						status: "unchecked",
						detail: "没有对应的行为检查器。",
					});
					continue;
				}
				try {
					await checker(frame, page);
					completed.set(spec.id, {
						id: spec.id,
						label: spec.label,
						status: "passed",
						detail: "已在真实浏览器按固定控件契约执行交互与边界用例。",
					});
				} catch (cause) {
					signal?.throwIfAborted();
					if (browser && !browser.isConnected() && !budgetExceeded) throw cause;
					completed.set(spec.id, {
						id: spec.id,
						label: spec.label,
						status: "failed",
						detail: cause instanceof Error ? cause.message.slice(0, 700) : String(cause).slice(0, 700),
					});
				}
			}
		};
		await Promise.race([
			work(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					budgetExceeded = true;
					close();
					reject(new Error("浏览器检查超过12.5秒预算；产物没有完成当前检查。"));
				}, WORK_BUDGET_MS);
			}),
		]);
	} catch (cause) {
		signal?.throwIfAborted();
		const detail = cause instanceof Error ? cause.message.slice(0, 700) : String(cause).slice(0, 700);
		const failed = executingArtifact && (budgetExceeded || browser?.isConnected() !== false);
		for (const spec of specs)
			if (!completed.has(spec.id))
				completed.set(spec.id, {
					id: spec.id,
					label: spec.label,
					status: failed ? "failed" : "unchecked",
					detail: failed ? detail : `浏览器环境未能执行检查：${detail}`,
				});
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		const currentBrowser = browser;
		if (currentBrowser)
			await Promise.race([
				currentBrowser.close().catch(() => {}),
				new Promise<void>((resolve) => {
					const cleanupTimer = setTimeout(resolve, 1800);
					cleanupTimer.unref();
				}),
			]);
	}
	return specs.map(
		(spec) =>
			completed.get(spec.id) ?? {
				id: spec.id,
				label: spec.label,
				status: "unchecked",
				detail: "当前检查没有执行。",
			},
	);
}
