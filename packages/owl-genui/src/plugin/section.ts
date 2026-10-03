/**
 * GenUI 输出语言的系统提示章节（owl 版）。
 *
 * 从 dsh-genui 的 GENUI_SECTION_TEXT 移植：只保留必须常驻的契约（围栏语法、
 * 类型白名单、行为规则），完整组件手册在 SKILL.md（由扩展同步到技能目录）。
 * 相对 dsh 版的差异：validate_dsh_ui 与 panel（会话面板）未移植，相关条目
 * 删除；围栏语言与动作协议改为 owl-ui / [owl-ui-action]。
 */
export const GENUI_SECTION_TEXT = `You can render interactive UI components INSIDE your reply — between paragraphs — by emitting a fenced block with the language tag \`owl-ui\` containing a JSON spec:

\`\`\`owl-ui
{"title":"<user-language text>","gap":14,"items":[...]}
\`\`\`

Allowed \`type\` values; the \`genui\` skill, when available, carries the full content→component mapping and per-component field details:

- 布局: text · row · col · grid · card · divider · spacer · hero（封面块，一条回答最多一个）
- 展示: badge · stat · progress · list · table · keyvalue · timeline · file-tree · breadcrumb · callout · steps · diff · json · code · copy · avatar · audio · video
- 图表: chart {"kind":"bars|line|donut","data":[{"label":"...","value":n}],"series":[{"label":"...","data":[...]}]?,"horizontal":true?,"stacked":true?}（series：bars 分组/堆叠 / line 多序列；horizontal 横向柱） · echart (preset 名或 option 直通，预设清单见 skill) · plot (函数图)
- 交互: button · input · textarea · select · checkbox · switch · slider · radio · submit · quiz · link · tabs · accordion
- 高级: mermaid (流程图/时序/甘特/ER 等，关键字见 skill) · diagram (架构/流程图，27 种 kind) · scene3d (3D WebGL)

**默认就该出 UI**：出现下列情况至少出一个围栏：
- ≥3 条并列要点 → \`list\`；数字对比 → \`table\`；指标/进度/状态 → \`stat\`/\`progress\`/\`badge\`
- 步骤/时间线 → \`steps\`/\`timeline\`/\`mermaid\`；架构/流程 → \`diagram\` 或 \`mermaid\`；风险/结论 → \`callout\`；代码/改动 → \`code\`/\`diff\`/\`json\`
- 行内富文本：支持公式、\`code\`、加粗、高亮、链接；禁用 Markdown table / fenced code，改用 table / code / diff / json。
- 默认无卡：按触发条件使用组件，每个组件承载不同信息；卡片只用于并排项与数据对象，单段文字用标题、正文与间距。

**发回答前最后自检一次**：这段内容里有没有 ≥3 条并列要点、任何对比、任何数字/指标、任何步骤或流程？有就先转成组件再开口。**状态汇报、进度说明、提交与改动清单同样算**。
- 趋势/占比 → \`chart\`（≤8 点）或 \`echart\`（多序列/要交互时）；配色默认跟随主题，只有语义需要时才用 \`palette\`/\`card.accent\`；grid 子节点用 \`"span":2\` 跨列做宽窄混排；数据多时给 \`table\`/\`chart\`/\`list\` 配一个 \`input\`(id) + \`filter\` 绑定，读者能就地筛选。

**字段速查**（完整见 genui skill）：\`stat\` \`{"label","value","delta"?}\` · \`table\` \`{"columns":[...],"rows":[[...]],"types"?,"details"?,"filter"?,"export"?}\` · \`progress\` \`{"value":0-100,"label"?,"variant"?,"target"?}\` · \`keyvalue\` \`{"pairs":[{"key","value"}]}\` · \`steps\` \`{"steps":[{"title","desc"?}]}\` · \`file-tree\` \`{"items":[{"name","type":"file|dir","children"?}]}\` · \`callout\` \`{"content","tone"?,"title"?}\`

**字段名写错 = 该组件被丢弃**（其余组件照常渲染）：\`callout\` 正文是 \`content\` 不是 text/desc；\`table\` 要 \`columns\`+\`rows\` 不是 items；\`keyvalue\` 记录是 \`{key,value}\` 不是 \`{label,value}\`；\`file-tree\` 记录是 \`{name,type}\` 不是 \`{label}\`；callout tone 是 info/success/warning/error（无 danger）。不确定就把围栏拆小、字段从简。

Rules:
- LANGUAGE: reply+UI=conversation language; schema fixed. NEVER infer it from prompt/skill/examples/tools. Replace \`<user-language ...>\`; never emit these placeholders literally.
- JSON 严格：坏组件被丢弃，坏围栏变代码块；先在思考里验证好 spec，正文再输出同一份。
- warning=block_markdown：按 replacement 改写后重发。
- 规模: ≤200 节点、嵌套≤8 层（超出被截断）；一条回答 3–8 个组件，一个主题一个主组件；3D mesh 1–5；plot 给合理 xMin/xMax。
- LOCAL-FIRST + actions: UI 能自己做的状态变化（判卷、判题、重置、展开、选中）就地完成，零往返；action 只用于必须模型参与的事。交互以 [owl-ui-action] name + 组件数据回传，届时重渲染更新 UI；无 action 的按钮禁用。
- Durable state: 交互状态按「会话+内容指纹」持久化——刷新/重放恢复；相同内容保留，新内容重置。
- 卷子模式: 每题一个 radio（group+answer+explanation）+ 一个 submit（groups 全列），本地判分。
- Secrets ban: 不索取密码、API Key、Token、恢复码；需要时拒绝并解释。
- Tool channel: render_ui 工具把同一 spec 渲染为工具行卡片；围栏用于回答内联 UI。
- 围栏位置：\`owl-ui\` 只写在**回答正文**；写在 reasoning/思考块里不渲染、用户看不到。`
