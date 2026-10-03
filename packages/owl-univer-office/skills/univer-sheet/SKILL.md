---
name: univer-sheet
description: 在 Owl 中创建、修改、计算和验证 Univer 表格，处理单元格、公式、格式及 XLSX/CSV/TSV 导入导出。
---

# Owl 表格工作流

先加载 `univer-office`。本指导依据 `dsh-univer-office@0.3.6` 的 `skills/univer-sheet/SKILL.md` 精选改写，API 对应其 Univer SDK `1.0.2`；原项目和许可来源见本包 NOTICE。

## 执行边界

`univer_execute` 已提供 `univerAPI`、`api`（同一个对象）和当前 `unitId` 对应的 `workbook`。不要重新声明这些变量，不要使用 `require`。
`file`、`unitId` 和 `worktreeId` 必须来自工具返回或 `univer_status`；文件名、Unit 名称和 worksheet 名称不是同一标识。
修改已有文件前先检查内容；写入只进入显式草稿，ready 草稿继续修改前先 reopen。
陌生方法先通过 `univer_api` 查询，例如 `action: "show"`、`queries: ["FRange.setValues"]`；不要套用其他版本的方法。

## 单元格写入

数值、文本和公式分别保存；金额、百分比和日期的格式改变显示，不改变存储值。
普通文本使用 `{ v: "文本", t: 1 }`，数值使用 `{ v: 42, t: 2 }`，保留前导零的编号使用 `{ v: "00123", t: 4 }`。
公式使用 `{ f: "=B2*C2" }`，不要把显示文本当作计算值写回。
`setValues()` 合并原有单元格数据，空对象不能清除旧公式或富文本；完整重写一个区域时先 `clearContent()`。

```js
const sheet = workbook.getActiveSheet();
const target = sheet.getRange("A1:C2");
target.clearContent();
target.setValues([
  [{ v: "项目", t: 1 }, { v: "数量", t: 1 }, { v: "单价", t: 1 }],
  [{ v: "设备", t: 1 }, { v: 2, t: 2 }, { v: 150, t: 2 }],
]);
return target.getCellDatas();
```

工作表使用 `getActiveSheet()` 或 `getSheetByName()` 获取；名称用 `getSheetName()`，不要调用不存在的 `getName()`。
范围字符串如 `A1:C2`；数字行列索引从 0 开始。使用 `getCellDatas()` 核对存储值、类型和公式，显示内容可另查 `getDisplayValues()`。

## 公式与交付

公式源和缓存结果是两回事；刚写公式后立即读取可能得到旧值。需要新结果时先注册完成事件再计算：

```js
const calculated = api.getFormula().onCalculationResultApplied();
api.getFormula().executeCalculation();
await calculated;
return workbook.getActiveSheet().getRange("D2").getCellData();
```

每次修改后用 `univer_inspect` 指定真实 `file`、`unitId`、`worktreeId` 和 `range`，检查数据顺序、类型、公式与合计。
格式、图表或图片影响结果时，使用 `univer_screenshot`，`output` 是工作区内的新 `.png` 文件路径；Sheet 可指定 `range`，如 `Sheet1!A1:D10`。
修改完成后 ready，提供 `.univer` 供用户审阅；合入或丢弃只按用户明确请求执行，并经过 Owl 审阅确认。
导出前重新计算和读回，再使用 `univer_export` 写入新的 `.xlsx`、`.csv` 或 `.tsv` 路径。
导入 CSV/TSV 后逐列检查类型；需要交付兼容性时再导入导出的文件核对，不能仅凭导出成功宣称 Excel 无损兼容。
