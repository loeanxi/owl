# owl-computer-use

把 Windows 桌面暴露给视觉模型的 computer use 工具面：模型**先截图、再操作、
再截图确认**，全程用真实键鼠输入。

## 工具面

| 工具 | 作用 | 只读 |
|---|---|---|
| `computer_screenshot` | 截屏（主显器 / 虚拟屏 / 指定显示器），≤`maxImageWidth` 宽的 JPEG | ✅ |
| `computer_click` | 按最近截图的像素坐标点击（左/右/中键、双击） | ❌ |
| `computer_type` | 向前台窗口键入 Unicode 文本（`\n` = 回车） | ❌ |
| `computer_key` | 单键/组合键（`ctrl+s`、`alt+tab`、`win`…） | ❌ |
| `computer_scroll` | 在指定坐标滚动（上/下/左/右） | ❌ |
| `computer_windows` | 枚举 / 聚焦 / 恢复窗口 | list ✅ |

## 自纠错反馈

- `computer_click` 返回**实际点中的窗口**（WindowFromPoint）；打偏时模型能立刻发现。
- `computer_type` / `computer_key` 返回**键入时的前台窗口**；焦点被抢时模型能发现。
- `computer_windows focus` 是验证式聚焦（实测 `GetForegroundWindow`，重试 3 次）。
- 坐标换算由会话层完成：截图像素空间 → 虚拟屏幕坐标（多显示器含负坐标）。

## expectHwnd 预检（防点偏 / 防误触）

截图与操作之间 z-order 可能变化（通知 toast 抢前台、窗口弹出到顶层），坐标
算得再准也会点到别的窗口。四个动作工具都有可选的 **`expectHwnd`** 参数：

- `computer_click` / `computer_scroll`：注入前用 WindowFromPoint 查目标点上
  是不是预期窗口，不是则**一个键都不碰**，返回 `{blocked: true}` 与实际窗口；
- `computer_type` / `computer_key`：注入前查前台窗口，不是预期窗口则拒打
  （乱键会触发别的应用的快捷键，比点偏更危险）。

用法：`computer_windows` 列表拿 hwnd，或复用上一次 click 返回的
`clickedWindow.hwnd`，目标窗口已知时**始终带上** `expectHwnd`。

## 架构

```
ToolDefinition ×6 ── ComputerDriverSession（Node，JSON 行协议 + 崩溃重建 + 空闲自停）
                        └─ computer-driver.ps1（长驻 PowerShell 侧车）
                             ├─ computer-kernel.cs（进程外 csc 编译缓存 %TEMP%）
                             │    GDI BitBlt 截屏 + user32 SendInput 输入注入
                             └─ WindowTools（user32：枚举 / 聚焦 / 命中检测）
```

## 配置（settings.json）

```json
"owlComputerUse": { "enabled": true, "maxImageWidth": 1568 }
```

`enabled: false` 时不注册任何工具。worker 惰性启动（首次工具调用才拉起
PowerShell），空闲 60s 自停；首次调用含 csc 编译约需数秒。

## 安全边界

- 非只读工具全部 `readOnlyHint: false`，落入桌面端 approvalMode 门控
  （plan 拦截 / confirm 弹审批 / auto 放行）。
- `win+l`、`ctrl+alt+del` 在工具层硬拒。
- 提权窗口（UIPI）会静默丢弃注入的输入，属系统限制，本期不做提权侧车。
- 多显示器坐标为虚拟屏幕坐标系（主显器左上角为原点，副显器可为负）。

## 开发

```bash
pnpm vitest run        # 协议层单测（伪 worker）
pnpm tsx scripts/smoke.mjs   # 真实驱动端到端（会开记事本打字，只碰自己开的窗口）
```
