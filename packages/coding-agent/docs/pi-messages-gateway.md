# pi-messages Gateway

`pi-messages` is an API type for a self-hosted gateway. The request is a single POST of `{ model, context, options }` to `<baseUrl>/messages`; the response is an SSE stream of serialized assistant-message events followed by a terminal `done` or `error` event.

Use it when one gateway fronts several upstreams — Anthropic-compatible relays, OpenAI, Azure, Codex, or domestic models — and wants to hand Pi a single uniform stream.

Configure it in [`models.json`](configuration.md#agent-directory):

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://gw.example.com",
      "api": "pi-messages",
      "apiKey": "$MY_GATEWAY_KEY",
      "models": [{ "id": "claude-sonnet-4" }]
    }
  }
}
```

## Request

`POST <baseUrl>/messages`

| Header | Value |
| --- | --- |
| `authorization` | `Bearer <apiKey>` |
| `accept` | `text/event-stream` |
| `content-type` | `application/json` |

Body:

```json
{
  "model": "claude-sonnet-4",
  "context": {
    "messages": [
      { "role": "system", "content": [{ "type": "text", "text": "…" }] },
      { "role": "user", "content": [{ "type": "text", "text": "…" }] }
    ]
  },
  "options": {
    "temperature": 0.7,
    "maxTokens": 4096,
    "reasoning": "medium",
    "sessionId": "…"
  }
}
```

`context` is a normalized transcript: `messages` is the full conversation, and the system prompt travels as a system message inside it. `options.reasoning` is one of `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `options.toolChoice` is `auto`, `none`, `required`, or `{ "type": "function", "function": { "name": "…" } }`.

## Response

Every SSE frame carries one JSON object on a `data:` line. Frames are separated by a blank line.

| Event | Fields | Notes |
| --- | --- | --- |
| `start` | — | Optional. |
| `text_start` | `contentIndex`, `citations?` | Opens a text block. |
| `text_delta` | `contentIndex`, `delta` | Appends to the text block. |
| `text_end` | `contentIndex`, `content`, `contentSignature?`, `citations?` | Closes the text block. |
| `thinking_start` | `contentIndex`, `summaries?` | Opens a thinking block. |
| `thinking_delta` | `contentIndex`, `delta` | Appends raw thinking text. |
| `thinking_end` | `contentIndex`, `content`, `contentSignature?`, `redacted?`, `summaries?` | Closes the thinking block. |
| `toolcall_start` | `contentIndex`, `id`, `toolName` | Opens a tool call. |
| `toolcall_delta` | `contentIndex`, `delta` | JSON fragments of the arguments. |
| `toolcall_end` | `contentIndex`, `toolCall` | Complete `{ id, name, arguments }`. |
| `done` | `reason`, `usage`, `responseId?`, `providerThinkingLevel?` | Terminal. `reason` is `stop`, `length`, or `toolUse`. |
| `error` | `reason`, `usage`, `errorMessage?` | Terminal. `reason` is `aborted` or `error`. |

`contentIndex` is the position of the block inside the assistant message. Text, thinking, and tool calls each take their own index.

`usage` is `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`.

A stream must end with exactly one `done` or `error` event. A stream that ends without one is treated as a failure.

## Reasoning summaries

Claude Desktop never displays a model's raw thinking text. It displays the provider's reasoning **summary**, and uses the raw text only to derive a fallback heading. Reproducing that presentation requires the gateway to forward the summary.

Add `summaries` — an array of plain strings — to `thinking_start` and/or `thinking_end`:

```
data: {"type":"thinking_start","contentIndex":0,"summaries":["First locate the login route."]}

data: {"type":"thinking_delta","contentIndex":0,"delta":"…"}

data: {"type":"thinking_end","contentIndex":0,"content":"…","summaries":["First locate the login route.","Then check the auth guard."]}
```

Rules:

- `summaries` is an array of **strings**. Anthropic's own wire format uses `[{ "type": "summary", "text": "…" }]` — flatten it to `["…"]` at the gateway.
- `thinking_end.summaries` wins when both events carry it. `thinking_start.summaries` is used when `thinking_end` omits it.
- The **last** entry becomes the heading. Every entry is rendered as body text.
- A single summary and no raw thinking hides the whole block — one line is not worth screen space.
- With no summary at all, the heading falls back to the **first line** of the raw thinking text, and no raw thinking is displayed. This is the same degradation Claude applies to providers without summary support, so it is the correct behavior for DeepSeek-style upstreams.

Where the summary comes from depends on the upstream:

| Upstream | Where the summary lives |
| --- | --- |
| Anthropic (`/v1/messages`) | The `thinking` content block's `summary` array. |
| OpenAI Responses | `response.reasoning_summary_part.done` events, field `part.text`. |
| OpenAI Chat Completions | None. Use the first-line fallback. |
| Models without a summary channel | None. Use the first-line fallback. |

Flattening an Anthropic summary block:

```ts
function toPiSummary(summary: unknown): string[] {
	if (!Array.isArray(summary)) return [];
	return summary
		.map((item) => {
			if (typeof item === "string") return item;
			if (item !== null && typeof item === "object" && "text" in item) {
				const text = (item as { text?: unknown }).text;
				return typeof text === "string" ? text : "";
			}
			return "";
		})
		.filter((text) => text.trim() !== "");
}
```

## Citations

A gateway can forward citations so the answer shows inline markers and a
sources panel, the way Claude Desktop does. `citations` is an array of
objects:

```json
{
  "type": "text_end",
  "contentIndex": 0,
  "content": "…",
  "citations": [
    { "title": "Example Domain", "url": "https://example.com/page", "source": "url_citation", "endIndex": 42 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `title` | Source title (page title or document name). |
| `url` | Source address. A document citation has none. |
| `snippet` | The quoted passage. |
| `startIndex` / `endIndex` | Character offsets **into the text of this block**. |
| `source` | Provider's own citation type. |

Two rules matter:

- `endIndex` is only meaningful when `source` is `url_citation`. Anthropic's
  `char_location` offsets point into the **source document**, not into the
  answer, so the client must not use them as text anchors.
- A citation needs a `title` or a `url`; entries with neither are dropped.

## What the gateway does not need to do

Tool-row titles and tool-group headings are produced inside the agent, not by the gateway. Each tool call carries an optional `title` argument that the model writes, and the group heading is a separate tool-free model call after the batch finishes. A gateway only forwards tool calls as they are.

## Failure handling

- A non-2xx response ends the stream with an error. The body is read and reported as the error message.
- A missing `authorization` header ends the stream with an error before generation starts.
- `error` events carry `errorMessage` for display in the conversation.
