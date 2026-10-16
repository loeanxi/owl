# Owl Computer Use

Windows 应用操作插件。主模型使用三个工具完成「定位或打开应用 → 观察 → 单次动作 → 结果回读」，宿主负责窗口绑定、桌面控制权、快照失效、取消与资源清理。默认 `inputMode: "auto"`：有等价 UIA 控件操作就后台执行，否则在用户输入静默时选择前台、恢复并聚焦目标。模型也可以明确指定前台或后台。

## 模型工具

| 工具 | 用途 | 权限 |
|---|---|---|
| `computer_observe` | 列窗口、选择应用、读取 UIA 控件及按需窗口图片 | Plan/Confirm 可直接观察 |
| `computer_act` | 消费当前观察令牌，执行一个明确动作并重新观察 | Plan 拦截，Confirm 审批，Auto 执行校验 |
| `computer_release` | 结束本轮桌面控制并释放自己的驱动资源 | 允许清理，不关闭用户应用 |

工具为 `model-only`，按需发现后直接调用。不能在 `codemode` 中嵌套调用，窗口图片以原生 image block 直接进入主模型上下文。

桌面操作使用「标准模式」或其它包含这组工具的预设。用户明确点名的已注册工具会优先预加载，不依赖长段任务描述的语义分类。「极简模式」和 Pi 等受限预设保留自己的工具范围；缺少桌面操作能力时，在请求入口直接说明限制，不把实际桌面任务转成终端源码调查。已有消息的会话保留原预设，需要其它能力时创建相应预设的新会话。

```js
computer_observe({ windowQuery: "notepad" }) // 按标题或进程定位目标
computer_observe({})                        // 枚举窗口并观察前台应用
computer_observe({ windowId: "w2" })         // 多个匹配时选择枚举中的窗口
// 目标不存在时，使用返回的发现令牌打开应用，然后观察实际目标。
computer_act({ observationId: "<发现令牌>", action: "open_app", app: "notepad.exe" })
computer_act({
  observationId: "<当前观察返回的 id>",
  action: "set_value",
  inputMode: "auto",
  elementId: "<当前观察返回的控件 id>",
  text: "报告.txt"
})
computer_release({})
```

自动模式会把有 Invoke / SelectionItem / Toggle 的普通左键单击匹配到对应语义动作，再在副作用前检查实际 backend：经过验证的非激活实现才能后台执行，其余提供方使用受用户空闲和前台互斥保护的路径。仅有 UIA pattern 不代表提供方不会抢焦点。`type` 默认保持插入语义；只有明确 `replace: true` 才允许使用 Value 替换整个字段。显式 `background` 对没有已验证非激活实现的动作在执行前返回 `background_backend_unavailable`，不能以此投递真实键鼠。

需要真实 `click`、`type`、`key`、`scroll`、`focus`、`restore` 时，自动模式检查桌面输入静默、目标身份和互斥后切换前台。用户正使用键鼠时返回可恢复的 `user_busy`，模型按 `retryAfterMs` 等待、重新观察后再决定；不会把普通活动锁成永久停止。坐标 click/scroll 要求当前模型支持图片，并且该观察实际交付过窗口截图；坐标为该截图中的像素，不是屏幕绝对坐标。缺参数返回可复制的 JSON 模板。

`windowQuery` 只有唯一匹配才绑定窗口，多个匹配必须选择 `windowId`。没有目标时返回发现令牌与 `open_app` 下一步；它只授权打开应用，不能授权对任意窗口输入。`open_app` 接受普通 EXE 名、现存的绝对 EXE 路径或 Windows AUMID，不接受命令参数、脚本、文档或 URL。注册工具名查询也支持一次加载 `computer_observe computer_act computer_release`。

动作结果报告 `requestedMode`、`executedMode`、`executedAction`、`fallbackReason`、`retryable` 和 `nextAction`，模型能据此调整下一步。临时冲突可恢复；已经执行了一部分或结果未知时先回读实际状态，不能自动重发。

