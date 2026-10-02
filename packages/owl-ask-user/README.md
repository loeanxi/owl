# owl-ask-user

owl 的「向用户提问」插件：给 agent 一个 `ask_user_question` 工具——agent 被真正属于用户的
决定卡住时，打包提出 1-4 个带选项的问题，桌面 UI 逐题弹出小卡（带描述的选项、单选/多选、
「其他」自由输入、每题备注、选项 markdown 预览），答案以结构化数据回给 agent。

## 工作原理

- 本包只注册工具（参数 schema / 校验 / 结果信封，移植自 `@juicesharp/rpiv-ask-user-question`
  的纯逻辑层；其终端 TUI 渲染层依赖 pi-tui，owl 已移除）。
- 问卷的 WebSocket 往返由桌面桥提供：桥启动时把 `broadcast` / 连接探针注入
  `core/question-channel.ts` 注册表（`setQuestionChannel`），本插件经
  `@owl/owl-coding-agent` 别名取用同一实例。桥外（print/-p 模式）通道缺位，
  插件在每轮 `before_agent_start` 把工具从模型工具列表摘掉。
- UI 侧渲染在 `apps/desktop/src/components/QuestionDialog.tsx`；工具在
  `owl-permissions` 中全模式放行（提问本身即用户交互，再套权限确认就循环了）。

## 安装

settings.json（全局或项目级）：

```json
{
  "plugins": ["D:/owl/owl-re-v1/owl-mono/packages/owl-ask-user"]
}
```

改完新会话生效；设置页「插件」分区可启停。
