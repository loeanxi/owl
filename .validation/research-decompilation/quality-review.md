# 主入口 JSC 产物质量审阅

本审阅只读取已生成的反汇编与近似代码，以及已校验的 View8 源码。未执行样本、其加载器或生成代码；例子中不显示业务常量与凭据。

## 实际结构覆盖

- 1749 个 SharedFunctionInfo 块与 1749 个唯一地址，所有块闭合。
- 原始反汇编含 99994 条指令。
- 近似代码含 1749 个函数头，全部能按地址映射回原始反汇编的对应函数。因此当前成果已经包含结构、函数名、常量索引、调用及分支证据。
- 1139 个函数正文含未还原的 `Scope[...]`，1092 个含未知或匿名引用等标记，521 个出现 `new {}`；去重后 1501 个函数正文至少含一项此类未决标记。
- `<unknown>` 也大量出现在 V8 调试打印的脚本/位置信息等元数据中，不能把元数据 unknown 行数直接当成丢失代码数。
- 以上是结构与文本统计，**不能计算为语义恢复率**，没有标记的剩余 248 个函数也没有自动获得语义等价证明。

完整机器可读索引见 `quality-coverage.json`：每个函数包含原名称、地址、反汇编/近似代码行号、指令数量、分支数量、未决标记。无需运行代码即可让 Agent 按用户目标定位具体函数。

## 具体质量缺口

`Translate.translate.py` 未找到 opcode handler 时直接 continue，进程可以正常 exit 0。按当前安装的映射表与实际指令名称比较，主入口有 5776 条没有映射，多数为 `.Wide` 宽参数形式，包括：

- `LdaImmutableCurrentContextSlot.Wide` 1227 条。
- `StaCurrentContextSlot.Wide` 1089 条。
- `CreateClosure.Wide` 800 条。

另有 4720 条被映射为无输出，例如 Throw/ReThrow、TDZ 检查、Suspend/ResumeGenerator。还存在 `LdaTheHole -> null`、`JumpIfUndefinedOrNull -> undefined`、对象模板 `{}`、重复覆盖的 bitwise handler 等近似翻译。故无进程错误不能作为完整恢复凭证。

## 两个有用对应例子

1. `_isLifecycleVersionCurrent`：近似文件 48183–48187 行；反汇编 215975–215986 行。常量 0 为 `_getDeviceLifecycleVersion`；指令依次读取 this 方法、以 a0 调用、与 a1 严格比较并 return。近似代码保存了这一调用和比较结构。它能帮助 Agent 定位设备生命周期版本校验。
2. `updateTooltip`：近似文件 44368–44375 行；反汇编 196606–196620 行。先读 this.tray，@4 根据布尔值跳到 @21；非空路径调用 tray.setToolTip(a0)，最后返回 undefined。近似代码有相应 if、调用与返回。它能帮助 Agent 定位托盘提示更新。

上述两例证明近似代码包含可核对的业务结构，而不是证明整个程序已恢复。仍保留 `<this>` 等伪代码语法，不直接执行。

## 明确的反例

`resolveTargetUpdaterProtocol` 反汇编 114783–114796 行包含宽槽位 793、比较，以及两个不同常量的分支汇合。近似文件 25510–25518 行遗漏宽槽位读取，错误沿用前一个 Scope 值作为第二参数，同时把分支结果简化为固定最后常量返回。这属于数据流语义错误，超出了变量名丢失的范围。

三个例子的脱敏对照保存在 `quality-evidence.json`，带精确地址和行号；原始数据未修改。

## View8 执行入口审查

固定入口 `view8.py --disassembled dump output` 导入闭包为：

`view8.py -> Parser/sfi_file_parser.py -> Parser/shared_function_info.py -> Translate/translate.py + Translate/translate_table.py + Translate/jump_blocks.py + Simplify/simplify.py + Simplify/function_context_stack.py`，再加 vendored `parse.py`。

- 主路径没有 eval、exec、__import__ 或 subprocess 调用。目标内容被作为文本、数字、指令、常量字符串和对象字段处理，不转换成 Python 代码执行。
- `Translate/translate_table.py:53` 用 `ast.literal_eval` 解析 switch 的数字字面量映射；它不会执行调用表达式。仍可能被恶意大结构消耗资源，不能把它称为操作系统安全隔离。
- `parse.py` 的 compile 是正则模式编译封装，不是 Python builtin compile；所有 Parser 传入的是工具源码中的固定模式。
- `Simplify/simplify.py` 有固定目标地址的 debug 写日志，文件名固定 `debug_0x708001a5f95.log`，会落在本次 cwd。没有根据目标字符串挑选任意输出文件的入口。
- 已安装但未导入的 `Parser/parse_v8cache.py` 存在 subprocess 调用，可调用 VersionDetector/其他 disassembler。当前固定 `--disassembled` 入口不会走它；不能把目录中所有文件笼统说成没有 subprocess。
- 该审查说明当前已固定的源码入口行为，不能替代对 native d8 反序列化内存安全的审计；d8 自己的兼容补丁绕过校验与 Hole 回退风险仍存在。

## 产品标签与后续实现建议

产物标签采用“V8 Ignition 反汇编证据”“近似反编译伪代码（不可直接执行）”“函数索引与未决覆盖”。Agent 每次解释具体逻辑时引用函数地址/指令偏移，并标注已核对与未决部分，不把 Scope、unknown、new {} 替换为猜测的业务实现。

提升恢复准确性应按以下顺序实现并用已知 benign fixture 验证：

1. 将 `.Wide/.ExtraWide` 当参数宽度元数据，使用相同基础指令语义；保留原始字节与解码整数。未支持指令必须显式进入 Unknown IR 并报告，而非静默丢弃。
2. 从指令偏移和跳转目标建立 CFG 基本块，保留 fallthrough、异常边和全部 return；不要把未知目标吸附到邻近偏移。
3. 为 accumulator/register 建立分支数据流与 SSA/phi 合并，保证三元/if 两个返回值保持不同。修复示例应验证 wide 槽位 793 和分支汇合都存在。
4. 保留 Throw/ReThrow、TDZ、async/generator suspend/resume 的显式语义；无法结构化时输出相应 IR，而不是 null 或空语句。
5. ScopeInfo、对象模板、receiver 和闭包捕获应有单独恢复证据；未知槽位使用稳定符号，不猜原名或跨函数常量绑定。
6. 只针对已知源码的无副作用合成样本做语义 golden 测试；运行真实目标做“试试能否执行”不属于此静态路径。

测试至少覆盖宽槽读取/写入、条件返回两个不同值、短路 null/undefined、带 receiver 的调用、throw/catch、closure 和 async 状态。源语法检查只能验证输出是否像 JavaScript，不能证明等价；应同时验证 IR 与原始指令、常量、CFG 的一一对应。
