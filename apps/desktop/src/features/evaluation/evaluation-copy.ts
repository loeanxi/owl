import { getUiLanguage, useT } from "../../i18n/index.ts";

const zh = {
	title: "模型测评", local: "本地", offline: "本地服务未连接", reconnect: "重新加载", loading: "正在读取测评数据…",
	newRun: "新建测评", evaluation: "测评", library: "题库", history: "运行记录", summary: "测评汇总", currentRun: "当前测评",
	direct: "直接回答", directHint: "固定题目，独立上下文；不带聊天历史，不调用工具。", noRuns: "开始你的第一次模型测评",
	noRunsHint: "选择同一组题目，比较已配置模型的作品、质量、速度和费用。", createTitle: "新建一次测评", createDesc: "选好题目与模型配置，用相同任务比较真实回答。",
	selectTasks: "选择题目", selectModels: "选择参测模型", runConfig: "运行设置", quickPack: "六题快测", quickPackHint: "创作、局部修改、表格、表单、金额与请求竞态",
	all: "全部", custom: "自定义", svg: "SVG", html: "HTML", code: "代码", searchTasks: "搜索题目、编号或提示词", searchRuns: "搜索测评名称",
	selected: "已选择 {n} 项", details: "查看详情", copy: "复制为自定义题", addTask: "加入测评", noTasks: "没有匹配的题目", noModels: "还没有可用的模型",
	noModelsHint: "请先在设置中配置模型并连接账号，再回到这里刷新。", defaultThinking: "默认", unsupportedThinking: "该模型不支持思考档位选择",
	modelConfig: "{model} · {level}", samples: "每题运行次数", runName: "测评名称", runNamePlaceholder: "例如：日常编程模型比较", tasksCount: "题目", profilesCount: "模型配置",
	calls: "调用次数", estimatedCost: "估算费用", unknown: "未知", costHint: "费用取决于实际输入、输出和模型价格，开始前无法确定。", start: "开始测评",
	startHint: "将调用所选模型，产生其正常 API 用量与费用。", createdAt: "创建时间", runStatus: "状态", completed: "已完成", running: "运行中", queued: "待运行",
	failed: "失败", cancelled: "已取消", interrupted: "已中断", pending: "待评价", open: "查看结果", refresh: "刷新", cancel: "取消剩余运行",
	appendThree: "追加到 3 次", appendFive: "追加到 5 次", retry: "重试此结果", retryHint: "重试将新增一次调用，保留原失败记录。", sample: "样本 {n}", attempt: "尝试 {n}",
	results: "结果对比", rubric: "评价标准", anonymous: "匿名评价", anonymousHint: "先看作品和检查结果，提交评分后揭晓模型、速度和费用。",
	revealed: "模型信息已揭晓", revealHint: "作品顺序保持不变，可以结合质量、速度和费用比较。", result: "结果 {letter}", hiddenIdentity: "模型与指标在评分后揭晓",
	preview: "作品预览", source: "源码", answer: "完整回答", analysis: "思考过程", noAnalysis: "模型没有返回可查看的思考过程。", noArtifact: "没有提取到可预览作品",
	previewHint: "独立预览，禁止外部资源与网络请求。", expand: "放大作品", download: "下载作品", automatic: "自动检查", passed: "通过", unchecked: "未检查",
	checksEmpty: "尚未完成自动检查。", manual: "人工评价", scoreScale: "1–5 分", notes: "评价备注", notesPlaceholder: "记录具体优点、遗漏或问题…",
	submitReveal: "提交评分并揭晓", skipReveal: "跳过评分并揭晓", incompleteScores: "请为所有成功结果的每个评价项打分，或选择跳过评分。",
	notReady: "该组仍有结果正在运行，完成后可以评分揭晓。", nothingToScore: "该组没有成功结果，可跳过评分查看失败信息。", saved: "评分已保存", skipped: "已跳过评分",
	duration: "耗时", tokens: "Tokens", fee: "费用（USD）", seconds: "{n}s", progress: "已结束 {done} / {total} 次", finishedHint: "生成完成后，选择题目进行匿名评价。",
	invalidResponse: "服务返回了无效数据，请重新加载。", error: "请求失败", busy: "正在处理…", close: "关闭", save: "保存题目", cancelEdit: "取消", customTitle: "新建自定义题",
	editTitle: "编辑自定义题", taskTitle: "题目名称", category: "题型", prompt: "完整提示词", input: "固定输入（可选）", version: "版本", origin: "来源",
	output: "预期输出", customHint: "填写完整提示词与固定输入。自定义题默认检查格式，其他要求由人工评价。", taskValidation: "请填写题目名称、完整提示词与三个评价项。",
	rubricLabel: "评价项 {n}", rubricDescription: "评分说明", taskSaved: "自定义题已保存", emptyHistory: "还没有运行记录", historyDesc: "每次测评都保留题目、配置、回答、失败和评价。",
	historyCount: "{n} 次测评", automaticPass: "自动检查通过", manualAverage: "人工评价均分", averageTime: "平均耗时", knownCost: "已知费用合计（USD）",
	summaryDesc: "按题型比较；样本数量、未检查和未评分分别显示。", summaryHidden: "先完成或跳过匿名评分，才能查看该组模型指标。",
	model: "模型配置", sampleCount: "结果数", scoredCount: "已评分", uncheckedCount: "未检查", failures: "失败", noSummary: "这一题型没有已揭晓结果。",
	partialCost: "{n} 个结果费用未知", partialTime: "{n} 个结果耗时未知", duplicateProfile: "已经选择此模型与档位", edit: "编辑", clear: "清空选择", score: "{n} 分",
	ready: "已完成，待评价", allReviewed: "已评价", scope: "{tasks} 题 · {profiles} 个配置 · {samples} 次", rawUsage: "输入 {input} / 输出 {output}", selectLimit: "每次最多选择 30 道题与 12 个模型配置。", actualRequest: "实际请求模型", responseModel: "供应商返回模型", forwardedThinking: "已转发思考参数", providerDefault: "供应商默认", modelMismatch: "返回模型：{model}",
} as const;

