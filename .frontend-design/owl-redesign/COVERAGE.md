# OWL 全界面设计原型覆盖说明

评审日期：2026-10-03。此轮交付是基于当前桌面项目的界面原型，等待用户确认后才实施源码改动。

## 原型范围与数据

主原型：`2026-10-03-owl-redesign.html`。页面内容由 `shell.js`、`workspace-views.js`、`settings-views.js` 和 `dialog-views.js` 组成，由 `assemble.cjs` 合并为可独立打开的 HTML。

- 提供开始页、聊天会话、工作台、8 个设置分区，以及弹窗与状态评审入口。
- 提供浅色与深色预览；实际页面名称、操作、表单与业务能力来自 `apps/desktop/src`。
- 项目、会话、模型、供应商、授权、工具输出、费用、版本号与配置均为合成示例，不表示用户的真实配置或当前运行结果。
- 原型没有连接 OWL Bridge，不读取真实凭据，不调用模型，不执行命令，不暂存或提交文件，不写入实际设置。
- 原型可编辑文案与字段、添加逐元素设计意见，并导出评审结果。原型中的保存/提交反馈是演示反馈。

## 全局设计决策

| 设计项 | 此轮方向 | 对应真实来源 |
|---|---|---|
| 应用结构 | 保留图标栏、项目/会话导航、主聊天区与可停靠工作台；通过统一间距、层级与操作位置降低拥挤感 | `apps/desktop/src/App.tsx`、`components/ActivityRail.tsx`、`components/SessionSidebar.tsx` |
| 主色与主题 | 沿用 OWL 绿色 `#2f9e5a`、石墨灰深色与暖纸浅色；复用 `--color-owl-*` 主题语义 | `apps/desktop/src/index.css`、`theme.ts` |
| 聊天与工具 | 回复保持舒适行宽；执行过程通过摘要、折叠详情和状态节点渐进展示 | `components/ChatStream.tsx` |
| 工作台 | 每种面板共享头部、工具栏、主体与反馈位置；保留右侧/底部停靠语义 | `sidebar/Workbench.tsx`、`sidebar/store.ts` |
| 设置 | 将原有大浮层重新设计为应用内独立设置工作区，左侧分类、右侧内容，并提供返回工作台入口 | `components/SettingsPage.tsx` |
| 术语 | 当前原型导航/工作台标签仍为「任务管理」，面板内部标题使用「执行记录」；其功能是当前会话工具时间线，不能理解为后台调度 | `sidebar/tabs/TasksTab.tsx` |
| 术语 | 当前原型导航/工作台标签仍为「用户印象」，面板内部标题使用「长期记忆」；设置提示词区显示「我的档案」；均对应同一份用户印象文本 | `sidebar/tabs/ImpressionTab.tsx`、`components/SettingsPage.tsx` |
| 操作反馈 | 权限、提问、保存、删除与连接状态遵循统一弹窗和按钮层级；危险操作须说明具体对象和结果 | `components/PermissionDialog.tsx`、`QuestionDialog.tsx`、`NewProjectDialog.tsx` |

上述内部标题是待评审的文案提案，没有修改实际源码名称、存储键或 API。

## 核心页面与聊天状态

| 页面/状态 | 覆盖内容 | 源码对应 |
|---|---|---|
| 开始页 | OWL 品牌、开始任务文案、文件/变动/浏览器入口、终端/执行记录/侧边对话/用户印象入口 | `components/StartPage.tsx`、`sidebar/quick.tsx` |
| 项目与会话侧栏 | 新会话、会话搜索、置顶、项目下会话、最近会话、当前项目与运行标记、侧栏收起 | `components/SessionSidebar.tsx`、`App.tsx` |
| 聊天 | 用户消息、助手回复、Markdown、工具组摘要、工具参数与输出、成功/失败/运行状态 | `components/ChatStream.tsx` |
| 提问时间线 | 用户问题序号、思考/工具/回答节点与连接轨；用于追踪本轮操作链 | `components/ChatStream.tsx` 中 `QuestionNode`、`StepNode`、`buildRows` |
| 提问导航 | 本会话问题与回答首行预览、当前问题高亮、展开/收起、跳转问题 | `components/ChatStream.tsx` 中 `QuestionNavigator` |
| 思考与完整输出 | 思考过程折叠；工具输出末 10 行预览、查看全文；失败自动展开 | `components/ChatStream.tsx` 中 `ThinkingRow`、`ToolRowView`、`ToolGroupView` |
| 最新截图 | 最新工具截图浮动缩略图、关闭、点击查看大图 | `components/ChatStream.tsx` 中 `ScreenshotDock` |
| 输入框 | 当前项目与本地位置、添加项目、模式、模型、思考强度、上下文用量、发送/停止、快捷键说明 | `components/Composer.tsx` |
| 斜杠命令 | `/` 补全建议，命令/技能/模板/扩展来源标签，参数提示、选择后填入输入框 | 当前 `components/Composer.tsx`、`App.tsx`、`bridge/protocol.ts` |
| 当前任务清单 | 完成数量、进度与当前任务、展开/收起视图 | `components/TodoPin.tsx`、`hooks/todo.ts` |
| 连接与错误 | 正常、运行中、初次连接/重连、工具失败、空会话 | `App.tsx`、`components/ChatStream.tsx` |

