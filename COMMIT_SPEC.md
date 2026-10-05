# 提交规范（Commit Spec）

适用范围：本仓库（owl-mono）的全部提交，人写与 agent 写、手动提交与钩子自动提交同样生效。
与 `AGENTS.md`「Git」一节冲突时，以本文件为准。

## 0. 提交信息写给谁

写给三个月后翻 `git log` 的人（多半是你自己），不是写给当下会话的用户。
一条提交信息要能独立回答：改了什么、为什么改、影响哪里。

本仓库历史污染的直接来源是自动化提交把**会话回复原文**粘进了提交信息
（「修好了」「完成了」「验收截图在下面」）。此类提交信息无法检索、无法回溯，一律禁止。
会话回复归会话，提交信息归提交，两份文本分开写。

## 1. 格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

header 必填；scope、body、footer 按需。header 整行不超过 72 显示列（全角按 2 列计）。

### 1.1 type（必选，小写）

| type | 用途 | 判断标准 |
|---|---|---|
| feat | 新功能、新行为 | 用户/开发者能感知到新能力 |
| fix | 缺陷修复 | 对应一个可描述的错误行为 |
| docs | 仅文档 | 不触碰代码行为 |
| refactor | 重构 | 对外行为零变化 |
| perf | 性能优化 | 行为不变，快了/省了 |
| test | 仅测试 | 新增或修正测试，不改产品代码 |
| build | 构建与依赖 | 依赖版本、构建脚本、lockfile |
| chore | 杂项 | 配置、钩子、脚本等仓库维护 |
| ci | CI 配置 | GitHub Actions 等（若引入） |
| style | 格式 | 不改逻辑的排版/格式调整 |
| revert | 回滚 | 见 1.4 |

- 一次提交既有功能又有修复：拆成多条提交。确实拆不开时用占主导的 type，body 里列出次要改动。
- 不允许 `wip` 或自造类型。未完成的工作留在工作区，不进 main。

### 1.2 scope（推荐，取仓库实际结构）

scope = 改动所在包/应用的目录名：

- 包：`agent`、`ai`、`codemode`、`coding-agent`、`owl-ask-user`、`owl-billion-context`、
  `owl-context`、`owl-diff-approval`、`owl-genui`、`owl-image`、`owl-media-bridge`、
  `owl-safety-net`、`owl-univer-office`、`owl-web-access`
- 应用：`desktop`（apps/desktop）
- 仓库级：`repo`（根配置/钩子/.gitignore）、`scripts`、`deps`（依赖变更）

跨多个包的改动省略 scope（`fix: ...`）。允许临时 scope（如 `design`），但要望文生义；优先用标准 scope。

### 1.3 subject（必选）

- 中文为主，专有名词与标识符保留英文（本仓库文档惯例如此）。
- 一行，不超过 30 个全角字符，结尾不加句号、感叹号。
- 说「做了什么」，动词开头；把 subject 单独贴进 changelog 要能读懂。
- 禁止出现（全部来自真实历史，勿重蹈）：
  - 对话式短语：`修好了` / `完成了` / `改完了` / `不合理，已经改掉了`
  - 汇报式总结：`剩余 9 项全部修完` / `A、B、C、D 全部完成`
  - 构建与部署状态：`dist 已重建，重启桥服务后生效` / `前端构建过了，可以重新跑启动器了`（dist 不入库，构建状态不属于历史）
  - 指向仓库外事物：截图路径、PID、临时文件路径、`打开这个文件看：...`
  - emoji（AGENTS.md 既有规则）

对照示例（坏例均为真实历史提交）：

| 坏 | 好 |
|---|---|
| `修好了，一行修复 + 验收截图。` | `fix(desktop): 停止按钮透传取消事件，修复无响应` |
| `三个 bug 都修完了，验证通过。` | 拆成 3 条 fix，每条对应一个 bug |
| `完成了。回答底部的操作栏（复制 / 赞 / 踩 / 分支 / 重新生成 + tokens、时间戳）现在默认隐藏，鼠标悬停时才浮现，和 Clau…` | `feat(desktop): 回答操作栏默认隐藏，悬停浮现` |
| `前端构建过了，可以重新跑启动器了。` | （这类提交本不该存在，见 1.3 禁止项） |

