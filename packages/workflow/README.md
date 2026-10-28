# @owl/workflow

Dynamic workflow orchestration, ported from ZCode's `CreateWorkflow` mechanism
(逆向依据:`D:\owl\rea\dynamic-workflows-逆向报告.md`)。

## 一句话架构

**脚本编译(lowering)后在子进程的 `node:vm` 沙箱里跑;沙箱唯一的全局是 `__host`,
每个 facade 调用都是一条 NDJSON 过 stdio 到主进程;引擎把每个调用落成 journal
节点((siteId, ordinal) 主键),已完成节点在 resume/amend 时按序零成本重放。**

## 模块

| 文件 | 职责 | ZCode 对应物 |
|---|---|---|
| `facade.ts` | 脚本看到的宿主环境声明(类型检查依据) | SKILL.md §16.2 facade |
| `compile.ts` | facade 类型检查 → 站点枚举(文档序)→ lowering 到 `__host.*` | `jSt`/`aae` @zcode.cjs |
| `sandbox.ts` | vm 沙箱引导(协议 shim + channel/future + 停滞检测 + Date/Math.random 禁令)、子进程 spawn | child bootstrap @14.2578M |
| `journal.ts` | JSONL 追加式 journal(run 头 + 节点 + 事件) | `dwf_run`/`dwf_node`/`dwf_event`(SQLite) |
| `engine.ts` | ask 准入(journal 重放 → amend 导入 → live)、world 读、hole 登记、终态机 | `ZSe` WorkflowEngine + `qSt` AskScheduler |
| `runner.ts` | startRun / resumeRun / amendRun / buildImportedCache | 启动链 + `buildImportedCache`(M4n) |
| `driver.ts` | `WorkflowDriver` 接口 + ScriptedDriver(测试/开发) | driver.executeAsk / executeWorldRead |
| `driver-node.ts` | 真实驱动:`NodeWorldDriver`(files/git/world.run 真实执行)+ `PiAgentDriver`(每 ask 一个 owl 子进程,`--mode json` 事件流解析,`--append-system-prompt` 挂 persona,统计 `worldToolCalls`) | 子 agent 会话 + driver 的真实执行 |

## 真实驱动

```js
import { NodeWorldDriver, PiAgentDriver } from "@owl/workflow";

const driver = {
	world: new NodeWorldDriver(cwd),
	agent: new PiAgentDriver({
		cwd,
		owlCommand: process.execPath,                       // 或 "owl"(PATH 上)
		owlArgsPrefix: ["packages/coding-agent/dist/bundle/cli.js"],
		model: "zai-coding-cn/glm-5.3-flash",               // provider 限定
		env: { OWL_CODING_AGENT_DIR: "…/data/owl" },        // 指定配置目录(auth/models)
		timeoutMs: 180_000,
	}),
	async executeAsk(req) { return this.agent.executeAsk(req); },
	async executeWorldRead(op, args) { return this.world.execute(op, args); },
};
```

要点:

- **错误传导**:owl 子进程的模型错误(402、网络等)在事件流里
  (`turn_end.stopReason === "error"`),退出码仍是 0——driver 会把它 reject 出去,
  引擎按 failed ask 落 journal,不会静默变成空结果。
- **缓存关闭规则**:`worldToolCalls` 统计 WRITE_TOOLS(bash/write/edit/powershell);
  live ask 报告 >0 时引擎关闭 amend 导入缓存(ZCode 的 closeImportCache 语义)。
- world.run 非零退出是**值**不是异常(ZCode 同款语义);只有 spawn 失败/超时才 reject。

真实冒烟:`node scripts/smoke-real.mjs`(一次真实 glob + 两次真实 typed LLM ask,同一会话)。

## owl 扩展接入

`D:\owl\owl-re-v1\data\owl\extensions\workflow\index.ts` 把这套机制暴露成 8 个
agent 工具(jiti 加载 TS,零重建;前置:本包已 `tsc -p tsconfig.json` 构建):

| 工具 | 作用 |
|---|---|
| `workflow_start` | 编译并后台启动 run;返回 runId/阶段/站点统计(编译诊断直接返回给模型修) |
| `workflow_wait` | 阻塞等终态(带超时),返回结果/失败/未填留白/最近事件 |
| `workflow_status` | 即时快照,不等待 |
| `workflow_list` | 本项目全部 run |
| `workflow_amend` | 修订续跑(前驱在跑则一体 supersede) |
| `workflow_fill_hole` | 填留白(站点 eval,effective script 落 journal) |
| `workflow_resume` | 原样续跑 stopped run(字节级同脚本,journal 重放) |
| `workflow_stop` | 停止 |

运行数据落在 `<cwd>/.owl/workflow-runs/<runId>/journal.jsonl`(已 gitignore);
session_shutdown 时本扩展停掉名下全部 run。子 agent 继承父进程的
`OWL_CODING_AGENT_DIR`,即用同一份配置与认证。

## 触发策略(ZCode 是"仅显式触发",owl 改为模型自主判断)

ZCode 刻意把 CreateWorkflow 做成仅用户点名才触发(SKILL 写死),理由:每个 ask
是一个完整模型会话、成本真实,且要过确认窗。owl 的选择:模型自主判断 + 分级闸门,
由 `OWL_WORKFLOW_POLICY` 控制(默认 `auto`):