const en: { [K in keyof typeof zh]: string } = {
	title: "Model evaluation", local: "Local", offline: "Local service disconnected", reconnect: "Reload", loading: "Loading evaluation data…",
	newRun: "New evaluation", evaluation: "Evaluation", library: "Task library", history: "Run history", summary: "Summary", currentRun: "Current evaluation",
	direct: "Direct answers", directHint: "Fixed tasks in fresh contexts, without chat history or tools.", noRuns: "Start your first model evaluation",
	noRunsHint: "Compare configured models on the same tasks: artifacts, quality, speed and cost.", createTitle: "Create an evaluation", createDesc: "Choose tasks and model configurations to compare real answers.",
	selectTasks: "Choose tasks", selectModels: "Choose models", runConfig: "Run settings", quickPack: "Six-task quick pack", quickPackHint: "Creation, editing, tables, forms, money and request races",
	all: "All", custom: "Custom", svg: "SVG", html: "HTML", code: "Code", searchTasks: "Search task, ID or prompt", searchRuns: "Search evaluation names",
	selected: "{n} selected", details: "View details", copy: "Copy as custom task", addTask: "Add to evaluation", noTasks: "No matching tasks", noModels: "No models available",
	noModelsHint: "Configure a model and account in Settings, then refresh this page.", defaultThinking: "Default", unsupportedThinking: "This model has no selectable thinking levels",
	modelConfig: "{model} · {level}", samples: "Runs per task", runName: "Evaluation name", runNamePlaceholder: "For example: Everyday coding models", tasksCount: "Tasks", profilesCount: "Configurations",
	calls: "API calls", estimatedCost: "Estimated cost", unknown: "Unknown", costHint: "Actual cost depends on input, output and model pricing; it is unknown before running.", start: "Start evaluation",
	startHint: "This calls the selected models and incurs their normal API usage and charges.", createdAt: "Created", runStatus: "Status", completed: "Completed", running: "Running", queued: "Queued",
	failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", pending: "Awaiting review", open: "View results", refresh: "Refresh", cancel: "Cancel remaining calls",
	appendThree: "Extend to 3 samples", appendFive: "Extend to 5 samples", retry: "Retry this result", retryHint: "Retry creates a new call and retains the original failed result.", sample: "Sample {n}", attempt: "Attempt {n}",
	results: "Compare results", rubric: "Scoring criteria", anonymous: "Anonymous review", anonymousHint: "Review artifacts and checks first. Scoring reveals models, speed and cost.",
	revealed: "Model details revealed", revealHint: "Artifact order is unchanged. Compare quality, speed and cost.", result: "Result {letter}", hiddenIdentity: "Model identity and metrics are revealed after review",
	preview: "Preview", source: "Source", answer: "Full answer", analysis: "Thinking", noAnalysis: "The model returned no viewable thinking content.", noArtifact: "No previewable artifact extracted",
	previewHint: "Isolated preview; external resources and network requests are blocked.", expand: "Expand preview", download: "Download artifact", automatic: "Automatic checks", passed: "Passed", unchecked: "Unchecked",
	checksEmpty: "Automatic checks have not completed.", manual: "Human review", scoreScale: "1–5", notes: "Review notes", notesPlaceholder: "Record strengths, omissions or problems…",
	submitReveal: "Submit scores and reveal", skipReveal: "Skip scoring and reveal", incompleteScores: "Score every criterion for all successful results, or skip scoring.",
	notReady: "Some results are still running. Review and reveal when the group finishes.", nothingToScore: "No successful results in this group. Skip scoring to see failure details.", saved: "Scores saved", skipped: "Scoring skipped",
	duration: "Duration", tokens: "Tokens", fee: "Cost (USD)", seconds: "{n}s", progress: "{done} / {total} calls finished", finishedHint: "When generation finishes, select a task for anonymous review.",
	invalidResponse: "Invalid data returned by the service. Reload to continue.", error: "Request failed", busy: "Working…", close: "Close", save: "Save task", cancelEdit: "Cancel", customTitle: "Create a custom task",
	editTitle: "Edit custom task", taskTitle: "Task name", category: "Category", prompt: "Full prompt", input: "Fixed input (optional)", version: "Version", origin: "Source",
	output: "Expected output", customHint: "Provide the full prompt and fixed input. Custom tasks receive format checks; other requirements are reviewed manually.", taskValidation: "Enter a title, full prompt and three scoring criteria.",
	rubricLabel: "Criterion {n}", rubricDescription: "Scoring guidance", taskSaved: "Custom task saved", emptyHistory: "No evaluation runs yet", historyDesc: "Every evaluation retains tasks, settings, answers, failures and reviews.",
	historyCount: "{n} evaluations", automaticPass: "Automatic pass", manualAverage: "Mean human score", averageTime: "Mean duration", knownCost: "Known total cost (USD)",
	summaryDesc: "Compare by category, with sample counts, unchecked results and unscored results shown separately.", summaryHidden: "Review or skip anonymous scoring to view model metrics for this group.",
	model: "Model configuration", sampleCount: "Results", scoredCount: "Scored", uncheckedCount: "Unchecked", failures: "Failures", noSummary: "No revealed results in this category.",
	partialCost: "{n} results have unknown cost", partialTime: "{n} results have unknown duration", duplicateProfile: "This model and thinking level is already selected", edit: "Edit", clear: "Clear selection", score: "{n} points",
	ready: "Completed, awaiting review", allReviewed: "Reviewed", scope: "{tasks} tasks · {profiles} configurations · {samples} samples", rawUsage: "Input {input} / output {output}", selectLimit: "Select up to 30 tasks and 12 model configurations per evaluation.", actualRequest: "Requested model", responseModel: "Provider response model", forwardedThinking: "Forwarded thinking parameter", providerDefault: "Provider default", modelMismatch: "Response model: {model}",
};

export type EvaluationText = (key: keyof typeof zh, vars?: Record<string, string | number>) => string;

export function useEvaluationText(): EvaluationText {
	useT();
	return (key, vars) => (getUiLanguage() === "en" ? en[key] : zh[key]).replace(/\{(\w+)\}/g, (raw, name: string) => vars && name in vars ? String(vars[name]) : raw);
}