### 1.4 body（推荐）

默认三段：根因/动机一行 → 关键改动 → 验证方式一行。修 bug 必须写根因。

- 每行不超过 72 显示列；列表用 `-`。
- 不写：构建状态、重启说明、截图路径、PID、临时路径。
- 一行能说清的改动（typo 等）可省略 body。
- 确需绕过 pre-commit 的例外提交（须用户当次明示），body 里写明绕过原因。

示例（对历史提交 9eadb92c 的重写示范）：

```
fix(coding-agent): 文件变动面板识别 workspace 子目录仓库

根因：git 层只对 workspace 根做 rev-parse，子目录仓库被判成非仓库，
面板不显示其变动。
改动：解析仓库根时逐级向上探测 .git。
验证：desktop-sidebar-workbench 测试更新后通过；手验子仓变动可见。
```

### 1.5 footer

- 破坏性变更：subject 末尾加 `!`，body 后加 `BREAKING CHANGE: <迁移说明>`。
- 关联 issue：`Closes #123`（修复）/ `Refs #123`（仅关联）。
- 回滚：`revert: revert "<原 subject>"`，body 写回滚原因与原提交 hash。
- 自动提交机制的署名行放 footer，纯文本（如 `Auto-committed by <机制名>`），不用 emoji。

## 2. 粒度与内容边界

- 一个提交 = 一个逻辑改动。功能、不相干的修复、重构分开提交。
- 只提交源码、文档、配置、测试。永不入库（.gitignore 已覆盖，不要手动 add）：
  构建产物 `dist/`、`node_modules/`、日志、截图、临时脚本、调试目录。
- 验收截图、调试报告放仓库外（如 `D:\owl\_scratch\`），不放仓库内。

## 3. 操作纪律

- pre-commit（husky：lockfile 校验 + `npm run check`）失败时修好再提；
  禁止 `--no-verify`（AGENTS.md 既有规则，重申）。例外须用户当次明示，且按 1.4 在 body 写明。
- 只提交本会话改动的文件：显式 `git add <path>`，禁 `git add -A` / `git add .`（AGENTS.md 既有规则，重申）。
- 同步远端用 `git pull --rebase`，避免 `Merge branch 'main' of ...` 噪声提交。
- 已推送的提交不改写历史，禁 force push（AGENTS.md 既有规则）。

## 4. Agent 与自动提交（治本条款）

本仓库提交大半由 AI agent 与自动提交钩子完成，历史污染全部来自同一类错误：
把「给用户看的回复」当成「给仓库看的提交信息」。执行：

1. 提交信息与对话回复是两份独立文本。回复可以口语、可以带截图；提交信息必须按本规范单独撰写，不得复制粘贴。
2. 写提交信息时假设读者看不到会话：根因、动机、验证方式必须自包含。
3. 一次会话的多轮修复按逻辑改动拆成多条提交；禁止把整场会话总结成一条「完成了 XXX」。
4. 拿不准 type 时想「这段历史以后按什么搜」：行为变化用 feat/fix，文档用 docs，依赖用 build(deps)。
5. 任何自动提交机制（Stop 钩子等）生成的信息同样必须符合第 1 节；
   默认实现「把会话回复粘进去」即为本规范第 0 节禁止的行为，必须改造。

## 5. 提交前自检

- [ ] header 是 `type(scope): subject` 形态？
- [ ] subject 独立可读、无对话腔、无句号、无 emoji？
- [ ] 修 bug 写了根因？改动了什么、为什么、怎么验证的？
- [ ] 只 stage 了自己的文件？没有 dist/截图/临时文件？
- [ ] `git log --oneline -3` 里新提交夹在历史里不违和？

## 6. 与其他文件的关系

- `AGENTS.md`「Git」一节：操作规则（禁用命令、staging 方式）；其 Message format 行已指向本文件。
- CHANGELOG 条目按 `AGENTS.md`「Changelog」一节管理；本规范的 subject 可直接复用为条目文本。
