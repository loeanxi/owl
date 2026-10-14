# owl-life-guide

owl 的开源生活指南检索插件，给 agent 提供 `life_guide_search` 工具，内置两个数据源：

- **guide**（默认）：[eternity4719/HowToLiveBetter](https://github.com/eternity4719/HowToLiveBetter)（正文 CC BY 4.0）：34 章、约 665 条按证据等级（A/B/C）分生活建议，每条带成本标签、说人话摘要、收益、来源与备注。桌面端已有阅读面板（`apps/desktop/src/features/guide`）；本插件让 agent 在对话里能直接查同一份内容并引用条目作答。
- **longevity**：[geekan/HowToLiveLonger](https://github.com/geekan/HowToLiveLonger)（Unlicense，公共领域）：按全因死亡率（ACM）整理的长寿清单，42 条 / 17 小节，覆盖饮食（固体/液体/气体/光照/药物）、运动、睡眠、情绪、体重等；条目带原文链接与争议标记（如钠、碳水）。

## 工具：life_guide_search

| 参数 | 说明 |
| --- | --- |
| `source` | `guide`（默认）/ `longevity`，选择数据源 |
| `query` | 关键词，空格分词、词间 AND，中文按子串匹配；标签词（如「收益大」）和章名也可命中 |
| `chapter` | 仅 guide：限定章号 1-34 |
| `grade` | 仅 guide：`A` / `B` / `C` / `disputed`（上游争议标记） |
| `section` | 仅 longevity：小节过滤，按子串匹配小节号或小节名（如 `6.2` / `液体` / `睡眠`） |
| `key` | 精确取单条全文：guide 形如 `"章.条"`（如 `"1.6"`），longevity 形如 `"小节/主题"`（如 `"6.1.2/牛奶"`）；忽略其余参数 |
| `full` | 展开全文（guide：成本/收益/来源/备注；longevity：全部明细与链接） |
| `limit` | 返回条数上限，默认 8，最大 30 |
| `refresh` | 跳过缓存强制从上游刷新 |

无参数调用返回对应源的目录概览（guide：章目录 + 等级分布；longevity：小节目录 + 条数）。结果头部带命中数与本地快照日期；未命中时给出改写建议而不是空结果。

## 数据与缓存

- 抓取走 jsDelivr：guide 按章拉取（`cdn.jsdelivr.net/gh/eternity4719/HowToLiveBetter@main/book/`），单章失败不影响其他章；longevity 拉整个 README（`cdn.jsdelivr.net/gh/geekan/HowToLiveLonger@main/README.md`）。刷新时失败沿用旧内容，本地内容不会变少。
- 磁盘缓存：`$OWL_CODING_AGENT_DIR/life-guide/`（默认 `~/.owl/agent/life-guide/`）：guide 一章一个原始 markdown 文件 + `meta.json`；longevity 存 `longevity-readme.md` + `longevity-meta.json`（各自快照日期）。离线时直接用缓存。
- 解析规则：guide 与桌面端 `guide-content.ts` 保持一致（`### N. 标题` + `<!-- 成本标签: … -->` + 字段行）；longevity 解析 README 的「6. 证据」段（`#### 6.x` / `##### 6.x.y` 小节 + 缩进 bullet），上游格式变化时两处要一起改。

## 测试

```
npm test        # 本包内
./test.sh       # 仓库根（非 e2e 全量）
```
