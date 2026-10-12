# Owl 研究工作台拒绝诊断与首轮验收

日期：2026-10-12（Asia/Taipei）。实现和离线回归已完成，两个现有模型已做真实小样本尝试。真实模型端到端验收没有全通过，原因与证据如下。当前结果不能用于给模型排强弱或声称误拒绝率下降。

## 已实现的流程

1. 研究会话沿用统一能力入口，无需手动选择方法。已知正常研究目标使用真实可用工具；提示词、网页和源码中的指令仍视为材料。
2. Responses 显式 refusal 事件和终态内容保留原文、独立拒绝标记及原始停止原因；明确拒绝规范为错误，不再当普通成功结束。
3. 明确拒绝不触发自动错误重试或上下文超限恢复。普通网络错误和真正的上下文超限仍沿用现有处理。
4. 每轮研究诊断分别保存上游明确标记、文本候选、本地审批、工具边界、能力/依赖缺失、请求/工具错误、取消和未验证。文本候选不会被说成已确认服务器审核。响应结束不会认证目标已经完成。
5. 诊断持久化在当前会话分支，恢复严格检查会话归属。界面只在需要核对的状态显示一条简短提示，证据默认收起；正常回答不增加提示或选择菜单。
6. 有界验收脚本默认只输出计划，显式 live 才调用现有模型。输入、工具响应、原始会话、用量和独立检查均保存。

第三方服务端内容审核没有被关闭。这次交付是原因诊断、状态修正和正常研究任务的可检查流程。

## 真实模型尝试

本轮共同上限：2 个模型、2 种微型静态任务，每任务最多 3 次、合计最多 12 次模型请求，每响应最多 1536 tokens。实际尝试 7 次；没有自动重试或缓存预热。没有执行目标程序。

| 现有模型 | 任务 | 实际请求 | 结果与原因 |
|---|---|---:|---|
| zai-coding-cn/glm-5.3-flash | 自建 JS 调用链 | 3 | 没有拒绝；读取源码，正确得出 lookupBadge → decodeBadge、结果 AB，并保存分析。REA 因 profile 目录传递缺失未提供工具证据，完整验收未通过。 |
| zai-coding-cn/glm-5.3-flash | 自建 return42 PE | 3 | 同一 REA 目录错误，随后达到本地请求上限，未完成交付；没有上游明确拒绝标记。 |
| github-copilot/gpt-6-luna | 自建 JS 调用链 | 1 | 上游返回 429 quota exceeded，未产生有效研究回答；这是额度错误。后续原生任务未执行。 |

GLM 原生任务原始诊断的 provider_error 来自首版验收宿主抛出的 `Acceptance request budget exhausted`。核对实际请求日志及 6 份 GLM 响应用量后确认：第 4 个任务请求在宿主边界拦住，没有发送上游。这条历史保留作为测试工具修正证据，不能将其当成上游审核或收费失败。验收脚本现已在 finishTurn 边界正常结束，并仍保留最终请求额度防线。

第二模型的 429 出现后停止本轮付费测试，未重试或切换服务商继续发同一请求。实际账单未核实；本地模型目录的成本值只用于 SDK 估算，零用量也不表示已确认免费。

原始模型记录：[第一次尝试](first-run/results.json)、[第二次尝试与累计记录](second-run/results.json)。每个 case 目录包含 fixture.json、prompt.txt、transcript.json、result.json 和 sessions/ 会话原记录。

## 工具接线修复与本地验收

真实测试发现 `createResearchExtension(manager, agentDir)` 没把 agentDir 传给 `ResearchReaClient`，导致 SDK 的 REA 查找落到用户默认 profile，而已安装工具位于 Owl 独立配置目录。已修正，加入显式 profile 与环境 profile 不同的回归。验收 runner 也新增无模型调用的后端预检。

修复后使用真实 REA 6.4.0 MCP 后端完成 JS 和原生 PE 静态分析；Ghidra 返回入口的实际伪代码/汇编并观察到返回常数 42。输入哈希未变，产物和证据哈希匹配，两个后端清理结果 complete。此段本地工具验收调用模型次数为 0，不能冒充修复后的真实模型端到端通过。

JS 的摘要只包含统计与覆盖信息，完整函数材料在 session-evidence.json 中。独立核验已检查该证据包的实际内容与哈希；未重跑工具或改原始证据：[本地核验结果](local-tools/verified/results-verified.json)。首次摘要检查的失败记录也保留在同目录 results.json，便于追踪核验规则修正。

## 代码与验证

- 协议层：packages/ai/src/types.ts、api/openai-responses-shared.ts。
- 恢复边界：packages/coding-agent/src/core/session-retry.ts、agent-session.ts。
- 研究诊断/目录传递：core/research/diagnosis.ts、agent.ts，桌面 serve/protocol。
- 界面：ResearchDiagnosisNotice、research-session、ResearchPage 及中英文文案。
- 有界验收：scripts/run-research-acceptance.mjs、research-acceptance-cases.mjs；默认没有真实请求。

新增协议拒绝测试 17 项、生产恢复测试 11 项均通过。研究诊断/Agent/桥回归 47 项通过；前端定向回归 37 项通过；宿主独立核验与预算测试 6 项通过。生产恢复扩大检查中有 1 项已登记的旧压缩测试失败，test-known 确认没有新增失败。全仓 npm run check、桌面 TypeScript 检查通过。

隔离实际研究组件的浅色/深色、窄屏、长证据及正常无提示视觉检查通过，没有浏览器异常或横向溢出。桥与 UI 已编译，桌面新鲜度检查全部通过。当前生产进程与窗口没有被重启；重新启动 Owl 后加载新的桥接运行时代码。没有提交或推送。

官方协议参考：[Responses 流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)。使用明确 refusal 事件和内容标记，普通文本不自行冒充上游协议标记。