| policy | 行为 |
|---|---|
| `auto`(默认) | 模型按判定标准自主决定(结果喂后续步骤 / typed 分支循环 / world.run 门禁 / 独立复核 / 可 amend 长流程,预估 ≥3 子任务);自主发起且要开子 agent 时,先 `ask_user_question` 向用户确认成本;用户已点名的直接跑 |
| `explicit` | ZCode 原语义:仅用户点名工作流才用 |
| `always` | 自主判断且免确认(完全放开) |

硬护栏与策略无关:`max_ask_calls` 每 run 的子 agent 调用上限(引擎级,默认 256,
ZCode 为 1000),超限按 `AskCallLimitExceeded` failRun——防模型自主触发时失控。

## 使用中的闸门(全部机械执行,实测过)

| 闸门 | 机制 | 实测 |
|---|---|---|
| **嵌套禁令** | 子 agent 是真实 owl 进程、会加载同一份扩展;PiAgentDriver 给子进程注入 `OWL_WORKFLOW_CHILD=1`,扩展工厂看到该标记直接不注册工具(ZCode `dynamicWorkflowToolsOnDemand:false` 同款) | child 工具数 = 0 |
| **并发上限** | 每会话同时在跑的 run ≤ 3;超限拒绝,错误文案点名在跑的 runId 并指路(wait/stop/改用普通子代理) | 第 4 个 start 被拒 |
| **收放闭环** | `workflow_status` 暴露 pendingHoles(含 siteId)→ fill → run 完成 → 名额释放 | fill 后新 start 成功 |
| **失控护栏** | `max_ask_calls`(引擎级,见上) | 上限 3 → 恰好 3 次 live dispatch 后 failRun |

使用纪律写在工具描述里(模型实际读的就是它):启动前先 `workflow_list` 看存量;
启动后负责到底(wait 或告知用户 runId),不弃跑;wait 超时返回的是快照不是失败,
继续等或汇报进展;有未填留白就填。

## 关键语义(与 ZCode 对齐)

- **确定性**:`Date.now()`/无参 `new Date()`/`Math.random()` 运行期 throw;
  resume 校验脚本 sha256 字节级一致(`ScriptHashMismatch` 拒绝)。
- **重放**:journal 节点按 (siteId, ordinal) 命中,`inputHash`(FNV-1a of
  canonicalJson)不一致直接 failRun——脚本的每次执行必须可重放。
- **amend 缓存**:按 actor 名字导入前驱的已完成 asks(按 actorSeq 顺序 + inputHash
  匹配)和 world 读(inputHash 队列);**首个 live 副作用(live world-run 或
  worldToolCalls>0 的 live ask)关闭导入**,之后只有从未碰过 workspace 的
  "pure" ask 才允许继续吃缓存。
- **hole**:子进程在站点处 `eval` 填充体(闭包该点全部绑定),循环重入从
  `__fills` 直接取;fill 时 journal 内的 run 脚本同步替换为 effective script。
- **停滞检测**:vm cell 无定时器无 IO——"没有在飞请求 + 微任务排空 + 未完成"
  即终结:`ChannelDeadlock`(点名通道)或 `ScriptStalled`。
- **并发**:每 actor 同时只跑一个 ask(队列 FIFO);全局
  `activeAsks < maxConcurrency`。
- **actor 会话延续**:`agent()` 是一个会话、多次 ask 共享上下文(planner-reviewer
  循环的前提)。driver 用 `--session-id` 建会话并续接,persona 只在创建时挂
  (冻结进 system prompt);amend 后 imported actor 的 live ask 带
  `resumeSessionId` 续前驱会话——上下文跨 run 生存。
- **typed ask + 修复循环**:ask<T> 的 T 在编译期变成结果契约(JSDoc → 字段
  description,枚举/数组/对象/字面量联合均支持),契约块追加进 ask 指令;
  引擎对回复做 JSON 提取 + schema 校验,违规打回同一会话自修,预算
  `ASK_REPAIR_BUDGET = 3`,耗尽按 `ValidationFailed` 落 failed 节点。
- **live amend**:本进程在跑的 run,`amendRun` 一次调用完成 stop + supersede
  (`run.supersededBy` 记录接替者);跨进程在跑的 run 拒绝。
- **诊断**:hole 名唯一/字面量(9012)、world.run 命令必须字面量、不支持的
  ask<T> 类型。

## v1 与 ZCode 的差距(按影响排序)

1. **转录播种(messageBoundary)**:ZCode 记录 ask 完成时子会话的消息数并在
   amend 时从边界 fork;v1 用整会话续接替代(上下文保真,无需边界),in-flight
   ask 停止后从头重跑。
2. **escalation(dwfq)**:子 agent 升级提问、只停自己;未实现(print 模式子进程
   无中途回话通道,需要 extension 通道)。
3. **规则诊断未覆盖**:phase 覆盖检查、artifact 预置声明位置等;编译层强规则
   还差这几条。
4. journal 为 JSONL;ZCode 用 SQLite(多 run 查询/Project 级 journal 待迁)。
5. **预算/审计**:spentTokens 继承了,但 per-ask token 统计依赖事件流里的
   usage 字段(部分 provider 为 0);ZCode 有完整的 run stats 聚合。

## 接入真实子 agent

实现 `WorkflowDriver` 即可接 pi 的 agent 会话(参考 `desktop/subagents.ts` 的
子会话生成):`executeAsk` 建一个子会话跑一轮返回末轮文本;`stats.worldToolCalls`
由会话的工具调用统计喂回,驱动缓存关闭规则。