提问导航、思考折叠、最新截图、完整输出与斜杠补全均已在 `shell.js` 中展示。可通过聊天页顶栏开启提问导航和截图缩略图，在输入框输入 `/` 查看补全。对应效果图已保存。

## 工作台：9 种面板

| 原型标签/键 | 内容与状态 | 源码对应 |
|---|---|---|
| 文件 `files` | 项目目录树、文件名搜索、展开、Git 状态、文件/图片打开、文件夹创建、重命名、复制路径、外部打开与删除入口 | `sidebar/tabs/FilesTab.tsx` |
| 文件变动 `changes` | 分支与上游、已暂存/更改/未跟踪、暂存/取消暂存、丢弃、统一 diff、展开差异、提交信息与已暂存数量 | `sidebar/tabs/ChangesTab.tsx`、`sidebar/diff.ts` |
| 编辑器 `editor` | 文件路径、语言高亮、行号、未保存状态、保存/重新加载、磁盘外部变更横幅、超 1 MB 提示与 VS Code 入口 | `sidebar/tabs/EditorTab.tsx` |
| 终端 `terminal` | 本地目录、PowerShell 会话、输出、运行状态、新建终端、退出/重新启动示例 | `sidebar/tabs/TerminalTab.tsx` |
| 浏览器 `browser` | URL、后退/前进/刷新、系统浏览器打开、4 个视口尺寸、与助手共享页面、连接状态、网页本机文件选择与多文件路径 | `sidebar/tabs/BrowserTab.tsx`、`sidebar/iab-bound.ts` |
| 任务管理 `tasks` | 内部标题「执行记录」；轮次、工具调用数量、状态、工具时间线、输出与失败示例；没有新增任务调度功能 | `sidebar/tabs/TasksTab.tsx`、`sidebar/feed.ts` |
| 用户印象 `impression` | 内部标题「长期记忆」；可编辑长期背景/偏好文本，保存与新会话生效说明 | `sidebar/tabs/ImpressionTab.tsx` |
| 侧边对话 `sidechat` | Beta 标识、独立线程、消息与工具摘要、输入/发送/停止、新对话入口 | `sidebar/tabs/SideChatTab.tsx` |
| 图片 `image` | 本地示例 SVG 插图、透明背景棋盘、缩放百分比、放大/缩小/适应 | `sidebar/tabs/ImageTab.tsx` |

统一面板注册及类型来自 `sidebar/builtins.tsx` 与 `sidebar/registry.ts`。终端和浏览器多实例、文件编辑/图片查看类型、标签草稿保留等语义仍以真实工作台实现为准。

## 设置：8 个分区

| 原型分区/键 | 字段与能力 | 真实设置分区 |
|---|---|---|
| 常规 `general` | 默认工作目录、Shell 路径、只读数据目录、新会话生效说明 | `SettingsPage.tsx`：`general` |
| 模型与供应商 `providers` | 供应商卡片、地址/协议/API Key、浏览器授权、模型 ID/名称/上下文/最大输出/推理标记、添加/删除供应商与模型 | `SettingsPage.tsx`：`models` |
| 插件 `plugins` | npm/Git/本地路径添加、已安装插件、来源、启用与移除操作 | `SettingsPage.tsx`：`plugins` |
| 外观 `appearance` | 深色、浅色、跟随系统主题选择与立即生效反馈 | `SettingsPage.tsx`：`appearance`、`theme.ts` |
| 提示词 `prompts` | 长期指令、用户档案文本、内置规则分区只读展示、保存与新会话生效 | `SettingsPage.tsx`：`prompts` |
| 归档 `archive` | 保留天数、自动清理说明、归档会话、恢复与永久删除 | `SettingsPage.tsx`：`archived` |
| 高级配置 `json` | `settings.json` 编辑、JSON 格式检查与保存反馈 | `SettingsPage.tsx`：`json` |
| 关于 Owl `about` | 产品、版本、运行基础、配置数量与本地数据位置示例 | `SettingsPage.tsx`：`about` |

