# Claude Desktop 对齐清单

owl 的回答流要「完全像 Claude」。这份清单把要逆向的点拆成八项，每项写清
Claude 的确切机制（打包产物里的符号）、owl 的落点、以及验收方式。

逆向来源（只读）：

```
C:\Program Files\WindowsApps\Claude_2.42304.0.0_x64__pzs8sxrjxfjjc\
  app\resources\ion-dist\assets\v1\
    c05b96c7f-DklIyA-P.js   回答流渲染层（分组器 ie、行校验 sc、思考 xh/nm/tm/im）
    shared-130-DnUXVlYq.js 标签生成器 lL + 三张文案表 kF/RF/zF + 组级文案 IH
    shared-26-CgdP_nTj.js  文案本地化表 Vp/Hp
    cc1aae219-DjR8LnUv.js  tool_use 的 wire 字段全集（title_parts 等）
    c6a992d55-sXiDGMFQ.css  --cds-* 设计 token
    caf9acda5-DZQdrmOl.js  产物页 composer（artifact-page-composer）
    cca654f75-B7IqV80J.js  产物页头部（frame-artifact-viewer-header）
    c3cbaca16-PdxmNS7W.js  产物视图双模式（Thread / Browser）
    cc874c60c-Bz93e0mK.js  产物页词表（Ask Claude / Claude's reply）
```

---

## 一、Claude 的两套文案语域（先分清，否则全抄错）

Claude 同时用两种语域，抄的时候不能混：

| 语域 | 例子 | 来源 | 什么时候出现 |
| --- | --- | --- | --- |
| **兜底标签** | `Reading a file` / `Searching files` / `Running a command` / `Listed files` | 前端三张表 `kF`/`RF`/`zF` | 模型没写标题时 |
| **模型撰写** | `Read index.html` / `Searched loean-{mark\|word}` | wire 的 `title_parts`（模型自己写） | 优先，永远优先 |

模型撰写的标题是**过去时 + 最有辨识度的名词**（claude-code 的提示词原文：
「Keep the verb in past tense」）；前端兜底表是**现在进行时、泛指**。
两边都是 Claude 的原文，抄的时候要按来源分别抄。

组级文案（组头）又是第三套：`IH` 的 `Read a file` / `Read 3 files` / `Searched files`，
也是过去时。

---

## 八项清单

| # | 项目 | 状态 | 落点 |
| --- | --- | --- | --- |
| 1 | 工具行标签（三态生成器） | ✅ 已落地 | `components/claude-tool-labels.ts` |
| 2 | 中间叙述折叠（说明行） | ✅ 已落地（前端口径） | `components/claude-narration.ts`、`ClaudeNoteRow.tsx` |
| 3 | 引用与来源 | ✅ 已落地 | `packages/ai` 协议 + `components/citations.ts` |
| 4 | 内部工具不进回答流 | ✅ 已落地 | `ToolCall.hiddenInChat` 全链路 |
| 5 | 组头 wire 形态 | ⬜ 不改（理由见下） | — |
| 6 | 状态依赖标签 | ✅ 三态已落地 | `claude-tool-labels.ts` |
| 7 | Artifacts 子系统 | ✅ 产物清单 + 产物页内会话 | `hooks/products.ts`、`ProductList.tsx`、`sidebar/tabs/ArtifactTab.tsx` |
| 8 | 排版尺度与文字层级 | ✅ 已落地 | `components/claude-design-tokens.css` |

## 第二轮：交互层六项（语音/听写除外）

八项是「回答流长什么样」；这一轮补的是「回答流怎么和用户互动」。
语音/听写（`dictation` / `voiceMode` / `microphone`）明确不做。

