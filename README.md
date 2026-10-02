# owl

一个桌面优先的编码 agent。本仓库在 [pi](https://github.com/badlogic/pi-mono)（pi-mono，MIT 协议，
原作者 Mario Zechner / earendil-works）的基础上改造而来，去掉了 TUI 终端界面，改为以桌面应用
作为主要入口。

## 桌面版 owl

改造的核心产物是 `apps/desktop` 下的桌面客户端，代号 **owl**：

- **桥服务器**（`packages/coding-agent/src/modes/desktop/`）：一个 JSON/WS 服务，把 agent 会话、
  模型切换、设置读写、权限确认暴露成 WebSocket 协议，并直接托管构建好的前端 UI，单端口访问。
- **前端 UI**（`apps/desktop/src/`）：React 实现的聊天界面，含会话侧栏、消息流、输入区、
  模型切换器、权限确认弹窗和设置页。
- **Tauri 壳**（`apps/desktop/src-tauri/`）：一键启动的 Windows 桌面程序，拉起桥进程并指向单端口 UI。

协议定义在 `packages/coding-agent/src/modes/desktop/protocol.ts`，UI 侧
`apps/desktop/src/bridge/protocol.ts` 以 type-only 方式引用同一份定义，两端不重复维护类型。

### 本地开发

改造版的运行时数据与已安装版 pi 完全隔离，只需要一个环境变量：

| 环境变量 | 作用 |
|---|---|
| `OWL_CODING_AGENT_DIR` | 配置根目录：settings / auth / models / 扩展 / 技能 / 提示词 / 主题 / 会话 / 扩展包 |

会话和 `pi install` 的扩展包都在它下面（`sessions\<编码cwd>\`、`npm\`），
所以设了这一个变量就等于整体搬走，与 `~/.owl/agent` 零交集。

刻意**不设**的两个变量：

- `OWL_CODING_AGENT_SESSION_DIR` — 覆盖后变平铺布局，而 `SessionManager.listAll()`
  只遍历 `getSessionsDir()` 的子目录，桌面端 `session.list` 会扫不到任何会话。
- `OWL_PACKAGE_DIR` — 它覆盖的是 **pi 自身的安装目录**（Nix/Guix store 路径用），
  不是扩展包目录。上游文档在此处有误，`config.ts:390` 的实现为准。

仓库外的 `pi-re-v1/owl-dev.cmd`（Windows）与 `owl-dev.sh`（Git Bash）会预设该变量后启动改造版，
详见 `pi-re-v1/DEV-README.md`。

```bash
# 启动桥 + 内置 UI（单端口）
node packages/coding-agent/dist/modes/desktop/serve.js --port 18901

# 前端热更新开发
cd apps/desktop && npm run dev
```

## 仓库结构

| 包 | 说明 |
|---|---|
| [packages/ai](packages/ai) | 多厂商 LLM 统一 API（OpenAI、Anthropic、Google 等） |
| [packages/agent](packages/agent) | agent 运行时，负责工具调用与状态管理 |
| [packages/coding-agent](packages/coding-agent) | agent 主体，含 CLI 与桌面桥服务器 |
| [packages/codemode](packages/codemode) | 代码模式运行时 |
| [packages/tui](packages/tui) | 终端 UI 库（桌面版改造中已不再使用） |

这些包的 npm 作用域仍沿用上游的 `@earendil-works/*`，因为包名在源码导入和构建配置中被广泛引用，
改动会牵连整个构建链。改造只发生在行为和入口层面，不动包标识。

## 开发

```bash
npm install --ignore-scripts  # 安装依赖
npm run build                 # 全量构建
npm run check                 # lint + 类型检查
./test.sh                     # 跑测试
```

日常只改了 `coding-agent` 时可以局部重建：

```bash
cd packages/coding-agent && npm run build
```

## 权限与容器化

本项目不内置文件系统、进程、网络或凭据访问的权限边界，默认以启动它的用户权限运行。
需要更强隔离时，请自行容器化或沙箱化，参考
[packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md)。

桌面版的权限确认（`approvalMode: "confirm"`）是交互式的逐次授权，与上述操作系统级隔离是两回事。

## 致谢与许可

本项目基于 [pi-mono](https://github.com/badlogic/pi-mono) 改造，原作者为 Mario Zechner，
版权归其所有，按 MIT 协议发布。`LICENSE` 中的版权声明予以完整保留。

MIT 协议允许自由使用、修改和分发，包括闭源商用，条件是保留版权声明与许可声明。
`CHANGELOG` 中指向上游 issue / PR 的链接作为历史记录一并保留。
