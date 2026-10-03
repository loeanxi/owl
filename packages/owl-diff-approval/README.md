# owl-diff-approval

owl「改动审批」插件：自动追踪 AI 代理每次成功的 `write` / `edit`，把改前基线汇总为工作区待审清单，桌面工作台「改动审批」卡片里逐文件查看 diff 并**保留 / 回滚**。

移植自 [9087/dsh-diff-approval](https://github.com/9087/dsh-diff-approval)（MIT）的核心语义，按 owl 自己的扩展 API 全新实现。

## 行为

- **捕获**：`tool_call`（执行前）暂存改前内容，`tool_result` 成功才落库——失败的编辑不产生条目。只追踪 `write` / `edit` 工具；shell 造成的改动不捕获（与上游口径一致），已追踪文件被外部删除时列表会显示「文件已不在磁盘上」，回滚即恢复。
- **基线**：每文件一条目，基线 = 本工作区内第一次被 AI 编辑前的内容；待处理期间的重复编辑不换基线，diff 始终是「改前 vs 当前磁盘」的活口径（外部改动同样如实呈现）。已处理（保留/回滚）的文件再次被编辑时，以新基线重新进入待处理。
- **保留**：接受改动，不动磁盘。**回滚**：还原基线内容（保留原换行符）；AI 新建的文件回滚即删除。
- **范围**：二进制文件、超过 4MB 的文件不追踪。
- **持久化**：按工作区落盘 `<agentDir>/diff-approval/workspaces/<工作区哈希>.json`，跨重启、跨会话保留；损坏文件备份为 `*.corrupt` 后从空重建。
- **实时性**：每次落库/处理经广播接缝推 `diffApproval.changed`，工作台卡片自动刷新。

## 接入

`settings.json` 的 `plugins` 加入本包本地路径即可：

```json
{ "plugins": ["…\\owl-mono\\packages\\owl-diff-approval"] }
```

桌面端入口：工作台快捷卡「改动审批」（与文件变动并列）。

## 桥协议（供 UI / 排查）

| 消息 | 说明 |
| --- | --- |
| `diffApproval.list` `{ cwd }` | 待审清单（含 +/− 行数、状态、时间） |
| `diffApproval.diff` `{ cwd, entryId }` | 单文件 unified diff（基线 vs 当前磁盘） |
| `diffApproval.resolve` `{ cwd, entryIds, action }` | 批量保留/回滚 |
| `diffApproval.clear` `{ cwd }` | 清除已处理条目 |
| `diffApproval.changed`（推送） | `{ cwd }` 清单已变化 |

## 未移植（与上游差异）

逐差异块保留/回滚、双栏对比、Ctrl+F 搜索、行引用自动对齐、Git/SVN/Perforce 未提交改动导入、Markdown 渲染预览、字体/配色设置。工作台已有的「文件变动」（Git 视角）卡片可覆盖部分 VCS 需求。

## 结构

- `index.ts`——插件入口（捕获钩子），jiti 直载，无构建步骤
- 捕获的存储/回滚本体在宿主包 `coding-agent/src/core/diff-approval/`（注册表单例 + 原子落盘），桌面桥的 `diffApproval.*` case 在 `coding-agent/src/modes/desktop/serve.ts`
- 前端卡片在 `apps/desktop/src/sidebar/tabs/ReviewTab.tsx`