| # | 项目 | 状态 | 落点 |
| --- | --- | --- | --- |
| 1 | 计划模式（计划 → 步骤行 → 批准/驳回带反馈） | ✅ 已落地 | `components/ClaudePlanCard.tsx` |
| 2 | 主动建议卡（`offer_next_step`） | ✅ 已落地 | `src/extensions/offer-next-steps/` + `ClaudeNextStepChips.tsx` |
| 3 | 任务清单的行内实时步骤行（`task_list_row` family） | ✅ 已落地 | `components/claude-task-list.ts`、`ClaudeTaskListCard.tsx` |
| 4 | 来源卡（source card） | ✅ 已落地 | `components/citations.ts`（卡片网格） |
| 5 | `resultEcho`（结果命中则不显示原文） | ✅ 已落地 | `components/claude-task-list.ts`（`isResultEchoed`） |
| 6 | 产物页内会话（侧栏工作台承载产物页 + 页内对话） | ✅ 已落地 | `sidebar/tabs/ArtifactTab.tsx`、`hooks/use-artifact-thread.ts` |

### 计划模式 ✅ 已落地

**Claude 的机制**：`ExitPlanMode` 是**工具**，模型用它提交计划（不是写一段散文）；
计划在回答流里渲染成**步骤行**（`TurnStatus` 的 `planLine` / `stepNodes` /
`state` / `failedLabel` / `elapsedSeconds` / `mark`）。文案：
`Claude proposed a plan` / `Approve plan` / `Plan approved` / `Plan rejected` /
`Plan feedback` / `Following a plan` / `No plan written yet` /
`Plan too large to show in full`。

**owl 的落点**：**不引入新协议** —— 计划模式（`approvalMode === "plan"`）下
owl 本来就要求模型先给一份可执行计划，而 owl 的**任务清单**（todo 工具）
就是一份带状态的任务列表。所以计划 = 清单，计划卡 = 步骤行 + 两个决定：
- **批准**：切回 confirm 模式，模型按计划执行
- **驳回**：带一句反馈重新规划（反馈走独立输入框）

计划模式下清单**不逐步显示**，收成轮末的一张计划卡
（`ClaudePlanCard.tsx` + `claude-plan-card.css`）。

### 主动建议卡 ✅ 已落地

**Claude 的机制**：`offer_next_step_v0` 是 **display tool** 的结果
（`shared-130` 的 `Fz` 列表），渲染成一排芯片；点一下用
`sendTransparentMessage` 发出去（不留用户轮次）。

**owl 的落点**：
- `packages/coding-agent/src/extensions/offer-next-steps/`：照 `tool_search` /
  `codemode` 的模式注册成 **inactive 扩展**（`defaultActive: false`，
  用 `defaultTools: ["+offer_next_steps"]` 开启），`exposure: "model-only"`
  —— 默认不声明给模型，避免每次回答都变成菜单
- `apps/desktop/src/components/ClaudeNextStepChips.tsx`：轮末渲染芯片
- 点击只**填进输入框**（`onPromptExample`），不直接发送 ——
  Claude 是直接发，owl 少一次不可撤销动作

### 任务清单的行内步骤行 ✅ 已落地

**Claude 的机制**：`task_list_row === true && title_source === "authored"` →
走 `taskList` family；`ac` family map 里它的 `labelShapes` 是
`Started "X"` / `Completed "X"`。

**owl 的落点**：`hooks/transcript.ts` 的 `ToolOutput.todos`
（todo 工具回传的 `details.todos`）→ `components/claude-task-list.ts`
（`taskListOf` / `taskListLabel` / `taskListProgress`）→
`ClaudeTaskListCard.tsx` 渲染成行内清单卡。

### `resultEcho` ✅ 已落地

**Claude 的机制**：结果命中正则（`/^Updated task #\d+ status\.?$/`）时
**不显示原始输出**，只回显成标签 —— 清单卡已经说了同样的事，原文是噪声。

**owl 的落点**：`components/claude-task-list.ts` 的 `isResultEchoed`；
ChatStream 里 todo 工具的原始输出（「任务清单已更新 — N items: …」）被回显掉。

### 来源卡 ✅ 已落地

Claude 的来源面板是**卡片网格**（站点徽标 + 标题链接 + host + 片段两行截断），
不是一列裸链接。owl 的 `components/citations.ts` 升级成同样的网格
（`citations.css` 同步）。

