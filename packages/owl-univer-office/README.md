# Owl Univer Office

为 Owl 接入 Univer 的本地办公运行时。适配层负责把 Owl 工具、工作区和审阅流程连接到独立 Gateway、内容 Worker 和 Viewer；它不以 DSH core 作为宿主，也不加载上游 `lib/index.js` 中的 DSH 插件入口。

本适配层固定使用 `dsh-univer-office@0.3.6` 发布产物，上游提交为 `c2caaefb43dc464f1477463c754f17a6be956193`。上游 main 后续的改动不自动进入此运行时。

## 安装独立运行时

需要 Node.js `>=22.19.0`，并安装随 Node.js 提供的 npm。在 Owl 仓库根目录执行：

```powershell
$env:OWL_CODING_AGENT_DIR = 'D:\owl\owl-re-v1\data\owl'
node packages/owl-univer-office/scripts/install-runtime.mjs
```

也可以给出独立缓存的绝对路径：

```powershell
node packages/owl-univer-office/scripts/install-runtime.mjs --target 'D:\owl\owl-re-v1\data\owl\cache\univer-office\runtime'
```

默认缓存为 `<OWL_CODING_AGENT_DIR>/cache/univer-office/runtime`；未设置环境变量时使用 `~/.owl/agent/cache/univer-office/runtime`。环境变量支持 `~/` 或 `~\` 展开，其他路径必须为绝对路径。`--target` 只接受绝对路径。

安装器在缓存内创建独立、私有的 `package.json` 和 `package-lock.json`，安装以下精确版本：

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `dsh-univer-office` | `0.3.6` | 独立 Gateway、Worker、Viewer 和渲染页面 |
| `@univer-cli/api-reference` | `1.0.2` | API 符号查找 |
| `@univer-cli/unit-screenshot` | `1.0.2` | 截图 |
| `@univer-cli/unit-pdf-printer` | `1.0.2` | PDF 打印 |
| `@univer-cli/unit-layout-lint` | `1.0.2` | Slide 布局检查 |
| `@univer-cli/svg-facade` | `1.0.2` | SVG 编译和文本测量 |
| `@univer-cli/resource-library` | `1.0.2` | 资源库 |
| `@univer-cli/univer-render-runtime` | `1.0.2` | 浏览器渲染运行时 |

实际 npm 安装使用 `--ignore-scripts --legacy-peer-deps --omit=dev --workspaces=false`，不执行包生命周期脚本，不构建上游，也不自动安装 DSH 宿主 peer packages。Windows 通过 Node.js 直接执行 `npm-cli.js`，不拼接 shell 命令。依赖和缓存锁不写入 Owl 主工程；安装器不修改 Owl 主工程的依赖清单或锁文件。

首次安装前会核对官方 npm 元数据中的固定版本、提交和 integrity；npm 验证下载内容，安装后再次核对版本、lock integrity 和必需产物路径。已完整安装的同版本缓存直接复用，不请求网络，也不覆盖已有运行配置。中断的受管安装可以再次运行；不属于此安装器的非空目录会被拒绝。安装期间使用 `.install.lock` 防止两个安装器同时写入；异常退出留下锁时，先确认没有安装进程，再删除该锁并重试。

上游 `0.3.6` 包的解包体积约 **216 MiB**，另有 SDK 和平台 native 依赖，因此按需装进用户缓存。截图、PDF 打印、Slide 布局和 SVG 文本测量需要可用的 Chrome、Chromium 或 Edge。运行时包含 libsql 和 Univer native binding，需与本机平台匹配。

## 接入 Owl

本地插件由 Owl 的插件管理器加载，扩展入口为 `src/index.ts`，专项指导从 `skills` 目录加载。运行时缓存安装与插件启用是两个步骤：先执行安装器，再把本包绝对路径追加到当前 `<agentDir>/settings.json` 的 `plugins` 数组。保留已有配置和其他插件，例如：

```json
{
  "plugins": ["D:\\owl\\owl-re-v1\\owl-mono\\packages\\owl-univer-office"]
}
```

重载扩展或重新启动当前 Owl 会话，使其读取插件配置。本地工作区使用 `D:\owl\owl-re-v1\data\owl` 作为隔离 agentDir。

| 环境变量 | 用途 |
| --- | --- |
| `OWL_CODING_AGENT_DIR` | Owl 数据和默认缓存位置 |
| `OWL_UNIVER_RUNTIME_ROOT` | 指向已安装的 `dsh-univer-office` **包目录**，默认 `<agentDir>/cache/univer-office/runtime/node_modules/dsh-univer-office` |
| `UNIVER_LICENSE` | 自有 Univer 许可证内容，供 Viewer 和 Node 运行链路使用 |
| `UNIVER_RENDER_BROWSER` | Chrome、Chromium 或 Edge 的可执行文件绝对路径 |

使用安装器自定义 `--target` 时，同步把 `OWL_UNIVER_RUNTIME_ROOT` 指向该目录下的 `node_modules/dsh-univer-office`。

## 工具

适配层注册以下 14 个工具。下表描述其接口职责；真实运行验证和格式兼容性仍需针对文件验收，不能根据注册成功推断全部功能已验证。

| 工具 | 功能 |
| --- | --- |
| `univer_new` | 创建 `.univer` 文件 |
| `univer_status` | 查看文件内容和草稿状态 |
| `univer_worktree` | 创建、提交、重开、合入或丢弃隔离草稿 |
| `univer_unit` | 添加、删除 Sheet、Doc、Slide、Base 或 Board |
| `univer_import` | 导入 Office 文件 |
| `univer_inspect` | 读取内容结构或 Sheet 范围 |
| `univer_execute` | 执行 Univer API 内容操作 |
| `univer_export` | 导出受支持的内容格式 |
| `univer_api` | 查找 API 符号和参考内容 |
| `univer_screenshot` | 输出 PNG 供检查 |
| `univer_print_pdf` | 打印受支持内容为 PDF |
| `univer_lint` | 检查 Slide 越界、溢出和文本重叠 |
| `univer_compile_svg` | 测量并编译 SVG 到指定 Slide 页面 |
| `univer_resources` | 查找和读取资源库 |

上游 `0.3.6` 的限制仍适用：Slide master、layout 和 speaker notes 不在当前编辑范围；Board 的 mind map、table、ink、高级编辑和文件导出未实现。工作树中的内容创作、人工审阅和最终导出应分别验证。合入或丢弃必须有用户明确请求。

## 许可证与来源

适配层及上游应用仓声明的 Apache-2.0 许可保存在 [LICENSE](./LICENSE)，上游作者、提交、npm snapshot 和依赖来源见 [NOTICE](./NOTICE)。本包是 Owl 适配层，不是 DSH core 的复制版本。

`dsh-univer-office@0.3.6` 的 Viewer 和 Worker 包含上游开发证书；对应源码注明是需要轮换的 **90 天开发许可证**。这不是本适配层取得的永久生产许可，也不能据此保证长期可用、其他域名适用或商业重分发。`@univerjs-pro/*`、`@univer-cli/*` 和 native/asset 依赖保留各自适用条款，不能把上游根仓的 Apache-2.0 声明当作全部依赖的统一授权。

正式部署或重分发前，应核实所用 SDK、功能、版本、浏览器域名、服务器执行和重分发范围。自有许可证通过 `UNIVER_LICENSE` 配置；浏览器 Viewer 与 Node Worker/渲染链路都必须收到这份许可证，具体注入由适配层运行时负责。不要把许可证内容提交到仓库。许可证覆盖可用功能，应用自身仍负责工作区和文档读写授权。

官方说明：[Univer OSS/Pro 边界](https://github.com/dream-num/univer#-open-source-and-pro)、[许可证配置](https://docs.univer.ai/server/license)、[固定发布元数据](https://registry.npmjs.org/dsh-univer-office/0.3.6)、[上游开发证书来源](https://github.com/dream-num/dsh-univer-office/blob/c2caaefb43dc464f1477463c754f17a6be956193/src/viewer-support/render-preset/license.ts)。

## 安装器验证

```powershell
node --test packages/owl-univer-office/test/install-runtime.test.mjs
```

测试使用临时目录和模拟 npm 结果，验证路径隔离、固定 snapshot、无生命周期脚本、缓存复用、失败重试和产物校验。它不替代真实 Gateway/Worker/Viewer 的运行验收，也不证明 Office 导入导出的版式保真度。
