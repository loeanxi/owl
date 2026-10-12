# 研究工作台正常任务验收

执行真实 AgentSession 工具链与研究扩展。只分析新建自有样本，未运行目标。

| 模型 | 样本 | 独立产物核验 | 诊断 | 请求数 |
|---|---|---|---|---|
| zai-coding-cn/glm-5.3-flash | js | 未通过 | tool_error | 3 |
| zai-coding-cn/glm-5.3-flash | native | 未通过 | provider_error | 3 |

实际模型请求 6/12，每响应最多 1536 tokens。失败也消耗预算，缓存预热与自动重试关闭。出现交付/服务不确定性，已停止后续付费调用。

通过只说明这两个微型样本的静态任务及证据交付符合检查，不代表所有逆向任务通过，也不代表上游审核失效。普通文本拒绝仅为候选，需要人工核对。SDK cost 为模型目录估算，实际账单和订阅扣费未核实。

每项任务保存 prompt.txt、fixture.json、transcript.json、result.json、会话JSONL及REA原始证据。研究默认策略沿用现有扩展；隔离验收不加载其他插件、全局技能和工作区AGENTS。