### 产物页内会话 ✅ 已落地

**Claude 的机制**（逆向自三个文件）：
- `cca654f75-B7IqV80J.js`：**产物页头部** —— `frame-artifact-viewer-header`，
  文案 `Untitled artifact` / `Copy link` / `Share` / `Open in chat` /
  `Start a new chat` / `Open in new tab` / `Loading artifact…` / `Retry`
- `c3cbaca16-PdxmNS7W.js`：**双模式切换** —— `data-artifact-viewer-mode`，
  两个模式是 **Thread**（关于这份产物的对话线程）与 **Browser**（产物本体）
- `caf9acda5-DZQdrmOl.js`：**页底 composer** —— `artifact-page-composer`，
  发送时带 `switchDocsOn: true` + `docArtifact: <产物>`：
  **产物本身是这一轮对话的文档上下文**
- `cc874c60c-Bz93e0mK.js`：**词表** —— `Ask Claude` / `Ask Claude · N attachments` /
  `Claude's reply` / `Dismiss` / `Open in chat`；回复预览按 **200 字**裁剪

**owl 的落点**：
- `apps/desktop/src/sidebar/tabs/ArtifactTab.tsx`：侧栏工作台的 `artifact` 页签，
  页内「产物 / 对话」双模式（对应 Claude 的 Browser / Thread）
- `apps/desktop/src/hooks/use-artifact-thread.ts`：**独立会话线程**（不进主对话），
  按「项目 + 产物」持久化，`session.resume` 静默回放
- `apps/desktop/src/hooks/artifact-thread.ts`：产物上下文提示词 + 回复预览
  （`trimReplyPreview` 逐字照抄 Claude 的 200 字裁剪）
- 上下文怎么带：文件产物走 `attachedPaths`（模型自己去读），
  可视化产物把 genui spec 内联进正文（它没有文件可读）
- 回答以「Owl 的回复」短摘录**内联回显**，配「收起」与「带回主对话」
- 产物清单点条目 = **开产物页**（Claude 点产物就是开产物页，不是跳文件预览）

**没做的部分**：Claude 的产物是**服务端实体**（发布、分享链接、产物级审批、
多人协同）；owl 的产物只活在会话里，所以没有 `Copy link` / `Share`，
「带回主对话」是填进主输入框而不是跳到一个独立会话。

---

## 第三轮：回答操作栏的赞/跌 ✅ 已落地

Claude 的 assistant 操作栏是**固定的动作集**，顺序也是定的：

```
copy → readAloud → feedback → retry → branch
```

来源：`ca2ef848d-CWUk7Rll.js` 的
`Tq = { assistant: ["copy","readAloud","feedback","retry","branch"],
        user: ["retry","rewind","edit","copy","resend","discard","branch"] }`。

owl 已有 copy / retry / branch，**缺 feedback**（readAloud 属语音家族，本轮不做）。

### Claude 的 feedback 机制

- `c4a9ee384-ZZIKqgNM.js` 的 `case "feedback"`：渲染**两个**按钮
  （`Re.PositiveFeedbackAction` / `Re.NegativeFeedbackAction`，图标 ThumbsUp /
  ThumbsDown），带 `pressed` 态；`savedFeedback` 是一个值（`"up"` / `"down"`），
  所以**赞和跌互斥**，再点同一个即取消。
- `shared-104-Cqo2-vQh.js`：文案 `Good response` / `Bad response`。
- `c368fdb57-TPOrFKUt.js`：踩之后是「Tell us more (optional)」+ 4 行文本框
  （placeholder「What's working well or could be improved?」）+ Cancel / Submit，
  提交后 toast「Thanks for the feedback」。

### owl 的落点

- `apps/desktop/src/components/ClaudeAnswerFeedback.tsx`：两个拇指按钮 + 踩的展开框。
- `apps/desktop/src/components/claude-answer-feedback.ts`：评分互斥/取消、**按会话存本地**
  （`owl.feedback.<sessionId>`）、给模型看的反馈正文。
