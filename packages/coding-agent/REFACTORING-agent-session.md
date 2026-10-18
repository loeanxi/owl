# AgentSession 拆分方案

`src/core/agent-session.ts` 当前 4291 行、约 120 个成员，是 coding-agent 的耦合中心。
本文件记录职责地图、切割顺序和每刀的安全网，方便后续按可回滚的小步推进。

## 为什么不直接大拆

- 生产侧真正运行时耦合只有 `src/core/sdk.ts` 一处 value import，其余 9 处引用全是 `import type`，
  所以**改内部实现几乎零编译期风险**；真正的契约面是 `src/index.ts` 导出的 9 个符号 +
  `AgentSessionEvent` 联合类型。
- 测试面很厚（35 个 agent-session 命名文件、约 350 个 case，另有 76 个文件经 `test/suite/harness.ts` 间接覆盖）。
- 但 `test/agent-session-concurrent.test.ts` 在 `test/known-failures.txt` 里被 `> *` 整文件豁免，
  **并发 prompt 守卫目前没有失败检测能力**，不能当安全网用。

## 职责簇地图（按方法行号聚类）

| 簇 | 行号区间 | 估算行数 | 代表成员 |
| --- | --- | --- | --- |
| A 鉴权与模型解析 | 575-731 | ~150 | `_getRequiredRequestAuth`、`routedModel` |
| B 工具钩子与嵌套调用 | 732-867 | ~150 | `_afterToolCall`、`_executeNestedToolCall` |
| C 压缩阈值与轮次边界 | 908-1211 | ~360 | `_installAgentRequestProjection`、`_dispatchTurnEndBoundary` |
| D 事件发射 / idle / settle | 1211-1577 | ~600 | `_handleAgentEvent`、`_emitAgentSettled` |
| E 只读状态访问器 | 1582-1638 | ~90 | `state`、`model`、`messages` |
| F 工具注册与系统提示词 | 1639-1962、3852-4036 | ~450 | `_refreshToolRegistry`、`_rebuildSystemPrompt` |
| G 运行与输入队列 | 1963-2772 | ~700 | `prompt`、`steer`、`followUp` |
| H 模型 / thinking 变更 | 2784-3048 | ~270 | `setModel`、`cycleThinkingLevel` |
| I 压缩（手动 + 自动） | 3049-3589 | ~540 | `compact`、`_checkCompaction`、`_runAutoCompaction` |
| J 扩展绑定 / 重载 / 重试 | 3591-4118 | ~440 | `_bindExtensionCore`、`reload` |
| K bash / 会话 / 统计门面 | 4119-4291 | ~200 | `executeBash`、`getSessionStats`、`getLastAssistantText` |

最大耦合点是 `prompt()`(190 行)、`_handleAgentEvent`(102)、`_checkCompaction`(152)、
`_runAutoCompaction`(152)、`compact()`(150)、`_emitAgentSettled`(127)、`_bindExtensionCore`(142)、
`_refreshToolRegistry`(118)。这些是状态机，跨簇且带 abort / 扩展 / 持久化语义，**必须先造缝再搬**。

## 切割顺序

每刀一个提交，测试通过 + `tsc --noEmit` 通过才进下一刀。

1. **已完成：K 簇的只读报告部分** → `agent-session-reporting.ts`
   搬走 `getSessionStats` / `getContextUsage` / `exportToJsonl` / `getLastAssistantText` 的实现，
   类里保留同名一行委托，公开 API 字节级不变。
   配套改动：`_limitsModel()` 由 private 提升为 `limitsModel()`，让窄接口 `SessionReportingSource` 能拿到模型上限。
2. **已完成：B 簇工具暴露判定** → `tool-exposure.ts`
   `_isAllowedTool` / `_getToolExposure` / `_isDeclarable` / `_isActivatedOnRegistration` 的判定逻辑
   抽成纯函数，类里保留一行参数组装的薄封装；`ToolDefinitionEntry` 一并搬出。
   `_getCallableTools` 里的 codemode/deferred/direct 三分支提成 `isCallableExposure`。
   新增 `test/tool-exposure.test.ts`（26 个用例）——这些分支原先只能靠 AgentSession 集成测试间接覆盖。
3. **A 簇鉴权投影** → `agent-session-auth.ts`
   `_getRequiredRequestAuth`、`_getSummarizationRequestAuth`、`_modelForMessage`、`_capRequestThinking`、
   `recordRequestOutputBudget` 都只读 model/settings，拆成收显式参数的函数。
4. **H 簇模型 / thinking 变更** → `agent-session-model-cycle.ts`
   纯状态迁移，逻辑线性，可整簇搬。
5. **I 簇压缩** → `agent-session-compaction.ts`（大刀，需先造缝）
   先把 `_checkCompaction` 的阈值判定提成纯函数并补单测，再搬 `_runAutoCompaction` / `compact`。
6. **C 簇边界与预览** → `agent-session-boundary.ts`
7. D 簇与 G 簇最后动：`_handleAgentEvent` 和 `prompt()` 是整个类的枢纽，最后处理。

## 每刀验证

```bash
# 类型（包级，最窄）
cd packages/coding-agent && npx tsc -p tsconfig.build.json --noEmit

# agent-session 相关测试（35 文件，约 40s），并区分新旧失败
cd packages/coding-agent && node scripts/test-known.mjs \
  test/agent-session-*.test.ts test/suite/agent-session-*.test.ts

# 全仓类型 + 风格
cd ../.. && npm run check
```

`node scripts/test-known.mjs` 会把不在 `test/known-failures.txt` 里的失败单独报为 NEW failures，
是判断"这刀有没有弄坏东西"的标准手段。

注意：不要跑 `npm test` / `test.sh`（全 workspace、分钟级，AGENTS.md 明确禁止）。
