# REA 研究工作台接入

研究工作台的 `research_rea` 使用固定版本 `rea-agents@6.4.0`，增加本地 JavaScript / Electron、原生 PE 和 .NET 静态分析。每个研究会话持有独立 MCP 进程、当前目标和 Evidence 账本。普通对话借用同一个静态分析工具（见下节），但不带研究工作台的其余工具。全局 MCP 配置和现有 V8 JSC 恢复链不变。

## 普通对话中的静态分析

普通对话（研究工作台以外）也注册 `research_rea`，用于「读懂一个二进制或前端产物」这类问题。两条路径共用同一个 `ResearchReaClient` 与 `createResearchReaTool`，所以安全边界完全一致：

- 同样的上游工具白名单（16 个静态查询与生命周期工具），不注册 REA 完整 MCP 目录。
- 同样的路径校验：只读用户明确选中或当前工作区内的文件，拒绝符号链接、目录联接和越界路径。
- 同样的输入快照与 SHA-256 校验，同样的完整响应、证据包与报告落盘。
- 同样不运行目标、不执行页面脚本、不安装工具。

差异只有两处：普通对话不注册 `research_publish`、`research_checkpoint`、`research_task`、`research_executable`、`research_decompile`、`research_model_lab`；以及普通对话没有研究会话的方向、任务台账与结果卡，普通对话的结果直接在对话里回复。

审批上有一处加强：REA 静态分析会启动后端子进程（Ghidra 启动上限 330 秒）并把证据写进工作区，属于用户预期之外的开销，所以**即使在 auto 模式也先确认一次**；`inventory` 只读本机安装信息，可以直接放行。plan 模式与研究会话一致，只放行 `inventory`。

极简模式与 Pi 模式预设固定收窄工具集，本来就不包含 `research_rea`；其余预设按需发现。

## 安装与启用

从仓库根目录执行宿主安装脚本：

```powershell
node scripts/setup-research-rea.mjs --doctor
node scripts/setup-research-rea.mjs --check
```

安装脚本在 `OWL_CODING_AGENT_DIR/tools/research-rea` 创建独立 package、锁文件和 `rea-toolchain.json`，未设置环境变量时使用仓库旁的 `data/owl`。通过官方 npm registry 固定安装 6.4.0，禁用生命周期脚本，并验证已审阅的 npm integrity。不会执行 REA 的全局 `setup`，不会修改 Codex、Pi 或其他 Agent 配置。

原生分析配置复用 `tools/research-decompilers/native-toolchain.json` 的 `ghidraHome` 和 `javaHome`。宿主也可通过安装脚本的 `--ghidra-home`、`--java-home`、`--tool-dir` 指定配置；模型工具参数不能选择命令、安装目录或任意输出路径。自定义 `--tool-dir` 时须将其配置放到研究 Agent 目录的标准位置，运行客户端只从该目录读取。

Node 需要 22.19+、24.11+ 或 26+。Windows 原生路线需要 x64 Node、本地 NTFS、Ghidra 12.1.x 与完整 JDK 21+。当前适配器原生目标限定 PE EXE/DLL。JavaScript 和 .NET 静态查询可以独立于 Ghidra 使用；单独部署这两类时，客户端允许未配置 Ghidra 的固定 package 安装。

更新运行中的桌面桥与 UI 产物后，重新打开 Owl，再从研究工作台新建或恢复研究会话。工具在首次实际分析时启动后端，`inventory` 只读取本机安装信息。

## 使用

进入研究工作台后，直接给出网址、本地文件或研究任务。Agent 根据问题自主组合网页调研、Web / JS 静态分析、EXE / 应用解析、受预算约束的模型实验和 OSINT。新建会话与恢复的旧研究会话都使用统一入口，无需预先选择方向；方法和结果仍按实际能力分类，已保存的研究历史继续保留。例如：

```text
调研 https://example.com 的产品能力，结合我提供的源码文件说明它的实现链路。
分析 D:\samples\demo\main.js，解释导出函数和它调用的模块，保留证据。
分析 D:\samples\demo.exe，列出函数，再解释入口函数和调用关系。
检查 D:\samples\Example.dll 的 .NET 元数据、CIL 和声明的原生依赖。
```

Agent 可以调用以下操作：

