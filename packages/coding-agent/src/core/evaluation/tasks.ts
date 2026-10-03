import type { EvaluationCategory, EvaluationCheckSpec, EvaluationRubricItem, EvaluationTask } from "./types.ts";

const svgRubric: EvaluationRubricItem[] = [
	{
		id: "structure",
		label: "结构关系",
		description: "1：结构明显错误；3：基本合理但有断连或遮挡；5：比例、连接和空间关系清楚。",
	},
	{
		id: "action",
		label: "动作表达",
		description: "1：没有表达要求；3：能辨识但动作或要求不完整；5：准确完整地表达动作与题目要求。",
	},
	{
		id: "clarity",
		label: "视觉清晰度",
		description: "1：难以辨识；3：主体可辨但有拥挤或重叠；5：构图、层次和文字清晰。",
	},
];
const htmlRubric: EvaluationRubricItem[] = [
	{ id: "layout", label: "布局可读性", description: "1：布局混乱；3：基本可用；5：信息层级和不同尺寸下的排版清晰。" },
	{
		id: "experience",
		label: "操作体验",
		description: "1：操作困难；3：主流程可用但反馈不完整；5：联动、错误、空态与键盘操作清楚。",
	},
	{
		id: "finish",
		label: "视觉完成度",
		description: "1：明显缺失；3：样式基本完整；5：字体、留白、配色和状态表达协调。",
	},
];
const codeRubric: EvaluationRubricItem[] = [
	{
		id: "cause",
		label: "问题分析",
		description: "1：原因或要求理解错误；3：主要问题理解正确；5：因果、约束和边界解释准确。",
	},
	{
		id: "change",
		label: "修改合理性",
		description: "1：修改无效；3：能完成主要要求；5：修改完整、必要，并考虑副作用。",
	},
	{
		id: "readability",
		label: "代码可读性",
		description: "1：难以理解；3：结构基本清楚；5：命名、结构和说明简洁明确。",
	},
];
const htmlInstruction =
	"只输出一份完整、可离线运行的 HTML，CSS 和 JavaScript 内嵌，不加载外部资源、不调用接口。为表单控件提供可读标签，保留题目指定的 id 供自动验收。不要使用内嵌 iframe、外部脚本或图片。";
const codeInstruction =
	"使用独立 JavaScript 函数（可使用标准库、BigInt、Promise），不用第三方库、import、Node API、文件或网络。先简要说明问题，再在一个 javascript 代码块中返回指定函数；不执行测试、不输出额外自运行代码。";
const sources = {
	owl: { label: "Owl 自编题 · 固定需求与边界用例", url: "" },
	svg: { label: "Owl 改编 · 参考 SVGenius 方法", url: "https://zjureal.com/SVGenius/" },
	web: { label: "Owl 自编题 · 参考 FrontendBench 方法", url: "https://arxiv.org/abs/2506.13832" },
	code: { label: "Owl 自编题 · 参考 EvalPlus 的边界测试方法", url: "https://github.com/evalplus/evalplus" },
};

export const EVALUATION_BICYCLE_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160"><rect id="background" x="0" y="0" width="240" height="160" fill="#f4f0e6"/><g id="frame" fill="none" stroke="#357565" stroke-width="4"><path d="M50 110L95 55L135 110H50L160 55L190 110M95 55H160"/></g><circle id="rear-wheel" cx="50" cy="110" r="30" fill="none" stroke="#394c40" stroke-width="3"/><circle id="front-wheel" cx="190" cy="110" r="30" fill="none" stroke="#394c40" stroke-width="3"/><path id="seat" d="M80 55H107" stroke="#394c40" stroke-width="5"/><path id="handle" d="M160 55L165 40H180" fill="none" stroke="#394c40" stroke-width="4"/></svg>';
export const EVALUATION_RELATION_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><defs><circle id="template" cx="0" cy="0" r="15" fill="red"/></defs><rect id="blue" x="40" y="40" width="50" height="50" fill="blue"/><use id="left" href="#template" transform="translate(20 60)"/><use id="right" href="#template" transform="translate(120 60)"/><rect id="green" x="40" y="40" width="50" height="50" fill="green"/></svg>';
export const EVALUATION_ORDERS = Array.from({ length: 12 }, (_, i) => ({
	id: `ORD-${String(i + 1).padStart(3, "0")}`,
	amount: [360, 1280, 560, 80, 240, 920, 120, 480, 640, 200, 1000, 320][i],
	status: ["pending", "completed", "cancelled"][i % 3],
}));
export const EVALUATION_PRODUCTS = [
	{ id: "A", name: "设备配件", price: 100, stock: 2 },
	{ id: "B", name: "维修耗材", price: 20, stock: 5 },
	{ id: "C", name: "库存样件", price: 50, stock: 0 },
];
export const EVALUATION_BOARD = Array.from({ length: 6 }, (_, i) => ({
	id: `T0${i + 1}`,
	title: ["核对需求", "确认字段", "完善提示", "接口联调", "页面验收", "整理记录"][i],
	status: i < 3 ? "todo" : i < 5 ? "doing" : "done",
}));
export const EVALUATION_RECORDS = Array.from({ length: 8 }, (_, i) => ({
	id: `R0${i + 1}`,
	title: `设备记录 ${i + 1}`,
	detail: `第 ${i + 1} 台设备的固定详情`,
}));

