# owl-safety-net

Owl 编码代理的安全网插件：在任何 shell 命令、文件读写执行**之前**拦截破坏性命令
（如 `rm -rf`、`git reset --hard`、磁盘/系统破坏）与敏感文件访问（`.env`、密钥、凭据等）。
引擎**fail-closed**：自身出错时同样拦截该次调用。

来源：[kenryu42/cc-safety-net](https://github.com/kenryu42/cc-safety-net) 2.4.15（MIT）。

## 结构

```
src/index.ts            Owl 原生扩展入口（对上游 dist/pi/index.js 的可读重写）
vendor/chunks/*.js      上游规则引擎，逐字节原样保留（含规则库、守卫、审计、参考文档）
vendor/chunks/*.d.ts    手写声明，映射上游压缩导出名（c/ye/be/N/he/… → 语义名）
scripts/build.js        esbuild 打包 src + vendor → dist/index.js（自包含单文件）
scripts/smoke.mjs       无需宿主的冒烟测试（mock 扩展 API）
```

上游 dist 是 bun 打包的压缩产物，无法做源码级 fork；因此采取「引擎按字节 vendor +
入口重写」的方式。入口通过 import-rename 使用引擎（例如 `c as loadConfig`），
映射表同时写在 `vendor/chunks/*.d.ts` 里。升级引擎时：替换三个 `.js`、核对导出名
未变、重跑 `npm run smoke` 即可。

## 与上游的差异（OWL-PATCHES）

- 入口针对 Owl 扩展 API 重写：类型取自 `@owl/owl-coding-agent`，审计元数据
  `agent` 为 `"owl"`，日志前缀 `owl-safety-net`。
- 斜杠命令由 `/cc-safety-net` 改为 **`/safety-net`**（把引擎参考文档作为提示词发给模型）。
- 上游入口里对事件对象的运行时防御检查（非对象/未知 type）依赖 pi 的动态事件，
  Owl 的 `tool_call` 事件是强类型，故省略。

## 行为

- `bash` / `powershell` 工具：解析命令（含管道、组合、子命令）逐段检查。
- `read` / `edit` / `write` / `grep` / `find` / `ls` 等工具：敏感路径访问检查。
- 其余工具不拦截；对 `tool_call` 返回 `{ block: true, reason }`。
- 拦截时模型会收到解释性 reason（引擎的 `stop_and_explain` 语义），并可写审计日志
  （`CC_SAFETY_NET_AUDIT_SCOPE=all` 时记录全部调用）。

环境变量（继承上游，均可选）：`CC_SAFETY_NET_LEVEL`、`CC_SAFETY_NET_STRICT`、
`CC_SAFETY_NET_PARANOID`、`CC_SAFETY_NET_AUDIT_SCOPE`、`CC_SAFETY_NET_DEBUG`
（旧 `SAFETY_NET_*` 名字仍被引擎识别）。

## 接入方式

settings（`data/owl/settings.json`）的 `plugins` 数组按路径引用，与
`owl-web-access` 相同：

```json
"plugins": [
	"D:\\owl\\owl-re-v1\\owl-mono\\packages\\owl-safety-net"
]
```

包通过 `package.json` 的 `owl.extensions: ["./dist/index.js"]` 声明入口，改完源码后
`npm run build` 再重启 owl 生效（或删掉 dist 临时改指 `./src/index.ts`，加载器走 jiti）。

## 开发

```bash
npm run build     # 打包 dist/index.js
npm run smoke     # 冒烟：rm -rf 拦截、.env 读取拦截、放行普通命令
npm run typecheck # tsc --noEmit
```

## License

MIT，见 LICENSE（含上游归属）。
