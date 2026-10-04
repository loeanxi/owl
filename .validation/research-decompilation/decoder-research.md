# MCHOSE HUB JSC 反编译路线核验

本轮只读取 EXE、JSC 与加载器；未启动 MCHOSE HUB.exe、未运行其 loader、JSC 或恢复代码。

## 已验证的匹配证据

- EXE 静态 ASCII：偏移 151206898 为 `Electron/31.7.4`；偏移 151180619 为 `Chrome/126.0.6478.234`；偏移 155360727 为 `12.6.228.30-electron.0`。
- Electron 官方发布页同时列出 Electron 31.7.4、Chromium 126.0.6478.234、V8 12.6.228.30：https://releases.electronjs.org/release/v31.7.4
- `resources/app/out/main/index.jsc` 929096 字节；header magic `0xc0de063a`；versionHash `0xa5e2d63c`；sourceLength 670692；payloadLength 929064，即实际长度减 32 字节 header。
- 按 V8 12.6 官方 `Version::Hash()`、32 位整数散列、64 位 hash_combine 独立重算 `[12,6,228,30]`，得到 `0xa5e2d63c`。脚本 `version-hash.mjs` 只计算已知版本数值，没有反序列化样本。

## 可执行路线

1. 固定匹配 V8 12.6.228.30 的 jsc2js Windows d8：
   https://github.com/xqy2006/jsc2js/releases/download/12.6.228.30/d8-12.6.228.30-windows.zip
2. GitHub release 提供 SHA256 `b8c87c661ebb561db4363ebf48eb9e92288961d233b947f465e1d0303854a6b4`，压缩包 9670809 字节，包含 d8.exe 和匹配 snapshot_blob.bin。release tag 对应源提交 `87a35e1e186bd1d86fca6ba500e203a273a6e1bb`。
3. 将已校验 JSC 复制到独立输出目录，不修改输入头。固定 d8 的 `loadjsc(canonicalCopiedPath)` 辅助函数只做 `CodeSerializer::Deserialize`、SharedFunctionInfo/BytecodeArray 打印，不调用目标 Script::Run 或目标 wrapper.apply。
4. 用固定 View8 源码 `d240cec90dd3ea371504c24bb1fb1ea5aad4e81a`，Python 3.9+，vendored parse 1.20.2，把反汇编文本重建为近似 JavaScript：`view8.py --disassembled disasm.txt reconstructed.js`。不会执行重建结果。
5. 原始反汇编、近似重建、进程诊断、输入与产物哈希一起保存。未知指令、解析失败、对象占位必须记录为部分结果。

## 审查所得限制

- 原程序 loader 使用 `vm.Script(cachedData)`、`runInThisContext`、`compiledWrapper.apply`，会执行程序逻辑，不能拿来充当静态解析器。
- 对应 release 的 `patch.diff` 绕过缓存 header/hash/checksum 校验，并对超出范围的只读堆引用用 Hole 替代。当前稳定 12.6 patch 另有 undefined 回退。源 README 中的保留校验说明主要针对 legacy/modern 版本段，不能套到本版本。
- 因此包装层自己严格检查支持的 magic/version/payload 边界、工具来源和各文件 hash，并限制文件、输出、时间、环境、取消操作。独立子进程没有操作系统沙箱，不能把 native decoder 的反序列化视作安全边界。
- 能提供字节码反汇编与近似控制流、常量、函数恢复；不能保证恢复原注释、原变量名、完整源码或所有语义。成功 exit 不是语义等价证明。
- 核验语义应采用已知源码的无副作用 golden fixture 对比，以及恢复函数与原始字节码的指令、常量、分支、异常表对应。禁止运行真实样本做盲验。

## 主要源码

- V8 header：https://github.com/v8/v8/blob/12.6.228.30/src/snapshot/code-serializer.h
- V8 version hash：https://github.com/v8/v8/blob/12.6.228.30/src/utils/version.h
- V8 hash functions：https://github.com/v8/v8/blob/12.6.228.30/src/base/functional.h
- d8 release patch：https://github.com/xqy2006/jsc2js/blob/87a35e1e186bd1d86fca6ba500e203a273a6e1bb/patch.diff
- 当前 View8：https://github.com/xqy2006/jsc2js/tree/d240cec90dd3ea371504c24bb1fb1ea5aad4e81a/View8

## 实现交付

`packages/coding-agent/src/core/research/bytecode-decompiler.ts` 与 `test/research-bytecode-decompiler.test.ts`。7 个固定 runner 测试通过，覆盖来源/资源哈希、固定参数、输入未修改、版本不兼容、payload 截断、Python 缓存/未申报脚本拒绝、部分恢复、取消、超时、路径链接与边界。实际 native decoder 运行由 root 执行与验收。
