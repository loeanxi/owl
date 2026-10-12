/** Opt-in paid acceptance run. Default is a no-network plan. Normal test suites never import this runner. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "../packages/ai/dist/index.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../packages/coding-agent/dist/core/agent-session-services.js";
import { ModelRuntime } from "../packages/coding-agent/dist/core/model-runtime.js";
import { createResearchExtension, RESEARCH_MODE_ENTRY } from "../packages/coding-agent/dist/core/research/agent.js";
import { getResearchDiagnosis } from "../packages/coding-agent/dist/core/research/diagnosis.js";
import { ResearchReaClient } from "../packages/coding-agent/dist/core/research/rea-client.js";
import { SessionManager } from "../packages/coding-agent/dist/core/session-manager.js";
import { SettingsManager } from "../packages/coding-agent/dist/core/settings-manager.js";
import { desktopAgentPromptOptions } from "../packages/coding-agent/dist/modes/desktop/agent-instructions.js";
import { ACCEPTANCE_LIMITS, allowedAcceptanceTool, casePrompt, hash, prepareCase, requestBudget, verifyCase } from "./research-acceptance-cases.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const profile = resolve(option("--agent-dir", process.env.OWL_CODING_AGENT_DIR ?? join(repo, "..", "data", "owl")));
const root = resolve(option("--output", join(repo, ".validation", "research-acceptance-20261012", randomUUID())));
const modelSpecs = option("--models", "zai-coding-cn/glm-5.3-flash,github-copilot/gpt-6-luna").split(",");
if (modelSpecs.length < 1 || modelSpecs.length > ACCEPTANCE_LIMITS.models || new Set(modelSpecs).size !== modelSpecs.length) throw new Error("At most two distinct explicit models are permitted");
const plan = { models: modelSpecs, cases: ["js", "native"], limits: ACCEPTANCE_LIMITS, retries: 0, cacheWarming: "off", targetExecuted: false, scope: "fresh source-owned static fixtures only", live: args.includes("--live") };
if (!plan.live) {
	console.log(JSON.stringify(plan, null, 2));
} else {
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
	const budget = requestBudget();
	const reaInventory = await new ResearchReaClient("acceptance-preflight", { agentDir: profile }).inventory();
	await writeFile(join(root, "preflight.json"), `${JSON.stringify(reaInventory, null, 2)}\n`, { flag: "wx" });
	if (reaInventory.status !== "available") throw new Error(`REA preflight failed: ${reaInventory.message}`);
	const priorPath = option("--prior-results");
	let prior;
	if (priorPath) {
		prior = JSON.parse(await readFile(resolve(priorPath), "utf8"));
		if (JSON.stringify(prior.plan?.limits) !== JSON.stringify(ACCEPTANCE_LIMITS) || !Array.isArray(prior.results)) throw new Error("Prior run has incompatible limits");
		if (new Set([...prior.results.map(result => result.model), ...modelSpecs]).size > ACCEPTANCE_LIMITS.models) throw new Error("Shared model limit exhausted");
		for (const result of prior.results) {
			const transcript = JSON.parse(await readFile(join(result.cwd, "transcript.json"), "utf8"));
			if (result.executionError || transcript.messages.some(message => message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error" && message.errorMessage !== "Acceptance request budget exhausted" && !message.refusal))) throw new Error("Prior model delivery is uncertain; do not repeat requests");
			for (const request of result.requests) budget.claim(`${request.provider}/${request.model}:${result.case}`);
		}
		if (budget.attempts !== prior.attempts) throw new Error("Prior accounting is inconsistent");
	}
	const runtime = await ModelRuntime.create({ authPath: join(profile, "auth.json"), modelsPath: join(profile, "models.json"), allowModelNetwork: false });
	const stream = runtime.streamSimple.bind(runtime);
	const summaries = [];
	let current;
	let uncertainDelivery = false;
	// This is the actual model-runtime boundary used by AgentSession, including recovery attempts.
	runtime.streamSimple = (model, context, options = {}) => {
		if (!current) throw new Error("No acceptance case owns this request");
		const claimed = budget.claim(current.id);
		current.requests.push({ ...claimed, provider: model.provider, model: model.id, maxTokens: ACCEPTANCE_LIMITS.outputTokens, at: new Date().toISOString() });
		return stream(model, context, { ...options, maxTokens: ACCEPTANCE_LIMITS.outputTokens, maxRetries: 0 });
	};
	for (const spec of modelSpecs) {
		for (const kind of plan.cases) {
			if (uncertainDelivery) break;
			const separator = spec.indexOf("/");
			const model = runtime.getPhysicalModel(spec.slice(0, separator), spec.slice(separator + 1));
			if (!model || !runtime.hasConfiguredAuth(model.provider)) throw new Error(`Configured model unavailable: ${spec}`);
			const cwd = join(root, spec.replaceAll("/", "--"), kind);
			const manifest = await prepareCase(cwd, kind);
			const prompt = casePrompt(kind);
			await writeFile(join(cwd, "prompt.txt"), prompt, { flag: "wx" });
			const manager = SessionManager.create(cwd, join(cwd, "sessions"));
			manager.appendCustomEntry(RESEARCH_MODE_ENTRY, { mode: "auto" });
			const events = [];
			current = { id: `${spec}:${kind}`, requests: [] };
			const scopeGuard = (api) => api.on("tool_call", (event) => allowedAcceptanceTool(cwd, kind, event) ? undefined : { block: true, reason: "Acceptance fixture scope: this tool or target is outside the static case" });
			const settings = SettingsManager.inMemory({ requestMaxTokens: ACCEPTANCE_LIMITS.outputTokens, agentMaxTurns: ACCEPTANCE_LIMITS.rounds, cacheWarming: "off", transport: "sse", compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } });
			const services = await createAgentSessionServices({ cwd, agentDir: profile, modelRuntime: runtime, settingsManager: settings, resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [createResearchExtension(manager, profile), scopeGuard], ...desktopAgentPromptOptions(),
			} });
			const supported = getSupportedThinkingLevels(model);
			const thinking = supported.includes("off") ? "off" : supported.includes("minimal") ? "minimal" : "low";
			const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, thinkingLevel: thinking, tools: ["read", "write", "research_rea", "research_checkpoint"], toolActivation: "eager" });
			session.setAutoRetryEnabled(false);
			const finishTurn = session.agent.finishTurn;
			session.agent.finishTurn = async (turn, signal) => {
				const decision = await finishTurn?.(turn, signal);
				if (current.requests.length >= ACCEPTANCE_LIMITS.rounds) return { action: "end" };
				return decision;
			};
			session.subscribe(event => {
				if (["agent_start", "agent_end", "agent_settled", "tool_execution_start", "tool_execution_end", "entry_appended"].includes(event.type)) events.push(event);
			});
			const deadline = setTimeout(() => void session.abort(), 240_000);
			let executionError;
			console.log(JSON.stringify({ phase: "start", model: spec, case: kind, remainingCalls: ACCEPTANCE_LIMITS.calls - budget.attempts }));
			try { await session.prompt(prompt); } catch (error) { executionError = error instanceof Error ? error.message : String(error); }
			finally {
				clearTimeout(deadline);
				await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			}
			const messages = session.messages;
			const diagnosis = getResearchDiagnosis(manager);
			const assistants = messages.filter(message => message.role === "assistant");
			const verified = await verifyCase(cwd, manifest, messages);
			const hasProviderFailure = assistants.some(message => message.stopReason === "error" && !message.refusal);
			// Fail closed after transport/provider uncertainty; a new run requires explicit user budgeting.
			if (executionError || hasProviderFailure || assistants.some(message => message.stopReason === "aborted")) uncertainDelivery = true;
			const summary = { model: spec, case: kind, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), thinking, requests: current.requests, diagnosis, ...verified, executionError, roundBudgetReached: current.requests.length >= ACCEPTANCE_LIMITS.rounds, usage: assistants.map(message => ({ provider: message.provider, model: message.model, stopReason: message.stopReason, rawStopReason: message.rawStopReason, refusal: message.refusal, usage: message.usage })), billing: "SDK costs are catalog estimates; actual subscription/API charges are not verified", systemPromptSha256: hash(session.systemPrompt), cwd };
			await writeFile(join(cwd, "transcript.json"), `${JSON.stringify({ messages, events }, null, 2)}\n`, { flag: "wx" });
			await writeFile(join(cwd, "result.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
			summaries.push(summary);
			session.dispose();
			console.log(JSON.stringify({ phase: "result", model: spec, case: kind, passed: verified.passed, diagnosis: diagnosis?.status, requests: current.requests.length, checks: verified.checks }));
			await writeFile(join(root, "results.json"), `${JSON.stringify({ plan, attempts: budget.attempts, uncertainDelivery, priorResults: priorPath ? resolve(priorPath) : undefined, results: [...(prior?.results ?? []), ...summaries] }, null, 2)}\n`);
		}
		if (uncertainDelivery) break;
	}
	const rows = summaries.map(result => `| ${result.model} | ${result.case} | ${result.passed ? "通过" : "未通过"} | ${result.diagnosis?.status ?? "unknown"} | ${result.requests.length} |`).join("\n");
	const report = `# 研究工作台正常任务验收\n\n执行真实 AgentSession 工具链与研究扩展。只分析新建自有样本，未运行目标。\n\n| 模型 | 样本 | 独立产物核验 | 诊断 | 请求数 |\n|---|---|---|---|---|\n${rows}\n\n实际模型请求 ${budget.attempts}/${ACCEPTANCE_LIMITS.calls}，每响应最多 ${ACCEPTANCE_LIMITS.outputTokens} tokens。失败也消耗预算，缓存预热与自动重试关闭。${uncertainDelivery ? "出现交付/服务不确定性，已停止后续付费调用。" : ""}\n\n通过只说明这两个微型样本的静态任务及证据交付符合检查，不代表所有逆向任务通过，也不代表上游审核失效。普通文本拒绝仅为候选，需要人工核对。SDK cost 为模型目录估算，实际账单和订阅扣费未核实。\n\n每项任务保存 prompt.txt、fixture.json、transcript.json、result.json、会话JSONL及REA原始证据。研究默认策略沿用现有扩展；隔离验收不加载其他插件、全局技能和工作区AGENTS。\n`;
	await writeFile(join(root, "report.md"), report, { flag: "wx" });
	console.log(JSON.stringify({ phase: "complete", report: join(root, "report.md"), attempts: budget.attempts, stoppedForUncertainty: uncertainDelivery }));
}
