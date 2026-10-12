# owl-github

Owl 编码代理的 GitHub 工具插件：通过宿主机上已登录的 `gh` CLI 操作当前仓库的
PR、Issue、Actions 运行/工作流和 Release，共 36 个类型化工具。

来源：[amitkot/pi-tools](https://github.com/amitkot/pi-tools/tree/main/packages/safe-github)
的 `@amitkot/pi-safe-github` 0.2.0（MIT）。

## 前提

- 安装 GitHub CLI 并登录：`gh auth login`（`gh auth status` 能看到账号即可）。
- 在 `origin` 指向 GitHub 的仓库里使用；也可以在调用时传 `cwd`。

## 工具

只读（plan 模式放行）：`github_auth_status`、`github_repo_info`、`github_branch_info`、
`github_pr_list` / `view` / `checks` / `files` / `diff`、`github_run_list` / `view` / `logs`、
`github_commit_status`、`github_issue_list` / `view`、`github_workflow_list` / `view`、
`github_release_list` / `view`。

写操作：`github_pr_create` / `edit` / `comment` / `review` / `ready` / `close` / `reopen` / `merge`、
`github_issue_create` / `comment` / `edit` / `close` / `reopen`、`github_workflow_dispatch`、
`github_run_rerun` / `cancel`、`github_release_create` / `upload_asset`。

高风险操作（建 PR、合并、触发/重跑/取消工作流、建 Release、传附件）不带 `confirm: true`
时只返回预览，不做任何改动。合并默认要求检查全部通过。

## 安全模型（继承上游）

- `execFile` + 参数数组调用 `gh` / `git`，不经过 shell。
- 超时与输出上限；错误信息里的令牌（`ghp_…`、`github_pat_…`）和家目录路径会被脱敏。
- 不提供通用 `gh api` / `gh auth token` 工具。
- 子进程只拿到白名单内的环境变量。

## 与上游的差异（OWL-PATCHES）

源码中以 `OWL-PATCH` 注释标出：

- 类型取自 `@owl/owl-coding-agent`。
- **Windows 可用**：子进程环境白名单补上 `APPDATA`、`USERPROFILE`、`SystemRoot` 等
  （上游只透传 `HOME` / `PATH`，在 Windows 上 `gh` 找不到登录态）；透传
  `HTTP(S)_PROXY` 以走 Owl 设置里的代理；设置 `GH_PROMPT_DISABLED` / `GIT_TERMINAL_PROMPT=0`，
  缺凭据时立即失败而不是卡到超时。错误脱敏同时处理 `USERPROFILE`。
- 工具注册为 `exposure: "deferred"`、命名空间 `github`：36 个 schema 不进每次请求，
  模型通过 `tool_search` 按需加载。每个工具带 `annotations`（`readOnlyHint` /
  `destructiveHint`），只读集合 `READ_ONLY_TOOLS` 与桌面 plan 模式白名单
  （`coding-agent/src/modes/desktop/browser-permissions.ts`）保持一致。
- 远程地址解析额外接受 `https://user@github.com/…` 与结尾斜杠。
- 修复上游 `github_branch_info` 结果里 `branch` 键重复（API 返回值覆盖了分支名），
  API 返回值改放在 `branchApi`。
- 提示词里的 Pi 权限说法改为 Owl 审批。

## 接入方式

settings（`data/owl/settings.json`）的 `plugins` 数组按路径引用：

```json
"plugins": [
	"D:\\owl\\owl-re-v1\\owl-mono\\packages\\owl-github"
]
```

改完源码后 `npm run build` 再重启 owl 生效。

## 开发

```bash
npm run build     # 打包 dist/index.js
npm run smoke     # 冒烟：注册/暴露/注解、远程解析；gh 已登录时跑只读调用与预览
npm run typecheck # tsc --noEmit
```

## License

MIT，见 LICENSE（含上游归属）。