- 位置：操作栏里排在**复制之后、重新生成之前** —— 就是 Claude 的顺序。
- 文案：owl 的 `chat.msgLike` / `chat.msgDislike` 早就存在，英文正好是 Claude 的
  `Good response` / `Bad response`，直接复用；表单那几句按 Claude 的原文补。

**与 Claude 的必要差异**：Claude 把评分提交给 Anthropic（用来改进模型），
owl 没有那个后端。所以评分记在本地；用户写的理由走 owl 既有的反馈通道
（`ExecutionContext.onSubmitFeedback`，把正文作为下一轮消息交给模型）——
**留空提交只记录，不打扰对话**。



### 1. 工具行标签（三态生成器） ✅ 已落地

**Claude 的机制**：`shared-130` 的 `lL(toolName, input, {done, cancelled})`。
优先级链（`c05b96c7f` 的 `Y_()`）：

```
模型撰写的 title_parts → 输入里的 description → wire 上的 label → 兜底表
```

兜底表分三态：
- 运行中 `kF`：`read → "Reading a file"`、`grep → "Searching files"`、
  `glob → "Looking for files"`、`ls → "Listing files"`、`web_search → "Searching the web"`
- 完成 `RF`：`ls → "Listed files"`、`exit_plan_mode → "Proposed a plan"`、
  `skill → "Ran skill"`、`tool_search → "Loaded tools"`
- 中断 `zF`：`read → "Stopped reading file"`、`bash → "Stopped running the command"`

bash 单独一支：`Running a command` / `Ran a command` / `Stopped running the command`。

文件类工具还有一支「短路径」分支（`QI()`）：路径超过两段保留最后两段，
`src/admin/index.html → admin/index.html`，于是标签是 `Reading admin/index.html`。

**owl 的落点**：`apps/desktop/src/components/claude-tool-labels.ts`
（`claudeToolLabel` / `claudeToolLabelFor` / `claudeShortPath`），
`ClaudeToolGroupView.tsx` 用它渲染行标签，对象进 tooltip。

**验收**：`claude-tool-labels.test.ts`（11 条）+ 浏览器对照。

---

### 2. 中间叙述折叠 ✅ 已落地（前端口径）

**Claude 的机制**：分组器 `ie()` 把 content block 归成四类单元，其中一类是
「说明行」——**label = 首行正文，截断到 200 字符**（bundle 里的 `Zo=200`）。
也就是说中间叙述（「Let me look at the sidebar first.」）收成一行，
只有最终回答才是整段正文。