function task(
	id: string,
	category: EvaluationCategory,
	title: string,
	prompt: string,
	input?: string,
	specific?: EvaluationCheckSpec,
	source = sources.owl,
): EvaluationTask {
	return {
		id,
		version: 1,
		title,
		category,
		outputType: category,
		builtin: true,
		prompt,
		...(input ? { input } : {}),
		source,
		rubric: structuredClone(category === "svg" ? svgRubric : category === "html" ? htmlRubric : codeRubric),
		checks: [
			{ id: "format", label: "输出格式有效", kind: "format" },
			...(category === "svg" || category === "html"
				? [
						{ id: "safe", label: "独立预览与外部资源检查", kind: "safe" },
						{ id: "render", label: "浏览器渲染检查", kind: "render" },
					]
				: []),
			...(specific ? [specific] : []),
		],
	};
}
const rules = (id: string, label: string): EvaluationCheckSpec => ({ id: "requirements", label, kind: id });

/** Fixed/versioned questions. Editing one in the UI creates a separate custom question. */
export const BUILTIN_EVALUATION_TASKS: EvaluationTask[] = [
	task("G01", "svg", "鹈鹕骑自行车", "Generate an SVG of a pelican riding a bicycle", undefined, undefined, {
		label: "Simon Willison · 公开原题",
		url: "https://simonwillison.net/2024/Oct/25/pelicans-on-a-bicycle/",
	}),
	task("G02", "svg", "章鱼演奏管风琴", "Generate an SVG of an octopus operating a pipe organ", undefined, undefined, {
		label: "Tom Gally · 公开题目",
		url: "https://gally.net/temp/20260914pelican-alternatives/index.html",
	}),
	task(
		"G03",
		"svg",
		"几何布局海报",
		"只输出完整 SVG。画布 viewBox=0 0 600 400。三个圆分别使用 id red-circle/blue-circle/green-circle；cx 为 120/300/480，cy=130，r=40，填充 red/blue/green。下方 text id=title，x=300,y=300,text-anchor=middle，标题“几何之美”。不添加额外图形或背景图片。",
		undefined,
		rules("geometry", "位置、颜色、尺寸与标题"),
	),
	task(
		"G04",
		"svg",
		"精确数据柱状图",
		"输出 SVG 柱状图，viewBox=0 0 600 400。纵轴从零开始，基线 y=320，每单位值对应 2px 高度。四个 rect 的 id 为 bar-A/bar-B/bar-C/bar-D，x=100/200/300/400，width=50，数据 A=40,B=80,C=60,D=100。保留类别和数字 text 标签，标注零基线；禁止 transform 改变柱子几何。",
		undefined,
		rules("bars", "固定数据、柱高与零基线"),
	),
	task(
		"G05",
		"svg",
		"修复破损 SVG",
		"附带 SVG 的 front-wheel 标签缺少结束标签。只修复这个语法错误；保留所有已有元素、属性和样式，只输出完整 SVG。",
		EVALUATION_BICYCLE_SVG.replace('stroke-width="3"/><path id="seat"', 'stroke-width="3"><path id="seat"'),
		rules("svg-repair", "修复后元素与固定基准一致"),
		sources.svg,
	),
	task(
		"G06",
		"svg",
		"仅修改指定零件",
		"只把附带 SVG 的 front-wheel 的 stroke 改为 red，并把 cx 从 190 改为 202。其他元素、属性与顺序保持不变。只输出完整 SVG。",
		EVALUATION_BICYCLE_SVG,
		rules("svg-edit", "指定改动与未改部分保留"),
		sources.svg,
	),
	{
		...task(
			"G07",
			"svg",
			"读 SVG 回答关系",
			"阅读附带 SVG。只输出 JSON，字段 visible_count 为最终可见对象数量（完全被遮挡对象不计），top_color 为覆盖蓝色矩形的颜色，leftmost_id 为最左可见对象的 id。忽略 defs 中未直接渲染的模板。",
			EVALUATION_RELATION_SVG,
			rules("relations", "可见对象、遮挡与变换标准答案"),
			{ label: "Owl 改编 · 参考 VGBench 方法", url: "https://github.com/vgbench/VGBench" },
		),
		outputType: "json",
		checks: [
			{ id: "format", label: "JSON格式有效", kind: "format" },
			rules("relations", "可见对象、遮挡与变换标准答案"),
		],
		rubric: [
			{ id: "relation", label: "关系判断", description: "最终颜色、可见数量与位置是否正确。" },
			{ id: "transform", label: "变换理解", description: "是否理解 defs/use、平移与遮挡。" },
			{ id: "complete", label: "答案完整性", description: "是否完整遵循规定 JSON 输出。" },
		],
	},
	task(
		"G08",
		"svg",
		"真正蹬车的动画",
		"输出单文件动画 SVG，鹈鹕骑自行车。使用 SMIL animate/animateTransform，4 秒循环（dur=4s，repeatCount=indefinite），无外链、无 JavaScript。左右踏板相位相差 180 度，脚跟随踏板、腿与身体保持连接，循环无跳跃。动作质量由人工评价。",
		undefined,
		rules("animation", "动画周期与循环声明"),
	),
	task(
		"W01",
		"html",
		"订单筛选表格",
		`${htmlInstruction}\n展示固定订单。status-filter select 值 all/pending/completed/cancelled，amount-sort select 值 asc/desc，order-search 输入按 id 搜索。orders-body 内每条记录使用 tr data-order-id=订单id；每页 5 条，next-page/previous-page 翻页，page-info 显示页码。reset-filters 重置全部条件并回到第1页，empty-state 表达无结果。筛选变化后回第1页，金额按数值排序。`,
		JSON.stringify(EVALUATION_ORDERS),
		rules("web-W01", "筛选、数值排序、分页与重置"),
		sources.web,
	),
	task(
		"W02",
		"html",
		"费用报价计算器",
		`${htmlInstruction}\n设备单价150元、数量2；耗材单价20元、数量3。qty-device/qty-consumable 数量输入，discount 优惠百分比初始0。total 显示最终金额并保留两位小数；折扣10%后324.00。数量必须为非负整数，优惠0..100；非法值时 error 显示错误，金额不出现 NaN 或负数。`,
		undefined,
		rules("web-W02", "360→324、数量联动与非法输入"),
		sources.web,
	),
	task(
		"W03",
		"html",
		"维修申请表",
		`${htmlInstruction}\nworkshop select 值 A/B，device select 初始空值；A对应E01/E02，B对应E03。切换车间清除失效设备。fault textarea 与设备为必填。submit 提交按钮，不调用接口；form-error 表达校验错误，submitted-data 展示成功提交的设备与故障描述。`,
		undefined,
		rules("web-W03", "车间联动、必填校验与提交内容"),
		sources.web,
	),
	task(
		"W04",
		"html",
		"购物车与库存",
		`${htmlInstruction}\n使用固定商品。add-A/add-B/add-C 加入购物车，C售罄按钮disabled。cart-A/cart-B 为购物车行，qty-A/qty-B 展示数量，remove-A/remove-B 删除，cart-total 展示总额，cart-empty 展示空状态。重复加入不能超库存；初始购物车为空。`,
		JSON.stringify(EVALUATION_PRODUCTS),
		rules("web-W04", "库存上限、售罄、总额与空态"),
		sources.web,
	),
	task(
		"W05",
		"html",
		"三列任务看板",
		`${htmlInstruction}\n使用固定任务。todo-list/doing-list/done-list 为三列，每卡data-task-id=任务id。每卡使用 select id=status-任务id，值todo/doing/done，可移列。todo-count/doing-count/done-count 显示数量。task-title 输入、new-task-status select与add-task 新增；空标题时task-error显示错误。`,
		JSON.stringify(EVALUATION_BOARD),
		rules("web-W05", "移列、计数更新与新增边界"),
		sources.web,
	),
	task(
		"W06",
		"html",
		"销售统计面板",
		`${htmlInstruction}\n数据A=100,B=200,C=300元。category-filter select值all/A/B/C；sales-search按类别筛选。total-sale 显示金额，sales-body内tr data-category对应类别；每个图表数据元素data-category、data-value表达当前数值。no-data 为无数据提示，空结果total-sale=0，禁止NaN。`,
		undefined,
		rules("web-W06", "600/200统计、筛选与图表数据"),
		sources.web,
	),
	task(
		"W07",
		"html",
		"搜索与详情弹窗",
		`${htmlInstruction}\n固定八项记录，record-search 按标题搜索，record-list 容器；打开按钮data-record-id=记录id。detail-dialog 具有dialog语义，detail-content显示对应详情，close-detail按钮关闭。Esc关闭；Tab焦点在弹窗内循环；关闭后焦点回到原打开按钮。无结果时显示empty-records。`,
		JSON.stringify(EVALUATION_RECORDS),
		rules("web-W07", "搜索、对应详情、Esc与焦点返回"),
		sources.web,
	),
	task(
		"W08",
		"html",
		"响应式知识页面",
		`${htmlInstruction}\n提供9张知识卡片（标题“知识卡片 1”至“知识卡片 9”，其中第9张标题附一段很长的中文描述）。每卡class=knowledge-card。适配1280与375px；手机无横向溢出，长标题不遮住按钮。nav-toggle为移动导航开关，mobile-nav为导航容器，点击可以打开和关闭。`,
		undefined,
		rules("web-W08", "九张卡片、375px布局与移动导航"),
		sources.web,
	),
	task(
		"C01",
		"code",
		"分页越界修复",
		`${codeInstruction}\n修复 function paginate(items,page,size)。page/size必须为正整数，否则抛RangeError。输入五条数据每页两条，1页两条、3页一条、4页空；不得修改输入。`,
		"function paginate(items,page,size){return items.slice(page*size,(page+1)*size);}",
		rules("code-C01", "正常、末页、非法参数与不修改输入"),
		sources.code,
	),
	task(
		"C02",
		"code",
		"金额精度修复",
		`${codeInstruction}\n实现 function totalMoney(items)，items为{price:string,quantity:number}[]。price为非负十进制字符串、最多6位小数；quantity非负整数，非法值抛RangeError。各项精确相乘累加后，仅在最终金额按HALF_UP保留两位，返回字符串。0.10×3+0.20=0.50，0.105×3=0.32。空数组返回0.00，支持大整数金额。`,
		"function totalMoney(items){return items.reduce((sum,item)=>sum+Number(item.price)*item.quantity,0).toFixed(2);}",
		rules("code-C02", "十进制定点、最终舍入与大金额"),
		sources.code,
	),
	task(
		"C03",
		"code",
		"去重但保留顺序",
		`${codeInstruction}\n实现 function uniqueLatest(items)，items为{id:string,value:string}[]。相同id保留最后一条内容，输出位置按首次出现id顺序。A旧、B、A新→A新、B。不修改输入，空数组返回空数组。`,
		"function uniqueLatest(items){return Array.from(new Set(items));}",
		rules("code-C03", "最后内容、首次顺序与输入保留"),
		sources.code,
	),
	task(
		"C04",
		"code",
		"排序不能修改输入",
		`${codeInstruction}\n修复 function sortedCopy(items)，输入有限数字数组，返回数值升序且不修改原输入。正确处理空数组、负数、重复值与10/2的排序。`,
		"function sortedCopy(items){return items.sort();}",
		rules("code-C04", "数值排序、重复值与引用副作用"),
		sources.code,
	),
	task(
		"C05",
		"code",
		"更新时保留 0 与 false",
		`${codeInstruction}\n实现 function applyPatch(original,patch)，返回新对象，不修改原对象。patch值为undefined时忽略；0、false、空字符串必须保留；null表示写入null以清除。只处理自身可枚举属性。`,
		"function applyPatch(original,patch){const next={...original};for(const key of Object.keys(patch))next[key]=patch[key]||original[key];return next;}",
		rules("code-C05", "0/false/空串、undefined/null与原对象"),
		sources.code,
	),
	task(
		"C06",
		"code",
		"合并时间区间",
		`${codeInstruction}\n实现 function mergeIntervals(intervals)，输入[start,end][]且start<=end；重叠或端点相接合并。返回按start排序的新数组，不修改输入或子数组。[1,3],[3,5],[8,10]→[1,5],[8,10]。覆盖包含、乱序、空输入。`,
		"function mergeIntervals(intervals){return intervals;}",
		rules("code-C06", "乱序、包含、相接与深层输入保留"),
		sources.code,
	),
	task(
		"C07",
		"code",
		"搜索请求竞态修复",
		`${codeInstruction}\n实现 function createSearchController(fetchResults,setResults)，返回async function search(query)。每次调用fetchResults(query)，只有最后一次启动的请求可以调用setResults；较旧请求的完成不得覆盖最新结果。失败向调用者抛出且不更新显示。不依赖真实网络或DOM。`,
		"function createSearchController(fetchResults,setResults){return async function search(query){setResults(await fetchResults(query));};}",
		rules("code-C07", "异步返回乱序与最新请求保留"),
		sources.code,
	),
	task(
		"C08",
		"code",
		"限制异步并发",
		`${codeInstruction}\n实现 async function mapLimit(items,limit,mapper)。limit须正整数，否则抛RangeError；mapper(value,index)返回值或Promise。最多limit个mapper同时执行；结果按输入顺序。空输入返回[]。任一任务失败时最终拒绝Promise，不能吞掉异常。不使用外部计时器或真实网络。`,
		"async function mapLimit(items,limit,mapper){return Promise.all(items.map(mapper));}",
		rules("code-C08", "并发上限、结果顺序、空输入与失败"),
		sources.code,
	),
];
