# dsh-univer-office 对 Owl 的价值评估

评估日期：2026-10-03。范围：官方仓库源码、官方产品文档、npm 发布元数据与当前 Owl 源码。

**建议先做 Sheet/Excel 完整闭环。该插件可以补上 Owl 的办公内容编辑与审阅能力，但不能直接安装成 Owl 插件。**
先验证“导入 Excel → AI 修改草稿 → 用户比较与确认 → 导出 Excel”，再决定是否扩展 Doc、Slide、Base、Board。
本文是静态评估；未安装插件、未运行其脚本、构建或测试，也未更改 Owl 业务代码。

## 1. 版本与证据边界

- 本文源码快照为 main commit `60cbf5a398f8ba8a6d69396a73eead383a652b6b`，manifest 版本为 `0.3.6`。[源码 manifest](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/package.json)
- npm `0.3.6` 的 `gitHead` 为 `c2caaefb43dc464f1477463c754f17a6be956193`，与本次 main 快照不同；发布包元数据的解包体积为 226,847,258 bytes，约 216 MiB，不含平台原生依赖安装开销，不能当作实测安装体积。[npm 元数据](https://registry.npmjs.org/dsh-univer-office/0.3.6)
- main 已有后续桌面 WebSocket 修复，不能把 main 的静态实现全部视为 npm `0.3.6` 已发布行为。[上游 PR #116](https://github.com/dream-num/dsh-univer-office/pull/116)
- 有测试文件只证明上游准备了验证路径；本次没有执行，不能宣称当前发布物已通过测试。

## 2. 能给 Owl 带来什么

| 能力 | 用户场景 | 对 Owl 的增量 |
|---|---|---|
| Sheet | 整理数据、写公式、做图表与透视表，交付 XLSX | 从文件预览扩展到可持续编辑的表格成果 |
| Doc | 周报、方案、报告，交付 DOCX | 对话生成的正文可在工作台继续编辑和审阅 |
| Slide | 演示文稿、SVG 页面布局，交付 PPTX | 内容创作、视觉检查与演示文件交付形成闭环 |
| Base | 字段、记录、视图、公式字段 | 提供可交互的数据工作台；适合后续扩展 |
| Board | 流程图、形状、连接线与画布 | 提供可编辑画布；当前功能与导出仍有限制 |
| Worktree 与语义比较 | AI 改内容后，用户逐项查看变化 | 保存原主线，支持继续修改、确认或放弃 |

以上五类 Unit、导入导出格式与限制见[官方能力表](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/README.zh-CN.md)。
真正的价值是“AI 操作结构化内容，用户在同一工作台看见成果并控制合入”，不是只显示 Office 文件截图。

当前 Owl 有文本、HTML、CSV/TSV 文档预览，以及代码和图片 viewer；Office/PDF 等二进制文件交给系统程序打开。
来源：[内置 viewer](D:/owl/owl-re-v1/owl-mono/apps/desktop/src/sidebar/builtins.tsx:34)、[Office 外部打开分支](D:/owl/owl-re-v1/owl-mono/apps/desktop/src/sidebar/config.ts:75)。
现有 `registerTab` 与扩展名匹配可以承接 `.univer` 工作台，但还没有该插件提供的引擎、Office 工具与草稿审阅服务。
来源：[Owl viewer 注册表](D:/owl/owl-re-v1/owl-mono/apps/desktop/src/sidebar/registry.ts:64)。

## 3. 实际工具与工作流

源码注册 14 项模型工具，`univer_screenshot` 在 attachment service 可用时才注册。
来源：[工具注册入口](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/host/tools/plugin.ts)。

| 工具组 | 工具 | 职责 |
|---|---|---|
| 文件与草稿 | `univer_new`、`univer_status`、`univer_worktree`、`univer_unit` | 创建文件、发现 ID、管理草稿与内容单元 |
| 内容读写 | `univer_import`、`univer_inspect`、`univer_execute`、`univer_export` | 本地导入、结构读回、Facade JavaScript 修改、导出 |
| 视觉与交付 | `univer_lint`、`univer_compile_svg`、`univer_screenshot`、`univer_print_pdf` | Slide 布局检查、SVG 编译、截图与 PDF |
| 模型辅助 | `univer_api`、`univer_resources` | 同版本 API 查询，以及图标等资源查找和导出 |

Facade 执行产生 mutations 后提交 revision；无 mutation 的读操作不创建 revision。模型需要显式 `return` 才能取得读回值。
来源：[execute 工具](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/host/tools/definitions/execute.ts)、[Worker 提交逻辑](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/workers/unit-content/entry.ts)。

推荐工作流为 `trunk → draft → AI 修改 → ready → 用户审阅 → merge/discard`；继续修改用 `reopen`。
模型内容写入要求显式 draft，merge/discard 通过 DSH `tools/pre-execute` 请求审批。
来源：[审批钩子](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/host/tools/plugin.ts)、[生命周期实现](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/gateway-app/collab-service.ts)。
审批是 DSH 宿主 consumer 的行为，Gateway 没有独立审批凭证；Gateway merge 还会把 draft 自动转为 ready。
因此 Owl 的 `auto/plan` 模式不能代替动作级授权：AI 合入或放弃草稿需要用户明确要求，并经过对应确认路径。
用户在 Viewer Ribbon 导入时直接向 trunk 新建 Unit，与模型导入到 draft 的规则不同，接入时要保留清晰的用户操作语义。
来源：[浏览器用户操作](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/host/webServer/routes/worktree-action.ts)、[Ribbon import](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/gateway-app/exchange/gateway-exchange-service.ts)。

语义比较固定两侧 revision，支持 trunk 或另一个活跃 worktree；版本变化后标记 stale，需要用户刷新。
五类 Unit 通过 Univer Pro History adapter 生成语义差异，支持定位、筛选和分页；并非二进制文件 diff。
来源：[固定比较会话](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/gateway-app/collab-service.ts)、[五类比较引擎](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/gateway-app/comparison/unit-comparison-runtime.ts)。
ready 的 merge preview 会评估草稿与最新主线的 OT 合并效果；冲突返回错误，不能把原草稿当作最终合并结果。
来源：[合并预览](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/gateway-app/collab-service.ts)。

## 4. 建议接入架构与工作量

建议路径：`Owl Extension 工具 → Office 领域服务 → Gateway + Worker → .univer 持久化`，由 `Viewer → Owl 工作台` 展示和审阅。
Owl Extension 已提供 `registerTool` 和 `tool_call` 拦截能力，可用于模型操作及动作审批。
来源：[Owl Extension 文档](D:/owl/owl-re-v1/owl-mono/packages/coding-agent/docs/extensions.md)。

| 层 | 可复用部分 | Owl 必须适配 | 相对投入 |
|---|---|---|---|
| Gateway/Worker | 协同协议、SQLite adapters、内容操作 | 启停、超时取消、原生依赖、文件授权 | 中高 |
| Office 领域服务 | 上游 `UniverService` 接口划分 | Owl 服务接口、错误与结构化结果、artifact ID | 中 |
| 模型工具与 workflow | 工具 schema 和 bundled skills | Extension API、审批、会话恢复、附件回读 | 中 |
| Viewer/工作台 | 独立 Viewer 与比较组件 | HTTP/WS 认证、desktop transport、tab 与审阅 UI | 中高 |
| 完整五类 suite | Office 全套流程 | 全类型验证、打包、升级与产品维护 | 高 |

这里的投入为相对判断，未做可运行原型，不能给可靠天数估计。
Owl 当前成果收集只识别成功的 `write/edit/sidebar_open`，新增 `univer_*` 工具需要接入结构化成果输出；Office 文件的前置外部打开分支也需要调整，仅注册 viewer 不足以改变行为。
来源：[成果收集](D:/owl/owl-re-v1/owl-mono/apps/desktop/src/hooks/artifacts.ts:131)、[文件打开策略](D:/owl/owl-re-v1/owl-mono/apps/desktop/src/sidebar/config.ts:73)。
上游 Host 是 Cordis 插件，Client 注册 DSH slots/conversation/settings；不能直接安装到 Owl 后自动获得界面与工具。
来源：[Host 入口](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/host/index.ts)、[Client 宿主耦合](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/client/index.tsx)。
Gateway、Worker、Viewer 已按独立应用拆分；Worker 用 stdin/stdout JSON 通信，具备抽离基础，但进程分离不等于安全沙箱。
来源：[Worker 调用协议](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/host/adapters/unit-content/worker.ts)、[架构](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/docs/architecture.md)。
比较 Viewer 只消费解码后的 UnitData 和宿主 factory，是最明确的组件复用边界；当前 manifest 标为 private，不能假设存在独立 npm 发布物。
来源：[比较组件边界](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/packages/unit-comparison-viewer/README.zh-CN.md)、[组件 manifest](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/packages/unit-comparison-viewer/package.json)。

## 5. 决策前需要确认的限制

**许可。** 根仓库标为 Apache-2.0，但其能力大量依赖 `@univerjs-pro/*`。源码及发布包嵌入 localhost 的 90 天 developer license，不能把它当成 Owl 正式部署的许可。
当前 Worker 支持运行时 license 输入，Viewer 有编译内嵌 license；移植应把各入口改成注入 Owl 自有许可。
来源：[manifest 许可与 Pro 依赖](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/package.json)、[Worker license 入口](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/workers/unit-content/entry.ts)、[Viewer license](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/viewer-support/render-preset/license.ts)、[官方 License 文档](https://docs.univer.ai/server/license)。
需确认目标域名、部署用途、功能与 SDK 版本对应的许可，以及 SDK 移植和重分发条件；现有证据不能直接下免费或付费结论。

**平台与成本。** Node 要求 `>=22.19.0`；截图、PDF、Slide lint 与 SVG 文字度量需要 Chromium/Chrome/Edge。
exchange/formula native bindings、libsql 及同版本 SDK cohort 带来 Windows 打包和升级成本；216 MiB 元数据只反映包解包大小。
来源：[运行要求](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/README.zh-CN.md)、[绑定与版本规则](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/docs/architecture.md)。

**权限。** Gateway 只监听 loopback，其 authz 是 allow-all stub；安全边界由 DSH Host 认证承担。
Viewer 文档打开校验 session/workspace，后续 `/uf` HTTP/WS 只要求宿主鉴权，不重复 workspace 校验。
Owl 需要适配每个请求的 session/workspace/artifact 授权，不能把此实现当作现成多租户权限系统。
来源：[loopback](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/gateway-app/server.ts)、[authz stub](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/gateway-app/transport/http.ts)、[官方权限边界](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/README.zh-CN.md)。

**Office 保真。** 源码调用本地 `exchange-node` 文件/Buffer 转换，没有看到远程 Office 云转换链路；本次未做断网验证。
DOCX 默认 traditional 保留页面几何，modern 会重写版面；Slide 母版、版式页和备注不在编辑范围，Board 常规文件导出未开放。
来源：[本地导入导出](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/workers/unit-content/entry.ts)、[DOCX 模式](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/src/host/tools/definitions/import.ts)、[当前限制](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/README.zh-CN.md)。
复杂公式、格式、嵌入对象与真实客户文件的兼容性需要样本验证，不能保证 Excel/WPS/Word/PowerPoint 无损往返。
上游已有 integration、迁移、比较和 UI 测试；XLSX smoke 导出主要查非空，DOCX 有页面参数 roundtrip，仍不等于 Office 应用级兼容证明。
来源：[XLSX smoke](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/test/integration-smoke.mjs)、[DOCX roundtrip](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/test/integration-smoke.mjs)。
旧 `.univer` 打开会触发带备份的 v3 迁移；Owl 只读预览原附件时应先复制到受控 artifact，避免预览改变源文件。
来源：[迁移行为](https://github.com/dream-num/dsh-univer-office/blob/60cbf5a398f8ba8a6d69396a73eead383a652b6b/README.zh-CN.md)。

## 6. Sheet MVP 验收

1. 导入带公式、样式与图表的 XLSX，在 Owl 工作台打开；结构与视觉读回能定位真实单元格。
2. AI 只写 draft，ready 后展示语义差异；未经明确用户授权不能 merge/discard，确认后主线状态正确。
3. 用户在草稿审阅期间修改主线，比较能提示 stale，合并预览和冲突处理不隐藏主线变化。
4. 导出 XLSX 并在 Excel/WPS 打开，验证公式值、格式、图表与二次导入；保留不兼容样本及边界说明。
5. Windows 打包后启动、取消、重启与关闭均正常；会话文件授权有效，许可注入覆盖 Viewer/Worker，后台进程能释放。