更完整的实现是 `narration_fold` + `Jm`/`Xm`：策略对象
`Hm = {source:"server", maxChars:∞, maxRunBlocks:∞, blockOnStructure:false, blockOnCitations:false}`
与 `Um = {source:"model", …, blockOnCitations:true}`，
`Gm = /(^|\n) {0,3}(#{1,6} |```|~~~|\|)/` 识别结构（标题/代码块/表格），
组在带引用、有结构、超长、超块数时断开。

**owl 的落点**：`claude-narration.ts`（`claudeNoteLabel`）+ `ClaudeNoteRow.tsx`，
`ChatStream.tsx` 的 note 分支改用它。

**未做的部分**：`Jm`/`Xm` 那套「按结构断组」是服务端语义（`narration_fold`
由后端下发），owl 的协议里没有这个字段。前端口径已经是 Claude 的观感；
要完全一致，需要后端给 text block 加 `narration_fold` 标记。

---

### 3. 引用与来源 ✅ 已落地（协议层 + 前端）

**Claude 的机制**：text block 带 `citations[]`；`Ym()` 判
`narration_fold === "folded" && !citations?.length` —— **有引用就不折叠**，
说明引用是锚点级 UI 元素。界面上有行内角标 + 来源面板
（`All sources` / `Browse Anthropic sources`）。

**两侧的真实 wire 形状**（逆向自 SDK 类型 + API 实际返回）：

| provider | 形状 |
| --- | --- |
| Anthropic | text block 上的 `citations[]`；流式时以 `citations_delta` 逐条到达。变体：`char_location` / `page_location` / `content_block_location`（文档引用，偏移是**源文档**里的位置）/ `web_search_result_location` / `search_result_location`（网页引用） |
| OpenAI Responses | `output_text` 的 `annotations[]`，`type: "url_citation"`，`start_index`/`end_index` 是**正文**偏移；流式事件 `response.output_text.annotation.added` |
| pi-messages | 网关自己归一后的 `citations`（`text_start` / `text_end` 上） |

**owl 的落点**：
- 协议：`packages/ai/src/types.ts` 的 `Citation` + `TextContent.citations`；
  新事件 `AssistantMessageEvent.text_citation`
- 解析：`anthropic-messages.ts`（`normalizeCitation`）、`openai-responses-shared.ts`
  （`normalizeAnnotation`，`annotation.added` 事件 + 最终 item 上的 annotations 兜底）、
  `pi-messages.ts`（网关直通）
- 透传：`packages/agent/src/agent-loop.ts`（`text_citation` 事件）、
  `packages/agent/src/proxy.ts`（代理事件）
- 前端：`apps/desktop/src/hooks/transcript.ts`（正文段累积引用）、
  `apps/desktop/src/components/citations.ts`（角标 + 来源面板）、
  `answer-markdown-renderer.ts`（`renderAnswerMarkdown(text, diff, citations)`）
- 折叠联动：**带引用的段落不折叠**（对齐 Claude 的 `Ym()`）

**角标位置的一个坑**：只有 OpenAI 的 `url_citation` 的偏移是正文偏移。
Anthropic 的 `char_location` 的偏移是**源文档**里的位置，拿它当正文偏移
会把角标插错地方 —— 这类引用没有正文锚点，角标落在段落末尾。

---

### 4. 内部工具不进回答流 ✅ 已落地

**Claude 的机制**：渲染层的 `dm(e)` 判 tool_use 是否 `hidden_in_chat === true`
或命中内部工具集；`fm()` 把对应的 tool_result 一并丢掉，但**统计里仍算它**。

**owl 的落点**：
- `packages/ai/src/types.ts` 的 `ToolCall.hiddenInChat`
- `packages/ai/src/api/pi-messages.ts`：网关用 Claude 的字段名
  `hidden_in_chat` 下发，客户端归一成 `hiddenInChat`
- `apps/desktop/src/hooks/transcript.ts`：`ToolCard.hiddenInChat`
- `ChatStream.tsx`：Claude 模式下过滤掉，但步数照算

**没做的部分**：Claude 那套「按工具名隐藏」的内部工具集（`dr`/`yr`/`Ra`/`Hr`
四个集合）没扒全 —— 对 owl 而言 `todo` 已经单独处理（走 TodoPin，不上时间轴）。

---

### 5. 组头的 wire 形态 ⬜ 形态不同，未改

**Claude 的机制**：组头**不是事件**，是 assistant 消息里的一个 content block：
`cm(e) = e.type === "tool_use_summary"`，靠
`e.preceding_tool_use_ids?.some(id => tools.has(id))` 关联到具体工具 id
（`cc1aae219` 的字段全集里 `title_parts` 也是同一层的字段）。

**owl 的现状**：组头走**独立事件** `tool_use_summary` → 服务端把 label 落到
组内每张卡的 `batchLabel` → 渲染时取任意一张。

**差异与要不要改**：
- Claude：组头 ↔ 工具集合是 wire 上的显式关系
- owl：靠「贴到每张卡」反推，前端分组边界与服务端批次边界不一致时会错配

改的话要动 `packages/agent` 的事件协议 + `packages/coding-agent` 的
`afterToolBatch` + `apps/desktop` 的 transcript，属跨包协议变更。
**建议先不做**：现在服务端与前端共用同一套「批次」概念，实际不会错配；
等有第二个宿主（CLI / SDK）再统一成 wire 形态更划算。

---

### 6. 状态依赖的标签形状 ✅（三态）/ ⬜（family map）

**Claude 的机制**：
- 三态（running / done / cancelled）→ 见第 1 项，**已落地**
- `ac` family map：`taskList` 的 `labelShapes: e => ["Started \"X\"", "Completed \"X\""]`，
  `Skill` 的 `Loaded ${e} skill` + `verbMetaForm`
- `resultEcho`：结果命中正则时**不显示原文**，只回显成标签
  （`/^Updated task #\d+ status\.?$/`）

