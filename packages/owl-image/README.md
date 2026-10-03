# owl-image

给 Owl 编码 agent 的多 provider 图像生成插件。核心能力移植自
[shanliuling/dsh-image-gen](https://github.com/shanliuling/dsh-image-gen)(Apache-2.0),
把 DSH 宿主服务替换为 owl 原生等价物(工作区文件、`image-gen.json`、会话内联图片块)。

## 工具(模型自动可用)

| 工具 | 用途 |
|---|---|
| `generate_image` | 文生图。支持 per-call provider/model/比例/清晰度覆盖 |
| `generate_images` | 批量生图(1-10 个 prompt,单项失败不中断) |
| `edit_image` | 图生图/多图合成/改图。无选择器时自动用会话里最近一条带图消息(用户上传的本图或本工具此前生成的图);`source_path`/`source_paths` 指定工作区文件 |
| `find_inspiration` | 检索内置灵感库(awesome-gpt-image-2 案例库 + handraw-style 手绘风格图鉴,约 500+ 条可复用 prompt) |

生成的图会:(a) 作为 image block 附在工具结果里(桌面端直接渲染,模型也能看到并继续迭代);
(b) 默认落盘到 `<工作区>/owl-image/image-<sha256前8位>.<ext>`(内容寻址,重复生成同名覆盖)。

## 命令

| 命令 | 用途 |
|---|---|
| `/image-login` | Google 订阅(Antigravity)OAuth 登录——起本机回环服务器 + 自动开浏览器 |
| `/image-logout` | 退出 Google 订阅账号 |
| `/image-status` | 查看各 provider 配置状态 |

桌面端还有**设置页**:设置 →「图像生成」分区,可视化编辑全部配置(见下)。

## 桌面设置页

设置页「图像生成」分区与 `image-gen.json` 同源(桥端直接读写该文件,插件每次工具
调用现读,保存即时生效、无需重启):

- **默认 provider** 下拉(9 家)
- **Google 订阅**:登录状态徽章 + 登录/退出/刷新。登录走桥协议 `imageSub.login`,
  桥动态 import 插件 dist 暴露的 `beginGoogleSubscriptionLogin`(与 `/image-login`
  同一实现),起回环服务器并自动开浏览器
- **API Keys**:7 家 BYOK 逐行密码框;状态徽章区分「配置文件/环境变量」来源;留空
  保持不变,勾选「清除」删配置行。**密钥明文永不下发 UI**,协议里只有存在性
- **模型与端点**:按当前 provider 显示对应字段(google/openai/compat/seedream/
  dashscope/xai/zhipu 各自的 baseURL+model;compat 另有 edits 请求形态;seedream
  另有输出格式/水印/背景)。模型输入框带**「拉取模型」**:走桥协议
  `imageModels.list` 动态 import 插件 dist 的 `listProviderModelIds`,按 provider
  调各家 models 接口(Gemini 优先返回图像模型,OpenAI 形状接口全量返回、由
  datalist 随输入前缀过滤;google-sub 固定模型;comfyui 直接列工作流名)。进入
  分区或切换 provider 且 key 已配置时自动拉取一次,也可手动点按钮重拉;拉取
  失败只显示原因,模型仍可手填,不阻断配置
- **ComfyUI 工作流**:列表(设默认/删除)+ 添加表单(名称/前置提示词/JSON 粘贴框),
  客户端与服务端双重校验 JSON 与 `{{prompt}}` 占位符
- **输出**:落盘开关与子目录、图片是否回传给模型(省 token)、单图上限(MB)、代理

写入走白名单:未知字段原样保留(向前兼容),字符串裁剪、数字夹紧、枚举校验。

## Provider

| provider | 凭据 | 说明 |
|---|---|---|
| `google`(默认) | `GEMINI_API_KEY` | Gemini Interactions API,t2i + i2i,最高 4K |
| `google-sub` | OAuth 登录 | 走 Antigravity 账号(Nano Banana 2),`/image-login` 即用;**实验性**,打的是 Google 内部接口,协议来自社区逆向,随时可能失效或被官方封堵,风险自担 |

Google 订阅通道的项目解析分三阶段(补自参考实现):`loadCodeAssist` 取账号自己的托管项目 → 没有则 `onboardUser` 自动开通(探测 tier + 轮询)→ 都失败才回退上游硬编码的社区共享项目 `rising-fact-p41fc`。引导成功的项目 id 会持久化到登录 blob 跨会话复用;若生成错误附带"社区共享项目"诊断,说明引导未成功,该公共池配额耗尽可能导致与账号余量无关的 429——该内部接口对代理出口 IP 也挑剔,换节点是第一排查项。
| `openai` | `OPENAI_API_KEY` | 官方 Images API(gpt-image-2) |
| `openai-compat` | `OWL_IMAGE_OPENAI_COMPAT_KEY` | 任意 OpenAI 兼容中转;edits 支持 multipart / JSON image_url 数组 / form reference_images 三种形态 |
| `seedream` | `ARK_API_KEY` | 火山方舟 Seedream(可去水印/透明底) |
| `dashscope` | `DASHSCOPE_API_KEY` | 阿里通义 qwen-image(编辑最多 3 张参考图) |
| `xai` | `XAI_API_KEY` | Grok Imagine(比例+清晰度) |
| `zhipu` | `ZHIPUAI_API_KEY` | 智谱 glm-image(仅文生图) |
| `comfyui` | 无需 key | 本地 ComfyUI,跑 API 格式工作流(含 `{{prompt}}`/`{{seed}}`/`{{image}}` 占位符) |

所有出站请求默认走 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量,或在配置里显式指定 `proxy`。

## 配置(`<agentDir>/image-gen.json`)

文件不存在时全部用代码内默认值;改动即时生效(每次工具调用现读)。

```json
{
  "provider": "google",
  "apiKeys": {
    "google": "AIza...",
    "openai-compat": "sk-..."
  },
  "googleModel": "gemini-3.1-flash-image",
  "openaiCompatBaseURL": "https://your-relay.example/v1",
  "openaiCompatModel": "gpt-image-2",
  "comfyuiBaseURL": "http://127.0.0.1:8188",
  "comfyuiWorkflows": [
    { "name": "默认出图", "json": "{ ...API 格式工作流, 文本节点里放 {{prompt}}... }", "presetPrompt": "可选,前置到用户 prompt 前" }
  ],
  "comfyuiActiveWorkflow": "默认出图",
  "saveToWorkspace": true,
  "workspaceFolder": "owl-image",
  "attachImageToResult": true,
  "maxImageBytes": 10485760,
  "proxy": ""
}
```

- `apiKeys` 优先级高于环境变量;写进 JSON 是明文,注意该目录权限。
- `attachImageToResult: false` 可让生成的图不回传给模型(纯落盘),省 token;桌面端仍从保存路径预览。
- `proxy: "off"` 强制直连;空串跟随环境变量。
- `googleSubModel`(逃生舱):Google 订阅通道的模型 id,默认 `gemini-3.1-flash-image`。
  Google 会不定期退役/改名这些内部图像模型;若订阅生图报 429/模型不存在,可在此
  填其他 id 试验(改完即生效,无需重启)。注意该通道对代理出口 IP 也很挑剔——IDE
  里的 chat 配额余量与内部生图接口是两套体系,429 时先换代理节点再试。

## 构建

```bash
cd owl-mono/packages/owl-image
npm run build        # esbuild 单文件 → dist/index.js(undici 保持 external)
npm run typecheck
```

## 冒烟

```bash
cd /d/owl/owl-re-v1
node smoke/owl-image-check.mjs          # 9 项:真实加载链路 + 工具注册 + 灵感检索 + 错误路径,不碰网络
node smoke/owl-image-settings-check.mjs # 17 项:桥端设置数据面(白名单写入/密钥合并/插件发现/订阅状态)
node smoke/owl-image-bridge-check.mjs   # 13 项:真实 serve + WS 端到端(4 条新路由;登录用假插件包验证,不开浏览器)
```

## 与上游(dsh-image-gen)的差异

- **没有**浏览器工作台:画布(tldraw)、Studio 批量对比、图库、设置页 UI 均依赖 DSH 的
  slot 注入体系,owl 桌面端暂无第三方 UI 扩展点,整体不移植。
- **砍掉** `chatgpt-sub` / `grok-sub` 订阅通道,只保留 `google-sub`(Antigravity)。
- DSH 的 attachments 服务(带 ID 的内容寻址图片库)→ 会话内联图片块 + 工作区文件;
  `edit_image` 的"最新会话图片"回退因此直接读消息里的 image block。
- DSH credentials 服务 → 环境变量 + `image-gen.json` 的 `apiKeys`。
- 新增全链路代理感知(`doFetch`),适配本机 `HTTP_PROXY` 环境。
- 保留上游的安全细节:错误信息密钥脱敏、响应字节上限、工作区保存的双重包含检查、
  内容嗅探优先于声明 content-type。

上游 Apache-2.0 许可与出处已在各文件头注明。
