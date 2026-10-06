# owl-life-guide

owl 的《高性价比人生指南》检索插件，给 agent 提供 `life_guide_search` 工具。

上游是 [eternity4719/HowToLiveBetter](https://github.com/eternity4719/HowToLiveBetter)（正文 CC BY 4.0）：34 章、约 665 条按证据等级（A/B/C）分生活建议，每条带成本标签、说人话摘要、收益、来源与备注。桌面端已有阅读面板（`apps/desktop/src/features/guide`）；本插件让 agent 在对话里能直接查同一份内容并引用条目作答。

## 工具：life_guide_search

| 参数 | 说明 |
| --- | --- |
| `query` | 关键词，空格分词、词间 AND，中文按子串匹配；标签词（如「收益大」）和章名也可命中 |
| `chapter` | 限定章号 1-34 |
| `grade` | `A` / `B` / `C` / `disputed`（上游争议标记） |
| `key` | `"章.条"`（如 `"1.6"`）精确取单条全文，忽略其余参数 |
| `full` | 展开成本/收益/来源/备注（来源超长会截断） |
| `limit` | 返回条数上限，默认 8，最大 30 |
| `refresh` | 跳过缓存强制从上游刷新 |

无参数调用返回全书概览（章目录 + 等级分布）。结果头部带命中数与本地快照日期；未命中时给出改写建议而不是空结果。

## 数据与缓存

- 抓取走 jsDelivr（`cdn.jsdelivr.net/gh/eternity4719/HowToLiveBetter@main/book/`），单章失败不影响其他章；刷新时失败章节沿用旧原文，本地内容不会变少。
- 磁盘缓存：`$OWL_CODING_AGENT_DIR/life-guide/`（默认 `~/.owl/agent/life-guide/`），一章一个原始 markdown 文件 + `meta.json`（快照日期，仅在 34 章齐全时记录）。离线时直接用缓存。
- 解析规则与桌面端 `guide-content.ts` 一致（`### N. 标题` + `<!-- 成本标签: … -->` + 字段行）；上游格式变化时两处要一起改。

## 测试

```
npm test        # 本包内
./test.sh       # 仓库根（非 e2e 全量）
```
