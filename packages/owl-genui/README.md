# owl-genui

owl 桌面端的内联 GenUI 插件——移植自 [dsh-genui](https://github.com/omdsh-dev/dsh-genui)（MIT）。
模型在回复中输出 ` ```owl-ui ` JSON 围栏（或调用 `render_ui` 工具），桌面聊天界面把它渲染成
真实可交互的 React 组件：统计卡、表格、图表（ECharts/plot）、表单、测验、mermaid、3D 场景、
架构图等 47 种组件，用户交互再回传给模型形成闭环。

## 工作方式

```
模型回复 ──```owl-ui 围栏──▶ ChatStream 分段渲染 GenuiBlock（answer 内联）
        └─render_ui 工具──▶ 工具行交互卡片（details.genuiSpec）
用户交互 ──[owl-ui-action]──▶ 桥 owl-ui.action ──▶ session.prompt ──▶ 模型重发更新后的围栏
```

- **node half**（`index.ts` + `src/plugin/`）：owl 扩展，`before_agent_start` 注入系统提示章节、
  注册 `render_ui` 工具、把 `SKILL.md` 同步到 `<agentDir>/skills/owl-genui/`。
- **client**（`client/`）：React 渲染器（apps/desktop 经相对路径引入，vite 自动把
  echarts/mermaid/three 拆成异步 chunk 按需加载）。
- **guard**（`client/guard.ts`）：唯一校验/修复权威——白名单、限额（≤200 节点/8 层嵌套）、
  字段别名归一、确定性修复；两级 JSON 修复（`client/shared/`）。
- **本地优先**：判卷/判题/筛选/排序/重置全部在本地完成，只有带 `action` 的交互才回传模型；
  交互状态按「会话+内容指纹」持久化到 localStorage（密码字段永不持久化）。

## 注册

settings.json 的 `plugins` 加入 `packages/owl-genui` 路径即可（当前已注册）。会话没有本插件时
模型不会输出围栏，一切照旧。

## 验证

```bash
npx vitest run            # 253 个单测（guard/修复/部分解析/schema/SKILL 示例一致性）
npx tsc --noEmit          # 包级类型检查
node scripts/smoke.mjs    # node half 冒烟：jiti 加载 + 工具注册 + 章节注入 + SKILL 同步
```

## 与 dsh 原版的差异

- 单渲染通道（受控 React 渲染），无需 dsh 的 DOM 观察通道；
- panel 会话面板、成就系统、画廊/模板、artifact 离线导出、fence-feedback 围栏自修、
  `validate_dsh_ui` 工具未移植（二期候选）；
- 宿主 UI 原语（CodeBlock/DiffBlock/JsonTree/剪贴板）换成本地实现（`client/primitive-adapter.ts`）；
- 设计令牌映射到 owl 主题（`client/genui-tokens.css`），深浅色随 `html[data-owl-theme]` 翻转。
