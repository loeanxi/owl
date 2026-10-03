---
name: univer-doc
description: 在 Owl 中创建、修改、检查和交付 Univer 文档，处理段落、文字样式、文档类型、分页与 DOCX 导入导出。
---

# Owl 文档工作流

先加载 `univer-office`。本指导依据 `dsh-univer-office@0.3.6` 的 `skills/univer-doc/SKILL.md` 精选改写，API 对应其 Univer SDK `1.0.2`；原项目和许可来源见本包 NOTICE。

## 执行边界

`univer_execute` 已提供 `univerAPI`、`api`（同一个对象）和当前 `unitId` 对应的 `doc`。不要重新声明这些变量，不要使用 `require`。
Doc 不提供 `workbook` 或 `presentation`；变量不匹配时检查 Unit 类型，不能猜测另一个 Unit ID。
`file`、`unitId` 和 `worktreeId` 从工具返回或 `univer_status` 取得；写入只进入显式草稿。
陌生接口用 `univer_api` 查同版本签名，例如 `action: "show"`、`queries: ["FDocument.appendParagraph"]`。

## 段落编辑

新 Doc 已有一个空段落；通常先改这个段落，再追加正文，不要留下多余的首段空白。
已有文档的段落索引会随编辑变化，跨步骤定位应使用检查结果中的稳定段落 ID。
不要直接改写内部 `body.dataStream` 或伪造段落存储结构；使用文档和段落 Facade。

```js
const first = doc.getParagraphs()[0];
if (!first) throw new Error("文档首段缺失");
first.setText("项目周报");
doc.appendParagraph("本周完成设备数据整理和报表检查。");
return doc.getParagraphs().map((paragraph) => paragraph.getText());
```

段落通过 `doc.getParagraphs()` 或 `doc.getParagraph(paragraphId)` 获取；`setText()` 修改本段，`appendParagraph()` 追加段落。
文字样式、段落样式和枚举值先查 API；不要凭习惯猜字号、对齐或标题级别字段。
异步的图片、图表或其他修改必须等待完成后再 return；返回明确读回值，不能用执行成功代替内容核对。

## 文档类型和分页

新 Doc 默认为 Modern，采用无页布局；先查询 `getDocumentFlavor()` 或 `isTraditional()` 再做物理分页。
Traditional 的 section/page 接口不能用于 Modern 文档；不要用大量空行或空格模拟页面。
`univer_import` 导入 `.docx` 默认保留 Traditional 页设置；只有用户要求无页文档时才设置 `docType: "modern"`。
需要页尺寸、方向、页边距、页眉页脚或分节时，先查询对应 API，逐项读回并检查实际分页。
修改表格时先确认单元格范围和目标文本，不要按重复文字全局批量修改。

## 检查和交付

编辑后先 `univer_inspect` 检查结构，再执行一次独立读回，核对全文、段落顺序、样式和任务要求。
图片、表格、分页或页眉页脚涉及版式时，使用 `univer_screenshot` 检查实际渲染。
截图 `output` 是工作区内的新 `.png` 文件路径；`pages` 只传正整数数组，例如 `[1, 2]`。
多页返回图片应逐页检查换行、遮挡和分页；未检查的页面不算已验证。
必要时使用 `univer_print_pdf` 输出新的 `.pdf`，检查与用户要求有关的页布局。
修改完成后 ready，提供 `.univer`；合入或丢弃只按用户明确请求执行，并经过 Owl 审阅确认。
需要 DOCX 时用 `univer_export` 写入新的 `.docx` 路径，再按具体任务核对导入、导出和分页结果。
Doc 没有表格公式计算流程；不要调用 Sheet 的公式事件，也不要宣称导出成功代表 Word 完全保真。
