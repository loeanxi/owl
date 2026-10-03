---
name: univer-slide
description: 在 Owl 中生成、修改、检查和交付 Univer 演示文稿，通过 SVG 编译、布局检查和逐页截图完成可靠的 PPTX 创作。
---

# Owl 演示文稿工作流

先加载 `univer-office`。本指导依据 `dsh-univer-office@0.3.6` 的 `skills/univer-slide/SKILL.md` 精选改写，API 对应其 Univer SDK `1.0.2`；原项目和许可来源见本包 NOTICE。

## 执行边界

`univer_execute` 已提供 `univerAPI`、`api`（同一个对象）和当前 `unitId` 对应的 `presentation`。不要重新声明这些变量，不要使用 `require`。
Slide 不提供 `workbook`；`file`、`unitId` 和 `worktreeId` 必须从工具返回或 `univer_status` 取得。
Facade 的 `getSlideByIndex(0)` 选择第一页；工具的 `page: 1` 和 `pages: [1]` 使用从 1 开始的页号。
陌生方法先 `univer_api find/show` 查同版本 API，修改既有元素时使用检查结果中的真实元素 ID。

## 生成页面

先确定受众、每页核心信息、最终文字、页尺寸、配色、字体和所需本地素材，再生成 SVG。
新 Slide 已有一张空白页面；第一页直接编译到 `page: 1`，不要为了第一页另加一张空白页。
完整生成或重做页面使用 `univer_compile_svg`；`source` 是工作区内保留的 SVG 文件。

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
  <rect width="960" height="540" fill="#FFFFFF"/>
  <text x="60" y="100" font-size="40" fill="#1F2937">项目进展</text>
  <text x="60" y="180" font-size="24" fill="#374151">完成设备数据整理与报表核对</text>
</svg>
```

调用编译工具时同时传真实 `file`、`unitId`、`worktreeId`，以及 `source: "page-01.svg"`、`page: 1`、`mode: "replace"`。
修复整页时修改原 SVG 并再次 replace；不要用 add 叠加修正版，让旧内容留在下面。
素材通过 `univer_resources` 查找和读取真实 handle，或 export 到工作区的新目录；不要猜资源 ID。
位图使用工作区内 PNG/JPEG 等文件和明确尺寸；当前 Owl 编译器拒绝外部 URL 与嵌套 SVG 文件引用。
使用 SVG 资源时将需要的受支持几何完整置入页面 SVG，不要截断 path 数据或用空占位符交付。

## 逐页验证

每页执行完整闭环：编译 → `univer_inspect` → `univer_lint` → `univer_screenshot` → 检查 PNG → 修复源 SVG。
lint 的 `pages` 是正整数数组，例如 `[1]`；它检查文本越界、溢出和重叠，不能替代视觉检查。
截图 `output` 是工作区内的新 `.png` 文件路径，`pages` 同样只用正整数数组。
清理编译 warning；剩余 lint 必须用实际版式证据解释，不能把所有重叠默认当成设计意图。
逐页检查文字完整、留白、对齐、对比度、图片位置和跨页一致性；未检查的页面不算已验证。

## 既有内容和交付

已有元素优先通过 Facade 获取后修改，不要直接编辑脱离文档的快照对象并假定会保存。

```js
const firstPage = presentation.getSlideByIndex(0);
if (!firstPage) throw new Error("第一页缺失");
return { elementCount: firstPage.getElements().length };
```

图表、原生表格或过渡先查询 API，再读回验证；完整 SVG replace 会清除原页元素，原生内容应在最终替换后插入。
完成所有页后 ready，提供 `.univer` 供审阅；合入或丢弃只按用户明确请求执行，并经过 Owl 审阅确认。
按需 `univer_export` 写入新的 `.pptx`，必要时打印 `.pdf`；对具体 PowerPoint 兼容性进行核对。
Master/layout 页面、speaker notes 和元素动画不在当前编辑范围；截图与 lint 也不证明过渡播放效果。
