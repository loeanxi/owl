# owl-context

owl 的上下文洞察插件：让「当前上下文里到底装了什么、token 花在哪、何时被压缩」变得透明。

## 做什么

- **采集**：在每次 LLM 请求组装点（扩展事件 `context_with_system`）现采当次请求的七类构成估算——
  系统提示词 / 工具定义 / 用户消息 / 注入内容（含命名 sections，如 owl-memory）/ 助手消息 / 工具结果 / 其他，
  并按「轮 / 步」编号、保留转录快照（每个压缩纪元一份，按消息数取前缀），供逐步回看与下钻。
  流式事件（`message_update` / `message_end`）记录首字延迟、思考 / 回复 / 工具参数耗时与回复简报；
  `tool_execution_*` 记录工具执行耗时与文件活动（读 / 写 / 搜索 / 图片，edit/write 估算增删行）；
  `session_compact`、模型切换、思考档位切换与注入变化记为上下文事件。
  数据写入 `core/context-insight` 注册表，不解析会话日志、不落盘；历史会话按转录回放重建（无耗时数据）。
- **呈现**：桌面端对话区「上下文」标签页，版式对齐 dsh-context 的会话内 Context 标签：
  上下文统计、会话信息、Token 统计、耗时统计、当前上下文、上下文趋势（步骤 / 轮次、全量 / 增量、耗时曲线、
  压缩 ✂ 标记、步骤简报）、上下文浏览器（逐步重建、对比上一步、下钻原文 / 工具定义 / 调用参数）、
  上下文事件（注入 / 压缩 / 剪枝 / 切换 / 模式过滤）与文件活动。
- **口径**：token 估算与 owl 内部一致（chars/4 启发式、图片按 4800 字符折算）；
  工具取最终 transcript 声明，包含 model-only、codemode、动态加载与增强后的描述，注册表仅标注来源。
  provider 用量（usage.input/cacheRead/cacheWrite/output）在响应结束时回填到本次请求；
  本次输入总量包含缓存读写，构成估算与上游用量分别展示。对话底部另显示整轮累计及调用次数。
  历史回放会恢复转录已保存的工具声明；旧转录未保存声明时不能补算。

## 启用

`settings.json` 的 `plugins` 加本地路径：

```json
{
  "plugins": ["D:\\owl\\owl-re-v1\\owl-mono\\packages\\owl-context"]
}
```

纯单文件扩展（jiti 直载 `index.ts`），无构建步骤。桥端改动（`context.get` / `context.detail` / `context.item`）需要重启桥生效。

## 来源

分类模型与「上下文透明化」的产品思路参考 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)
（Apache-2.0，面向 DeepSeek Harness）。实现为按 owl/pi 扩展 API 的全新代码：
dsh-context 从会话日志折叠出历史，本插件在请求组装点直接现采；UI 为 owl 桌面端第一方卡片。
