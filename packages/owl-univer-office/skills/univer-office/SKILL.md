---
name: univer-office
description: 在 Owl 中创建和编辑表格、文档、演示文稿、多维表与画布，使用草稿、可视化审阅和 Office 导出交付成果。
---

先使用 `univer_new` 创建 `.univer` 文件，再使用 `univer_worktree create` 创建草稿。
通过 `univer_unit create` 创建内容，或使用 `univer_import` 将工作区内的 Office 文件导入草稿。
使用 `univer_status` 取得真实 unitId 和 worktreeId；不要猜测 ID。

修改前用 `univer_api find/show` 查询同版本 Facade API。
使用 `univer_execute` 在草稿中编辑。`code` 和 `codeFile` 二选一，代码显式 return 读回值。
使用 `univer_inspect` 验证单元格、公式与结构；视觉内容用 `univer_screenshot`，幻灯片用 `univer_lint` 检查布局。
修改完成后 `univer_worktree ready`，向用户提供 `.univer` 成果文件，在 Owl Office 工作台中审阅。

只有用户明确要求时才调用 merge 或 discard，这些动作还必须得到界面确认。
继续修改 ready 草稿时先 reopen；发生合并冲突应保留草稿并解释冲突，不强制覆盖主线。
用户确认后按需要使用 `univer_export` 导出 XLSX、DOCX 或 PPTX，或 `univer_print_pdf` 导出 PDF。
导入和导出不会自动保证 Office 文件无损兼容。检查公式值、图表、分页和版式，对具体不支持项如实说明。

所有源文件、代码文件与输出都必须位于当前工作区。写入使用新输出路径，不覆盖用户提供的源文件。
