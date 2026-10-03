# owl-context

owl 的上下文洞察插件：让「当前上下文里到底装了什么、token 花在哪、何时被压缩」变得透明。

## 做什么

- **采集**：在每次 LLM 请求组装点（扩展事件 `context_with_system`）现采当次请求的六类构成估算——
  系统提示 / 注入内容（含命名 sections，如 owl-memory）/ 用户消息 / 模型回复 / 工具结果 / 工具 schema，
  外加压缩事件（`session_compact`）。数据写入 `core/context-insight` 注册表，不解析会话日志、不落盘。
- **呈现**：owl 桌面端侧边工作台新增「上下文」卡片（`context` tab）：
  当前构成堆叠条、每请求趋势（压缩分界线标记）、上下文事件流、声明工具的来源分组。
- **口径**：token 估算与 owl 内部一致（chars/4 启发式、图片按 4800 字符折算）；
  provider 计费数字（usage.input/cacheRead/cacheWrite/output）在下一轮请求时补填到上一行，估算与计费两列并存。

## 启用

`settings.json` 的 `plugins` 加本地路径：

```json
{
  "plugins": ["D:\\owl\\owl-re-v1\\owl-mono\\packages\\owl-context"]
}
```

纯单文件扩展（jiti 直载 `index.ts`），无构建步骤。桥端改动（`context.get`）需要重启桥生效。

## 来源

分类模型与「上下文透明化」的产品思路参考 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)
（Apache-2.0，面向 DeepSeek Harness）。实现为按 owl/pi 扩展 API 的全新代码：
dsh-context 从会话日志折叠出历史，本插件在请求组装点直接现采；UI 为 owl 桌面端第一方卡片。
