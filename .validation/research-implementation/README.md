# 研究模式隔离 UI 验证

真实 `App.tsx`、`ChatStream`、`Composer`、`BridgeClient` 和 Tailwind；服务端为本地模拟边界。没有真实模型调用，不读取用户凭据、模型配置、已有会话，不驱动浏览器。

在项目根目录执行：

```powershell
node .validation/research-implementation/server.mjs --port 19089
```

首次启动会用本仓库已有 esbuild / Tailwind 编译实际桌面入口到本目录 `public/`，记录相关源文件 SHA256。它不是生产构建。打开 `http://127.0.0.1:19089/`，使用 CUA 操作真实页面。

服务从空会话历史开始。普通聊天和研究分别创建 session。研究对话发布 2 行表格、事实/未验证分类及本地来源链接；研究结果存入工具消息，浏览器刷新后 `session.resume` 返回同一份消息快照。停止按钮可用，在消息中包含“慢速”可让本地步骤间隔增加。服务进程退出后内存数据清空。

## 观察与场景控制

- `GET /test-state`：捕获全部 wire 请求、广播事件、会话消息/设置、待答问题/审批、未支持请求以及编译证据。
- `GET /test-source`：表格内容和来源展示使用的真实本地 HTML。
- `POST /test-action`：JSON `{ "action": "question", "sessionId": "..." }` 触发指定会话的 Agent 提问。
- `POST /test-action`：JSON `{ "action": "permission", "sessionId": "..." }` 触发工具审批。
- `POST /test-action`：JSON `{ "action": "iab", "sessionId": "..." }` 触发该会话来源的 IAB 页面广播，验证不同会话的旁栏路由。
- `POST /test-action`：JSON `{ "action": "clear-requests" }` 清空捕获日志，不清空会话。

不传 sessionId 时，可传 `scope: "main"` 选最新普通会话；默认选最新研究会话。控制接口只绑定 `127.0.0.1`。

建议检查：研究首发带 researchMode、普通聊天不带；结果与来源能展开；刷新研究恢复保持模式/结果；切换主聊天后研究提问/IAB 不误投；模型/思考/权限设置发给对应研究 session；研究停止和新对话不会重置普通聊天；模型测评入口仍可打开空题库。

```powershell
node --check .validation/research-implementation/build.mjs
node --check .validation/research-implementation/server.mjs
node .validation/research-implementation/build.mjs
```

此 harness 验证 UI 与协议联动，不能证明目标模型、浏览器采集、外部 MCP、真实持久化或付费 API 正常；这些需另外在隔离服务测试覆盖。

共享工作区的测评模块正在修改且不能编译时，可使用 `--isolate-evaluation` 启动或编译。本选项只在验证包内排除 `EvaluationPage`；研究页、主聊天、导航、Workbench 与 BridgeClient 仍来自真实源码。`build-evidence.json` 会记录排除范围。正式源码不受此选项影响，也不能把该验证当作测评模块的验收。
