import { getUiLanguage, useT } from "../../i18n/index.ts";

const zh = {
	title: "研究助手", newChat: "新对话", newWhileRunning: "请先停止当前任务，再开始新对话。", browser: "浏览器", results: "查看结果", closeResults: "收起结果", emptyTitle: "你想研究什么？",
	emptyHint: "发一个网址，或者说说你想得到什么。", emptyDetail: "我来帮你分析，具体做法交给我。", exampleCrawl: "整理网页资料", exampleWeb: "找到页面数据来源", exampleModel: "测试模型边界",
	crawlDraft: "帮我整理这个网站的资料，先给我看一份少量样本，保留每条记录的来源：", webDraft: "帮我分析这个网页的数据从哪里来，用我能理解的方式解释请求与参数：", modelDraft: "帮我设计一组模型与 Agent 规则边界测试。先明确测试目标和判定依据，给我看方案，再执行。",
	modePrefix: "研究", modeAuto: "自动识别", modeCrawl: "网页采集", modeWeb: "Web / JS 逆向", modeModel: "模型对抗", modeOsint: "公开情报", modeHint: "告诉我目标就好", modeLabel: "研究方向",
	restoring: "正在恢复研究对话…", disconnected: "本地服务已断开，连接恢复后会继续同步。", retry: "重新连接对话", retrySend: "重试发送", errorTitle: "暂时无法继续", sources: "来源", data: "数据", findings: "发现", fact: "有据发现", inference: "推测", unverified: "待核实",
	sample: "样本", partial: "部分结果", complete: "已整理", records: "{n} 条记录", sourceCount: "{n} 个来源", view: "查看内容", continue: "继续处理", explain: "解释一下", continueDraft: "请继续处理「{title}」的后续内容，沿用已核对的字段和范围，保留来源。", explainDraft: "请用大白话解释「{title}」的发现和依据，区分已确认的信息、推测和待核实内容。",
	exportCsv: "导出 CSV", exportJson: "导出 JSON", noRows: "这个结果以文字发现为主。", noSources: "尚未提供可复核来源。", showSources: "查看来源与依据", backToData: "返回数据", openSource: "打开来源", sourceNote: "来源说明", publishedAt: "整理于 {time}", nextHint: "想调整字段或继续研究，直接在对话里说。", sending: "正在提交…", sourceFailed: "无法打开来源。",
	restoreFailed: "无法恢复研究对话。", wrongWorkspace: "保存的对话不属于当前研究工作区。", createFailed: "无法创建研究对话。", sendFailed: "研究消息发送失败。", stopFailed: "无法停止当前研究任务。", settingsFailed: "研究设置修改失败。",
} as const;

const en: { [K in keyof typeof zh]: string } = {
	title: "Research assistant", newChat: "New chat", newWhileRunning: "Stop the current task before starting a new conversation.", browser: "Browser", results: "View results", closeResults: "Close results", emptyTitle: "What would you like to research?",
	emptyHint: "Share a URL or describe the outcome you want.", emptyDetail: "I will help analyze it and handle the details.", exampleCrawl: "Organize web information", exampleWeb: "Find the page's data source", exampleModel: "Test model boundaries",
	crawlDraft: "Help organize information from this website. Show a small sample first and keep a source for every record: ", webDraft: "Help find where this webpage gets its data. Explain the requests and parameters in plain language: ", modelDraft: "Help design tests of model and Agent rule boundaries. First define the goals and decision criteria and show the plan before executing it.",
	modePrefix: "Research", modeAuto: "Auto detect", modeCrawl: "Web collection", modeWeb: "Web / JS analysis", modeModel: "Model adversarial testing", modeOsint: "Public intelligence", modeHint: "Just describe your goal", modeLabel: "Research direction",
	restoring: "Restoring your research conversation…", disconnected: "The local service is disconnected. Synchronization resumes when it reconnects.", retry: "Reconnect conversation", retrySend: "Retry sending", errorTitle: "Unable to continue yet", sources: "Sources", data: "Data", findings: "Findings", fact: "Evidence-backed", inference: "Inference", unverified: "Unverified",
	sample: "Sample", partial: "Partial results", complete: "Organized", records: "{n} records", sourceCount: "{n} sources", view: "View content", continue: "Continue", explain: "Explain this", continueDraft: "Please continue processing the remaining work for “{title}”, keeping the verified fields and scope, with sources.", explainDraft: "Please explain the findings and evidence for “{title}” in plain language, separating confirmed information, inference and unverified content.",
	exportCsv: "Export CSV", exportJson: "Export JSON", noRows: "This result primarily contains written findings.", noSources: "No verifiable sources have been provided yet.", showSources: "View sources and evidence", backToData: "Back to data", openSource: "Open source", sourceNote: "Source note", publishedAt: "Organized {time}", nextHint: "Ask in chat to change fields or continue the research.", sending: "Submitting…", sourceFailed: "Could not open the source.",
	restoreFailed: "Could not restore the research conversation.", wrongWorkspace: "This saved conversation does not belong to this research workspace.", createFailed: "Could not create the research conversation.", sendFailed: "Could not send the research message.", stopFailed: "Could not stop the research run.", settingsFailed: "Could not update the research settings.",
};

export type ResearchText = (key: keyof typeof zh, vars?: Record<string, string | number>) => string;
export const researchText: ResearchText = (key, vars) => (getUiLanguage() === "en" ? en[key] : zh[key]).replace(/\{(\w+)\}/g, (raw, name: string) => vars && name in vars ? String(vars[name]) : raw);
export function useResearchText(): ResearchText {
	useT();
	return researchText;
}