| action | 用途 |
| --- | --- |
| `inventory` | 文件级安装检查，不启动 REA 或 Ghidra；plan 模式允许 |
| `javascript` | JS/TS 源文件、应用目录或 ASAR 静态应用图 |
| `native_overview` / `native_functions` / `native_strings` | 原生 PE 概况、函数与字符串清单 |
| `native_function` | 用已观测的 `procedure` 名称或地址取得函数分析、伪代码与引用 |
| `native_references` / `native_call_graph` | 函数的 incoming/outgoing 引用或调用图 |
| `managed_metadata` / `managed_members` / `managed_native` | .NET 元数据、成员/CIL 与声明的原生边界 |
| `view` | 本会话保留的 JS 应用摘要/模块页，或原生函数伪代码、汇编、调用方与引用页 |
| `close` | 关闭当前分析目标和 Ghidra，清空内存账本；同会话可继续选择新目标 |

分析、导出和关闭操作遵循研究会话现有 confirm/auto 权限。plan 模式只允许 `inventory`，不会因为上游 `readOnlyHint` 而运行外部分析器或写入证据。

6.4.0 发布包没有 `source_paths` 参数。单个 JS 文件或目录指定 `sourcePaths` 时，适配器将准确选中的文件复制到专用输入快照，并逐个验证 SHA-256，未选择的依赖保持未知。ASAR 的源码筛选需要先通过现有 `research_decompile` 提取，再选择已提取文件。分析工作区根目录时也会生成输入快照，排除 `.owl`、`.git` 和 `node_modules`，避免把正在生成的证据再次作为分析输入。全目录快照最多 5000 文件、256 MiB；更大输入应明确选择业务源码。

`view` 使用工具返回的 `evidenceId`。JS 的摘要响应另有自己的 Evidence ID，适配器保留并返回原分析的 `parent_evidence_id` 以便后续分页。原生 `analyze_function` 使用 native facets，如 `view=pseudocode`；清单、概况和 managed Evidence 不冒充可分页应用/函数分析。伪代码的 offset/limit 按 UTF-16 字符计，其余列表页按行计。关闭或重启后，内存引用不再有效，应重新分析明确选中的目标；已保存的文件及结果卡仍可读取。

## 证据与生命周期

每次分析在当前工作区生成 `.owl/research/rea/<会话散列>/<运行ID>/`，包括：

- `response.json`：完整 MCP 响应，保留文本、结构化 Evidence 和 provider 原始表示。
- `analysis.json`：完整 normalized result。
- `session-evidence.json`：REA 导出的完整会话 Evidence 账本。
- `report.json`：输入路径、文件 SHA-256、操作、Evidence ID、产物哈希和实际限制。
- 选中源码分析另有 `input-snapshot/` 和 `input-snapshot.json`；原生打开另有 `opening-response.json`。

结果卡来自 `details.researchResult`，包含真实证据文件来源。分析结果默认 `partial`，工具完成、伪代码出现或格式校验通过均不表示完整原源码或语义等价；显示预览截断时，完整材料仍在文件中。导出失败会保留原始响应并明确标注证据缺口。原生响应的输入哈希与所选文件不一致时，适配器保存诊断并拒绝发布卡片。

初始化限时 60 秒，每次实际查询限时 360 秒，Ghidra 启动期限为 330 秒。进度使用上游真实状态消息，不换算虚构百分比。取消与传输超时会主动关闭连接；清理成功后，下次调用建立新的进程和账本，清理未完成则阻止复用。最终报告写入之后再次检查取消，取消任务不会发布完成卡片。会话关闭、恢复或 reload 时等待后端清理。

本次开放 15 个明确的静态查询与生命周期 MCP 工具，由 `research_rea` 包装；不注册完整目录，不启用运行场景、调试注入、ADB、原生注释写入或任意安装动作。V8 `.jsc/.cjsc` 仍使用现有 `research_decompile`。外部程序、重建脚本、页面脚本均不执行。

## 验证

不调用真实模型的定向检查：

```powershell
cd packages/coding-agent
node scripts/test-known.mjs test/research-rea-client.test.ts test/research-rea-tools.test.ts test/research-agent.test.ts test/research-result-ui.test.ts test/desktop-research-bridge.test.ts
```

本机安装诊断保存在 `tools/research-rea/diagnostics`。集成验收使用合成 JavaScript 模块和源自本项目的 1 KiB PE，核验静态分析、伪代码、证据导出、输入哈希和进程清理，不启动目标。Windows P0 及外部引擎的更多格式/架构不由这些样本扩大认证范围。

上游参考：[6.4.0 发布记录](https://github.com/morluto/rea/releases/tag/rea-agents-6.4.0)、[发布版 MCP 契约](https://github.com/morluto/rea/blob/a56f7bb668ab23fec8d33f7af353ac7ed2fe1895/docs/mcp-contracts.md)、[Windows Ghidra 范围](https://github.com/morluto/rea/blob/a56f7bb668ab23fec8d33f7af353ac7ed2fe1895/docs/windows-ghidra-p0.md)。