观察的非密码控件提供 `value` / `text`、`isReadOnly` 和 `truncated`，正文最多 4096 字符，纯文本模型也能核对输入；密码控件不会读取或输出正文。标准 Win32 编辑框、按钮及经过校验的 WinForms 控件会在动作前选择无需激活的控件消息路径，执行后仍通过 UIA 回读。没有已证等价路径的提供方保留 UIA 路径；执行结果未知时不会改用另一种方式重放。

现代 Windows 记事本仅对严格匹配的 `Notepad` / `Document` / `RichEditD2DPT` 文本编辑器启用已验证的非激活全值替换；新建标签页、标签选择及其它未验证的 UIA 操作仍遵守前台空闲与聚焦条件。

浏览器、文件、文档、表格已有专用工具时先使用它们；原生窗口和系统对话框使用本插件。纯文本模型可以使用可读的 UIA 控件，不能猜坐标。

## 系统级控制提示

原生驱动在真实取得本次控制条件后显示独立桌面提示，主窗口失焦或最小化不影响它：

- 顶部显示「Owl 正在控制你的电脑」，并说明前台键鼠或后台控件模式；目标边缘显示青蓝色标记。
- 只读观察、用户忙、窗口校验失败不会点亮正在控制状态；本次动作释放后撤下提示。
- 「停止」先锁止原生输入，再经绑定的 worker、请求和宿主 run 停止所属任务；旧提示的迟到消息不能取消新任务或其它会话。
- 提示和边缘窗口不抢焦点；坐标输入前会把遮挡该点的胶囊挪开。截图、窗口发现和命中判断识别 Owl 自己注册的提示句柄，不按窗口标题过滤。
- 释放、取消、超时、会话结束、原生 worker 退出时清理提示。停止过程中显示撤销状态，不能提前宣称全部输入均未发生。

提示层使用本包自己的 Windows 控制内核，不依赖主窗口 WebView 的刷新，也不需要 Codex 的私有控制服务。

## 执行契约

- 每份观察绑定宿主会话/任务、窗口 PID 与启动身份、窗口几何、用户输入修订和原生 worker；令牌单次消费，默认 120 秒有效，重启或窗口状态变化后失效。
- Node 真正等待上一条请求完成后才下发下一条，排队、启动和执行各自计时。
- 后台控件操作按目标窗口互斥；前台真实输入使用桌面级 Windows mutex，释放或进程退出后移交。
- UIA 元素引用只在对应观察中有效，执行前重新验证身份、位置与可用 pattern。密码控件不暴露值，也不接受本插件的控件写操作。
- 用户在其它窗口的输入不影响后台 UIA。目标窗口的实际编辑、点击或投影输入会使旧观察失效；普通输入冲突只要求重新观察，不会误报宿主任务结束。显式取消、物理停止和宿主会话收口仍停止本轮；已经发生的动作不会回滚。
- 即使本轮已停止或信号已取消，`computer_release` 仍能清理当前会话自己的资源。旧任务的异步清理不会关闭新任务的驱动。
- 排队取消不下发；已发送动作取消或超时会停止 worker 并清空后续队列，结果按未知/部分执行处理，不自动重放。资源清理不会拉起新 worker。
- 快捷键使用包含按下和释放的一批 SendInput；长文本检查目标与干预状态。Windows 的验证与输入之间仍存在短竞态，不能保证任意应用上的原子操作。

| 状态 | 含义 |
|---|---|
| `confirmed` | 原生层验证了该动作的特定结果，如字段回读相等 |
| `issued` | 已投递输入/Invoke，不代表业务任务完成 |
| `blocked` | 前置条件不成立，要求重新观察或交接 |
| `partial` | 部分输入已经发生，需观察实际状态 |
| `unknown` | 超时、取消或提供方异常，不能推断成功或盲目重试 |

