# owl-diff-approval

owl「改动审批」插件：追踪 AI 每次成功的本地 `write` / `edit`，记录会话和轮次归属，在聊天卡和工作台中查看、保留或预览撤销所选改动。

移植自 [9087/dsh-diff-approval](https://github.com/9087/dsh-diff-approval)（MIT）的核心语义，按 owl 自己的扩展 API 全新实现。

## 行为

- **捕获**：`tool_call` 声明归属；宿主本地工具在真实写入队列中读取改前内容并记录预期输出，`tool_result` 成功且磁盘内容与预期一致后才可撤销。远程或自定义文件操作、执行期间变化、归属不唯一会显示不可自动撤销的原因。shell 改动不捕获。
- **范围**：每次操作独立保存 before/after、toolCallId、sessionId 和 turnId，聊天卡只选择当前轮次的工具调用，不按路径混入其他轮次或会话。
- **保留**：接受所选操作，不动磁盘。**撤销**：先显示实际受影响文件及预计差异，再按预览令牌确认。三方反向合并保留不同位置的后续修改和手改；重叠、重复内容歧义、预览后变化、符号链接、硬链接、非 UTF-8 或二进制内容会拒绝并说明原因。同文件多次选中操作先全部模拟，再一次写入。
- **新建和删除**：新建文件有未选中的后续操作或手改时不会直接删除。外部删除的文件不会在撤销时自动重建。旧记录缺少改后快照或归属时只允许人工核对和保留。
- **写入故障恢复**：撤销改写前先在同目录以 `wx` 和 `0600` 创建唯一原文备份并同步到磁盘；保留原文件 inode 和权限。部分写入、截断或同步失败会核对文件身份并回写预览前的完整内容。恢复成功后清理备份；恢复失败保留备份，并在错误中给出绝对路径。成功撤销但备份无法清理时仍计为成功，同时返回提醒和备份路径。
- **上限**：单文件快照最多 4MB；存在后续变化且内容超过 512KB 时不进行自动合并。
- **持久化**：按账号目录和工作区隔离，落盘 `<agentDir>/diff-approval/workspaces/<工作区哈希>.json`。跨进程元数据锁内重新读取、分配顺序并原子保存，避免覆盖另一个进程的操作记录。已保留的后续记录在更早待处理操作仍依赖它时保留快照；清除已处理列表只隐藏这些记录，仍保留撤销保护。
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
| `diffApproval.list` `{ cwd, scope? }` | 操作清单；scope 可含 sessionId 和 toolCallIds |
| `diffApproval.diff` `{ cwd, entryId }` | 单次操作 before/after unified diff |
| `diffApproval.preview` `{ cwd, entryIds, mode? }` | 所选操作的反向合并、冲突原因、确认令牌（5 分钟有效） |
| `diffApproval.resolve` `{ cwd, entryIds, action, previewToken? }` | 批量保留；撤销必须携带对应预览令牌，逐文件报告失败 |
| `diffApproval.clear` `{ cwd }` | 清除已处理条目 |
| `diffApproval.changed`（推送） | `{ cwd }` 清单已变化 |

## 未移植（与上游差异）

逐差异块保留/回滚、双栏对比、Ctrl+F 搜索、行引用自动对齐、Git/SVN/Perforce 未提交改动导入、Markdown 渲染预览、字体/配色设置。工作台已有的「文件变动」（Git 视角）卡片可覆盖部分 VCS 需求。

## 结构

- `index.ts`——插件入口（捕获钩子），jiti 直载，无构建步骤
- 捕获的存储/回滚本体在宿主包 `coding-agent/src/core/diff-approval/`（注册表单例 + 原子落盘），桌面桥的 `diffApproval.*` case 在 `coding-agent/src/modes/desktop/serve.ts`
- 前端卡片在 `apps/desktop/src/sidebar/tabs/ReviewTab.tsx`