**owl 的落点**：三态已在 `claude-tool-labels.ts`；
family map 那两个 family 对应 Claude 的 Task/Skill 工具，owl 没有同名工具，
等 owl 接入子代理任务卡（`task` 工具的子代理组）时再补。

---

### 7. Artifacts 子系统 ⬜ 范围过大 —— 已落产物清单 + 产物页内会话

**Claude 的机制**：bundle 里 3207 处命中，是一整套子系统：
artifact 类型（`artifact type`）、artifact 页面（`chat.artifact_page_send`）、
artifact 房间的实时事件、往 artifact 里上传文件（`Added artifact files`）、
artifact 发布（`Publishing an artifact` → `Published an artifact`）、
artifact 审批（「Approving also covers more uploads and copies into this artifact
for the rest of this task」）。

**owl 的现状**：`packages/owl-genui` 有内联可视化（echarts / mermaid /
interaction store），但没有「产物是一等公民」这一层。

**已落地的子集一：产物清单**

owl 的产物分两类，这一轮把它们收成**一张表**：

| 产物 | 来源 | 打开方式 |
| --- | --- | --- |
| 新建的文件 | `write` 工具 / `details.artifacts` | **产物页**（侧栏工作台） |
| 可视化 | `render_ui` 的 `output.genuiSpec` | **产物页**（侧栏工作台） |

与「改动卡」的分工：**改过的**文件进改动卡（带 diff 审阅），
**新建的**文件与可视化进产物清单 —— 两张卡不重复。

落点：
- `apps/desktop/src/hooks/products.ts`：`Product` / `collectProducts` /
  `productsOfTools`；可视化产物的形态由 genui spec 的首个有意义节点推出
  （chart / table / code / view）
- `apps/desktop/src/components/ProductList.tsx`：一张表，一行一个产物
- `ChatStream.tsx`：Claude 模式下插在轮末（总结行之后）
- 定位：走对话区自己的滚动容器（`.owl-chat-scroll`），并先关掉「跟随新内容贴底」
  —— 否则自动贴底会把刚定位好的位置又拽回底部

**已落地的子集二：产物页内会话** —— 见上面「第二轮第 6 项」。

**没做的部分**（还是服务端能力，owl 协议里没有对应实体）：
产物发布与分享（`Copy link` / `Share`）、产物类型系统、产物级审批与审计、
多人协同的产物房间。


**与工具行文件卡的关系**：Claude 会把「这一轮交付了哪些文件」做成**文件卡**挂在
产出它的那次工具调用下面（`present_files` 的等价物，见 `claude-file-cards.ts`），
同时还有一张产物清单。owl 现在也是这两层：工具行下的文件卡是局部细节，
轮末的产物清单是这一轮的总目录。

---

### 8. 排版尺度与文字层级 ✅ 已落地

**Claude 的机制**：`--cds-*` 共 1069 个 token。owl 要的那几个（逐字）：

| 类别 | 数值 |
| --- | --- |
| 字号 | body 13 / heading 14 / prose 14 / caption 11 / footnote 12 / code 12 / title 20 |
| 行高 | body 20 / heading 18 / prose 20 / caption 17 / footnote 15 / title 25 |
| 间距 | gap-xs 6 / gap-sm 8 / gap-md 12 / gap-lg 20；pad-xs 4 / pad-sm 8 / pad-md 6 / pad-lg 14 / pad-xl 22 |
| 圆角 | radius-sm 5 / radius-lg 7 / radius 24 / msg-block 12 |
| 文字层级 | primary / secondary / muted / muted-as-secondary 四档 |
| 灰阶 | gray-900 `#0b0b0b` / 600 `#52514e` / 400 `#898781`；disabled = ink 35% |

