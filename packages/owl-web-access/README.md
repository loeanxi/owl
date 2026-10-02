# owl-web-access

Owl coding agent 的网页访问插件：**网页搜索、URL 抓取（HTML→Markdown）、GitHub 仓库/issue/PR 读取、本地 PDF 提取**。

移植自 [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access)（MIT），按 owl 插件规范改造：manifest 键 `owl`、类型取自 `@owl/owl-coding-agent`、配置目录跟随 `OWL_CODING_AGENT_DIR`。

## 工具

| 工具 | 功能 |
|---|---|
| `web_search` | 多后端网页搜索，支持多角度并发查询、域名/时间过滤、摘要工作流 |
| `source_check` | 为一个断言收集来源，产出带引用的研究工件 |
| `fetch_content` | 抓取 URL 转 Markdown；GitHub 仓库/issue/PR；本地 PDF；RSC 页面 |
| `get_search_content` | 按 responseId 取回已存储的搜索/抓取全文（分页/查找，省 token） |
| `web_enable` | 按能力动态开启上述工具 |

命令：`/websearch`、`/search`。

## 搜索后端

**免 key 即用**：`duckduckgo`（默认）。

**填环境变量即用**（或在配置文件里给对应 `xxxApiKey` 字段）：
`searxng`（`SEARXNG_BASE_URL`）、`brave`（`BRAVE_API_KEY`）、`tavily`（`TAVILY_API_KEY`，支持 `_1..N` 池）、`exa`（`EXA_API_KEY`）、`perplexity`（`PERPLEXITY_API_KEY`）、`jina`（`JINA_API_KEY`）、`firecrawl`、`kagi`、`you`、`xai`、`mistral`、`kimi`、`ollama`、`serpapi/serpbase/serpdive/serper/serply`、`search1api`、`searchinfinity`、`querit`、`tinyfish`、`valyu`、`xcrawl`、`anysearch`、`baizhi`、`bocha`、`brightdata`、`crawl4ai`、`zai`。

## 配置

配置文件：`<agentDir>/web-search.json`（`agentDir` = `OWL_CODING_AGENT_DIR`，默认 `~/.owl/agent`）。缓存写在 `<agentDir>/web-search-cache/`。

```json
{
  "searchProvider": "auto",
  "braveApiKey": "…",
  "workflow": "summary-review",
  "ssrf": { "allowPrivateAddresses": false }
}
```

## 构建

```bash
npm run build     # esbuild 单文件 → dist/index.js（宿主 SDK 为 external，运行时零 node_modules 依赖）
npm run typecheck
```

## 接入 owl

settings.json 的 `plugins` 加本地路径即可：

```json
{ "plugins": ["D:\\owl\\owl-re-v1\\owl-mono\\packages\\owl-web-access"] }
```

## 与上游的差异（移植裁剪）

剔除：curator 浏览器界面、YouTube/视频理解、gemini-web 浏览器 cookie 免 key、OpenAI 内置搜索、parallel/parallel-mcp、auth-fetch 登录页抓取、pi-tui 界面依赖。保留了全部纯 fetch 后端适配器与核心管线（SSRF 防护、抽取、存储分页、摘要工作流）。

## License

MIT（上游 pi-web-access © Nico Bailon，见 LICENSE）。
