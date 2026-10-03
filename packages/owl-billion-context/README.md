# owl-billion-context

[billion-context](https://github.com/ranxianglei/billion-context)（内核 [acp-kernel](https://github.com/ranxianglei/acp-kernel)，MIT）的 Owl 插件封装：**模型驱动的折叠式上下文压缩**。默认**停用**，供实验与二次开发。

> 与 owl 内置的阈值式 compaction（一次性结构化摘要、不可逆）互补：本插件把压缩做成暴露给模型的工具，何时压、压哪段、摘要写什么由模型自己决定；被压缩内容折叠成可逐块恢复的摘要块，而非不可逆大块。机制对比与设计分析见仓库内的相关讨论记录。

## 机制速览

- **compress 工具**：每条消息带 `<acp tokens="8.2K" type="bash">m00175</acp>` 引用标签，模型用 `mNNNNN`/块 id `bN` 圈定区间并**自己写好摘要**，一次调用替换一段历史为摘要块。被折消息从发送视图移除，摘要在原位以 system 消息常驻。
- **增速门 nudge**：占用 ≥45% 窗口且自上次压缩增长 ≥50K token 时，在上下文尾部注入一条压缩提示（带真实尺寸的候选区间清单，不含填充百分比）；模型有权忽略。用量 ≥95% 升级为 EMERGENCY（绕过去重）；同一 user turn 内 compress 失败/空转达 3 次熔断，防循环。
- **折叠布局**：摘要块常驻 + 保护区原文（最近 5 条 / 5000 token 硬下限，内核强制）+ 首条用户消息钉住。块可再折叠（tier-1→2→3）。
- **可逆**：`decompress` 读回块内容（默认写 `OWL_CODING_AGENT_DIR/billion-context/decompress/`，`inline:true` 内联）；`search_context` BM25 检索块摘要；块被高阶折叠后仍保留谱系。
- **历史不删**：压缩只影响发送视图，owl 会话 jsonl 原样保留；压缩状态存 sidecar `<sessionFile>.acp.json`（与上游 billion-context-pi 同约定）。

## 接入点（owl 扩展 API）

| 钩子 | 行为 |
|---|---|
| `context` | 条目→内核 `processTurn`→折叠视图 + nudge 注入 + 孤儿 toolResult 兜底 + 宿主 system 消息回带 |
| `before_agent_start` | 追加压缩哲学系统提示（KEEP/DROP 规则、四工具说明、多 tier 蒸馏） |
| `session_before_compact` | 返回 `{cancel:true}`——接管 owl 原生阈值 compaction，两套机制不并行 |
| 工具注册 | `compress` / `decompress` / `search_context` / `acp_status` |

## 与上游 billion-context-pi 的差异

内核 dist **原样 vendor** 自 npm `acp-kernel@0.0.100`（`vendor/acp-kernel/`），集成层按 owl API 重写。有意差异与未移植清单：

**有意差异**

- **摘要常驻**：内核渲染的 `[Compressed conversation section]` 摘要消息**保留**在发送视图（owl `convertToLlm` 透传 system 角色）。上游 pi 宿主走 compress-as-anchor（compress 调用对充当锚点，args 摘要削到 200 字残根），owl 这里选择论文正版的常驻摘要路径，压缩调用对仍由内核 hide-consumed 维护。
- 占用计量 = 发送视图估算，下限锚定 `ctx.getContextUsage().tokens`；上游的 provider 校准/发散监测/输出余量自适应未移植（估偏差时门控可能偏早/偏晚触发，不致错误压缩）。

**未移植**：acp_delegate 子代理委派、prompt pack 覆盖、provider 限流重试、overflow 自愈、图片剥离/压缩、absorb/crush/rules 工具、`/acp*` 斜杠命令、TUI 面板（owl 无 TUI）、状态从会话日志重建、更新检查、三级 acp.json 配置覆盖（窗口外的内核参数一律用出厂默认）。

## 启用方式

设置 → 插件 → owl-billion-context → 启用；或直接把 `settings.json` 里的对象项改为字符串/去掉 `disabled`：

```json
"plugins": [
  { "source": "D:\\owl\\owl-re-v1\\owl-mono\\packages\\owl-billion-context", "disabled": true }
]
```

改动后新会话生效。**启用后 owl 原生 compaction 不再运行**（被本插件取消）；停用即完全还原，历史数据无残留（sidecar 文件可随手删）。

## 实验注意事项

- 未在生产流量验证过；先在**可丢弃的会话**上试，确认折叠视图符合预期再日常用。
- 压缩哲学提示约占窗口千分之几（一次注入、整会话常驻），小窗口模型上占比更高。
- 上游论文自身的诚实结论：该规模模型**不会自发调用恢复工具**——decompress/search 可能需要你显式指示。
- 与远程调试互斥场景：如果你依赖 owl 原生 compaction 的行为（例如对照实验），保持本插件停用。

## 开发

```bash
cd packages/owl-billion-context
node scripts/build.js        # esbuild 打包（内核 vendor 进 dist，运行时零外部依赖）
node scripts/smoke.mjs       # 冒烟：注册/渲染/门禁/真实折叠/搜索/解压
../../node_modules/.bin/tsc --noEmit   # 类型检查
```

升级内核：`npm pack acp-kernel@<新版>`，解包覆盖 `vendor/acp-kernel/dist`，重跑冒烟。

## 来源与许可

- 内核：[acp-kernel](https://github.com/ranxianglei/acp-kernel) v0.0.100（MIT），`vendor/` 内含其 LICENSE。
- 集成层：参考 [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) v0.1.83（MIT）源码移植，见各源文件头注释；上游设计论文在 billion-context 仓库 `paper/` 目录。