## 原生实现

```text
Owl 当前模型 → model-only 工具 → ComputerUseRuntime
  → ComputerDriverSession（串行 JSON 行、ready、取消、worker generation）
  → computer-driver.ps1（一次性观察、Windows mutex、目标验证）
      ├─ computer-uia.cs（独立进程、8 秒超时、Job Object 清理）
      ├─ Owl 现有 mirror/windows-capture.cs（WGC 新帧，按模型尺寸缩放）
      └─ computer-kernel.cs（GDI 兜底、DPI/多屏、标记输入和 SendInput）
          └─ computer-control-overlay.cs（独立 STA 控制提示、透点边缘和定向停止）
```

WGC 仅复用捕获内核，不复用短剧投影的窗口布局或输入接口。WGC 不可用时，仅允许未遮挡、未最小化窗口的 GDI 裁剪；条件不满足返回无图片及诊断，不会用其他窗口的画面代替。观察不会聚焦、恢复或移动窗口。

后台窗口捕获不等于后台键鼠投递。真实键鼠操作要求目标前台正确，会占用同一交互桌面的输入；UIA 的覆盖范围取决于应用提供的控件。要让任意软件的坐标点击和键盘也完全独立，需要单独的虚拟机或交互会话，本插件没有实现这种环境隔离。UIPI/安全桌面限制没有提权兜底。

## 配置

```json
"owlComputerUse": { "enabled": true, "maxImageWidth": 1568 }
```

Windows-only。关闭插件后不注册工具。首次调用惰性编译 C# 缓存并启动隐藏 PowerShell worker，空闲 60 秒停止；会话最终结束、切换和关闭也会释放。不依赖 Codex 的私有 helper、Swift 引擎或管道服务。

## 验证

在本包目录运行目标协议/工具测试：

```powershell
node ../../node_modules/vitest/dist/cli.js --run test/session.test.ts test/runtime-v2.test.ts test/lifecycle.test.ts
```

真实原生测试只创建并操作自己的临时 WinForms 窗口，finally 关闭窗口和 worker，并清理自己的临时目录。前台键鼠回归需要短时间输入静默；后台控件回归验证其它窗口输入不会中止目标操作，不能用关闭保护代替并用验收。

```powershell
node scripts/native-self-test.mjs --scope-unit
node scripts/native-self-test.mjs --background
# 控制提示、真实按钮停止、前台保持和截图证明；只操作自己的后台测试窗
node scripts/native-self-test.mjs --overlay
# 自动选择后台动作、前台回退、用户忙后恢复和打开缺失应用
node scripts/native-self-test.mjs --auto
# 完整前台回归需要短时间输入静默
node scripts/native-self-test.mjs
# 原 smoke 入口也执行这份有结果断言的测试
node scripts/smoke.mjs
```

后台回归覆盖四种 UIA 动作的独立回读、原前台保持、不同窗口控制并用、同目标编辑拒绝、鼠标路过可继续，以及禁止后台隐式键鼠输入。完整前台脚本另覆盖中文回读、一次性令牌、真实 focus/click/Ctrl+A/Unicode 输入和窗口捕获；它需要独占的短测试窗口，不能把后台检查通过等同于前台全链重新实测通过。

源码与本地测试通过后，须刷新实际运行的插件；桥或界面源码变化还需要构建并重启相应层。真实模型记事本验收、独立回读与并用监测证据保存在 `.validation/computer-control/` 各轮报告中，按报告的实际结果判定。

输入证据分为作用域计数模拟、受控 `Win32.SendInput` 和独立观察到的人工物理输入。`_test_input` 与 reflection 只能证明分类逻辑，不能算人工并用；并用验收另外核对独立前台时间线、真实低级 hook、输入来源、目标回读和用户窗口无误投递。单个应用通过不代表任意 UIA 提供方都能后台执行。