**owl 的落点**：`apps/desktop/src/components/claude-design-tokens.css`
（`--owl-claude-*` token + 四档文字层级）。
颜色不写死 Claude 的灰阶，而是映射到 owl 现成的 `--owl-reading-*`，
这样浅色/深色/壁纸主题都跟着走。

**顺带修掉的**：owl 的 Claude 样式里引用了 `--owl-reading-faint`，
但这个变量**从来没定义过** —— 箭头、时长、计数的颜色一直是失效的。

---

## 还值得顺手做的（不必单独立项）

- `Qp()` 标签尾部修剪：去尾部 `…`、`..`、三个以上句点 —— ✅ 已落地
  （`components/claude-label-trim.ts`，并发 agent 做的）
- `Yp`/`Xp` 外链分类：内网 host、超 253 字符 host、已知域名表 → 不同的打开方式
  —— **可移植，收益一般**（见下）
- `Up`/`Wp`/`Gp` 把 `mcp__{server}__{tool}` 映射成人话
  （`list_mcp_resources → "Listing resources"`）—— ✅ 已落地
  （`components/claude-tool-phrases.ts`）
- `$p()` 记忆类改写：工具操作的是记忆路径时，
  `read/grep/glob → auto_memory_read`、`write → auto_memory_create`、
  `edit → auto_memory_edit` —— **不可移植**：owl 没有记忆工具
  （`coding-agent/src` 里搜不到 `auto_memory`），等 owl 接入记忆再做。

### 下一轮的候选（第三轮扫出来的，按推荐顺序）

| # | 候选 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | **回答的赞/跌**（Claude 的 `feedback` 动作） | ✅ 本轮已做 | `components/ClaudeAnswerFeedback.tsx` |
| 2 | 外链分类与打开方式（`Yp`/`Xp`） | ⬜ 可做 | Claude 按 host 决定一个 URL 做不做成可点链接、怎么打开（`Ho()` 是安全 URL 判定：只收 http(s)、无用户名密码、无 punycode、且 `new URL(x).href === x`；`Xp()` 再判内网 host、host 超 253 字符、已知域名表）。owl 现在一律做成外链 |
| 3 | 产物的评论与转发（`chat.artifact_comment` / `chat.artifact_send_to`） | ⬜ 缺后端 | 评论要多人协同，owl 的产物只活在会话里 |
| 4 | seed 卡（`chat.task_seed` / `chat.artifact_seed`） | ⬜ 语义待挖 | 「接着这个任务/产物继续」的种子卡 |
| 5 | 回答的「流丢失 / 未完成」提示（`notices.stream_lost` / `unfinished`） | ⬜ 待比对 | owl 有「已暂停」与恢复提示，语义可能已覆盖 |
| 6 | 朗读（`readAloud`） | 🚫 不做 | Claude 是**服务端 TTS**（WebSocket 流式音频），属用户明确排除的语音家族 |


---

## 验证方式

```powershell
cd D:\owl\owl-re-v1\owl-mono\apps\desktop
npx tsc --noEmit          # 类型
npm test                  # 全量（vitest + node --test 分流）
npx vite --port 5199 --strictPort   # 预览页
#   http://localhost:5199/debug-claude-format.html
```

第二轮六项的定点测试：

```powershell
cd D:\owl\owl-re-v1\owl-mono\apps\desktop
npx vitest --run src/components/claude-products-render.test.tsx   # 计划卡 / 清单 / 芯片
npx vitest --run src/sidebar/tabs/artifact-page.test.tsx          # 产物页 + 页内对话
node --experimental-strip-types --test src/hooks/artifact-thread.test.ts
```

预览页带四个开关：`normal` / `verbose` / `claudeFlow: on|off` /
`thinking: claude|expandable`，用它做截图对照。

产物页另有一个预览页（侧栏那一页的真实渲染，桥与工作台都是假的）：

```
http://localhost:5199/debug-artifact-page.html   # chart / file 两个开关
```
