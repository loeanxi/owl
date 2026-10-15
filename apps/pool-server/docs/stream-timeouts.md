# 上游流式超时配置

直连上游默认使用空闲期限和总时长上限。收到任何上游响应字节（包括 SSE 心跳）会重新开始计算空闲时间；持续输出超过 120 秒的请求可以继续，长时间推理不会被固定时长截断。连接尚未返回响应头时，同样受期限约束。非流式请求的响应体一次性到达，只受总时长上限约束。

| 环境变量 | 默认值 | 作用 |
| --- | ---: | --- |
| `OWL_POOL_WB_STREAM_IDLE_TIMEOUT_MS` | `120000` | WorkBuddy：连续未收到上游字节时中止等待，单位毫秒。 |
| `OWL_POOL_WB_STREAM_MAX_DURATION_MS` | `600000` | WorkBuddy：单次流的总时长上限，单位毫秒；心跳不会延长此上限。 |
| `OWL_POOL_GATEWAY_STREAM_IDLE_TIMEOUT_MS` | `120000` | Trae、ZCode、Claude、Gemini、Grok：连续未收到上游字节时中止等待，单位毫秒。 |
| `OWL_POOL_GATEWAY_STREAM_MAX_DURATION_MS` | `1800000` | Trae、ZCode、Claude、Gemini、Grok：单次请求的总时长上限，单位毫秒。 |
| `OWL_POOL_GATEWAY_UPSTREAM_TIMEOUT_MS` | 未显式设置 | 如果显式设置，作为上述所有直连上游的绝对总期限，优先于总时长上限。 |

配置在 pool-server 启动时读取，修改后需要重新启动服务。空闲期限与总期限都会生效；显式绝对期限不会因持续输出而自动延长。

客户端取消会传递给上游请求。超时、连接中断或取消发生在派发之后且无法确认最终用量时，预占进入 `REVIEW`，需要核对上游费用；不会因为客户端显示零用量而自动退款。确认未建立连接的临时失败仍可按已有路由规则重试。

流已经输出部分内容后发生错误时，网关会发送标准 SSE 错误帧，并保留错误原因和请求 ID，然后关闭流。上游流缺少结束标记或连接被对端关闭时，错误代码为 `upstream_stream_interrupted`，不会被归为网关内部错误，也不会被伪装成正常完成。

OpenAI Chat Completions 的受控超时、流中断错误会携带 `billing_state: "unknown"` 和明确错误代码。Owl 默认停止这些错误的请求级和任务级自动重试；用户明确配置的重试字符串、上游明确的 `x-should-retry` 指令仍保留原有覆盖语义。Anthropic 和 Responses 当前仅保证错误原因传播，尚未提供相同的未知费用重试标记。