所有设置对应 `apps/desktop/src/components/SettingsPage.tsx`，原型的键名是预览导航键，未变更真实分区、配置文件或字段名。原型中的版本号和配置数量是合成数据。

## 弹窗、菜单与授权交互

| 交互 | 原型内容 | 真实来源 |
|---|---|---|
| 添加项目 | 完整目录路径、浏览、不存在时创建、取消/添加并切换 | `components/NewProjectDialog.tsx` |
| 项目切换/项目操作 | 项目列表、新会话、置顶、资源管理器打开 | `components/Composer.tsx`、`SessionSidebar.tsx` |
| 会话/排序菜单 | 置顶、归档、删除；置顶/最近分组排序 | `components/SessionSidebar.tsx` |
| 运行位置 | 本地连接、不可用的远程会话状态 | `components/Composer.tsx` |
| 模型与思考 | 模型选择、供应商分组、上下文/推理能力、7 种思考档位 | `components/Composer.tsx` |
| 上下文与费用 | 当前窗口、输入/输出/缓存、累计 tokens 和费用 | `components/Composer.tsx` |
| 执行模式 | 标准、计划、自动及各自说明 | `components/Composer.tsx` |
| 权限确认 | 工具名称、命令/路径/详情、拒绝/允许 | `components/PermissionDialog.tsx` |
| Agent 提问 | 单选/多选、题目进度、选项描述和预览、自由输入、备注、上一题/下一题/提交 | `components/QuestionDialog.tsx` |
| 删除会话/归档 | 对象信息、永久删除结果、取消/确认 | `components/SessionSidebar.tsx`、`SettingsPage.tsx` |
| 文件操作 | 文件菜单、重命名、创建文件夹、文件/目录删除；必须与会话删除文案区分 | `sidebar/tabs/FilesTab.tsx` |
| 丢弃改动 | 目标文件和丢弃修改确认；必须与删除会话文案区分 | `sidebar/tabs/ChangesTab.tsx` |
| 网页文件选择 | 本机完整路径、多文件 `|` 分隔、提交/忽略 | `sidebar/tabs/BrowserTab.tsx` |
| 供应商/模型 | 添加、编辑字段、移除确认 | `components/SettingsPage.tsx` |
| 浏览器授权 | 登录入口、API Key、授权进度、企业域名、密钥、手动授权码、选项回答、取消与连接成功 | `components/SettingsPage.tsx` 的认证区域与认证事件 |
| 当前任务清单 | 清单、完成进度、当前执行项 | `components/TodoPin.tsx` |
| 最新截图查看 | 缩略图、完整图和关闭 | `components/ChatStream.tsx` |

## 保真度边界与验收

1. 浏览器画布、终端命令、文件管理、暂存、取消暂存、丢弃、提交、账号授权与配置保存均为合成演示，不与真实应用交互。部分入口仅呈现反馈或目标弹窗。
2. 原型已支持右侧/底部停靠切换、拖动面板边缘调整宽高、展开工作台，以及通过“分屏 / 合并”按钮查看布局。源应用的拖拽标签分屏规则未在原型中完整重建。
3. 多标签、多实例及未激活面板的长期挂载生命周期不由静态原型复现。实施时必须保留终端、浏览器绑定和编辑草稿。
4. 思考、工具与输出示例只说明界面布局，不代表当前模型输出。斜杠命令建议仅模拟选择和填入，不能执行真实命令。
5. 桌面最小化、最大化/还原与关闭来自 `components/WindowControls.tsx`，浏览器开发模式不显示实际 Tauri 控制；原型中的窗口框架只能作为外观演示。
6. 展示截图及检查结果保存在 `screenshots/` 与 `verification.json`。这些是原型布局与交互检查，不能替代源码实施后的真实应用验证。

## 源码状态与实施门槛

本轮新增、修改的文件仅位于 `.frontend-design/owl-redesign/`，不包含产品 `src` 文件。用户明确要求先展示原型，得到确认后才能修改源码。

与初始 `source-baseline.json` 比对时，44 个记录文件中有 3 个当前哈希发生变化：

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/bridge/protocol.ts`
- `apps/desktop/src/components/Composer.tsx`

这些是工作区并发变化；本轮原型工作未编辑或回退它们。当前文件中存在斜杠命令列表与补全能力，因此后续原型/实施应以最新源码为准。不能将此轮「未改产品源码」表述为「整个工作区源码完全没有变化」。

确认方向后，再将布局、样式与文案实施到实际组件，并按仓库规则执行对应验证；在确认之前，继续评审与修改原型文件。
