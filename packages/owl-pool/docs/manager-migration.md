# Manager → Owl 号池服务迁移设计

> 施工图。原项目:`D:\manager`(Spring Boot / Java 21,约 5.4 万行 Java + 1.4k 行 Node bridge + 1.8 万行静态管理台)。
> 目标:用 owl 的技术栈把 manager 的**全部能力**重写为 owl 的原生子系统,服务住进 owl-mono,桌面端原生 UI,Java 版最终退役。

## 1. 背景与目标

manager 是团队在用的多平台 AI 编程工具号池服务:账号管理、自动签到、API Key 分发、三协议网关
(OpenAI Chat / Anthropic Messages / OpenAI Responses)、人民币计费。owl 桌面端已把它当模型
provider 接入(`127.0.0.1:8787`)。

本迁移要把 manager 变成 owl 自己的 `owl-pool` 子系统:

- 领域逻辑沉淀为纯 TS 包 `packages/owl-pool`(可独立测试)。
- 服务壳为 `apps/pool-server`(Node 进程,零第三方 Web/DB 依赖)。
- owl 桌面端最左侧新增原生 Manager 入口(后续阶段),本地直连 sidecar、团队连远程实例。
- 对外 HTTP API 与 manager 保持协议兼容,owl 编程端与现有 sk- Key 用户无感切换。
- 数据库 schema 沿用 manager 的表结构,生产数据经备份 zip(JSONL)一次性导入。

## 2. 总原则

1. **绞杀式迁移**:每个域重写完即可用,Java 版在线上陪跑,逐域接班,最后退役。任何时刻都有可运行的系统。
2. **对照验收**:每个域重写完,以 Java 实现为参照做行为对齐(接口响应形状、边界分支、错误码)。移植看源码,不看文档。
3. **协议兼容优先**:对外 REST/网关 API 的路径、请求/响应形状、错误码与 manager 一致;确需偏离的,在本文档记录并同步桌面端。
4. **防御不丢**:manager 的安全与韧性加固(见 §8)是挨过打换来的,重写逐条对表,不许静默消失。

## 3. 技术选型决策记录

| # | 决策 | 理由 |
|---|------|------|
| D1 | **存储用 `node:sqlite`(DatabaseSync,WAL)**,不引入 PostgreSQL/ORM | owl-mono 唯一 DB 先例就是 node:sqlite(news store),全仓库零第三方 DB 依赖;桌面内嵌形态天然适合嵌入式库。与 Java 版的数据桥接不用在线双写:manager 每日备份 zip 本来就是「每表一个 JSONL」,写一个导入器即可。团队部署若将来需要 PG,Repository 接口留好再补实现 |
| D2 | **HTTP 用 `node:http`**,路由走 handler 链(`handleXxx(req,res,ctx): Promise<boolean>`,不匹配返回 false),不引入 Fastify/Hono | 对齐 `packages/coding-agent/src/modes/desktop/map-http.ts` 的既有模式;SSE(网关阶段)直接 `res.write` |
| D3 | **领域层(`owl-pool`)零运行时依赖**;HTTP 用 Node 22 全局 fetch(AbortSignal 超时),时间统一 epoch 毫秒 + Asia/Shanghai 业务日 | 保持可移植、可独立测试 |
| D4 | **禁 enum**(仓库 erasableSyntaxOnly):`Platform`/`CheckInStatus` 等用字符串字面量联合 + const 数组,**值与 Java 枚举名逐字一致**(DB 兼容) | TS 语法约束 + 数据兼容 |
| D5 | `owl-pool` 用 **tsc emit**(dist + d.ts,`rewriteRelativeImportExtensions` 自动把 `.ts` 导入改写为 `.js`);`pool-server` 用 **esbuild bundle** 成单文件 `dist/main.js` 运行,`owl-pool` 保持 external(workspace 解析) | 对齐仓库既有构建方式 |
| D6 | 服务默认 **`127.0.0.1:8790`**(env `OWL_POOL_PORT`),避开 Java 版 8787,并行期互不干扰;割接时改端口即可 | 并行运行 |
| D7 | 阶段 0/1 **无鉴权但只绑回环**;管理端鉴权域(阶段 2)落地之前禁止非回环部署 | manager 安全姿态的底线 |

## 4. 目标架构

```
owl-mono/
├── packages/owl-pool/            领域核心(零依赖,可独立测试)
│   ├── src/platform.ts           平台枚举与能力表
│   ├── src/account/              账号聚合根 + Store SPI
│   ├── src/checkin/              签到 SPI + Provider + Service + 记录
│   ├── src/common/               ApiResponse / BusinessError / 业务时间 / 脱敏
│   ├── src/apikey|catalog|gateway|billing|member/   (后续阶段逐域补齐)
│   ├── test/                     vitest
│   └── docs/manager-migration.md 本文档
└── apps/pool-server/             服务壳(依赖 owl-pool)
    ├── src/http/                 node:http 路由 + 各域 REST 端点
    ├── src/store/                node:sqlite 实现(建表 schema 沿用 manager)
    ├── src/scheduler/            定时签到 / 补签 / 备份等 cron
    ├── src/security/             (阶段2)管理端鉴权 / 登录锁定 / 限流 / IP
    ├── src/gateway|upstream/     (阶段3/4)网关 + 上游客户端 + bridge/codex/mimo 运行时
    ├── bridge/                   (阶段4)从 manager/bridge 平移的 Node 桥,进程模型不变
    └── dist/main.js              esbuild 产物,`node dist/main.js` 运行
```

部署形态:①`node dist/main.js` 独立部署(团队模式,替代 Java 版);②owl 桌面端以隐藏子进程拉起
(对齐 `src-tauri/main.rs` 拉 bridge 的既有方式)。

## 5. Java → TS 模块映射表

| manager(Java 包) | 去向 | 阶段 |
|---|---|---|
| `account`(Account/Service/Controller/Platform/CreditProvider) | `owl-pool/src/account` + `pool-server/src/http/accounts-api` | 1 |
| `checkin`(SPI/Service/Provider/Record)+ `checkin.provider.*` | `owl-pool/src/checkin` | 1 |
| `schedule.CheckInScheduler` / `LoginCheckInCatchUp` | `pool-server/src/scheduler` | 1(补签挂钩鉴权后) |
| `common`(ApiResponse/BusinessException/BusinessTime/Masker/UpstreamMessages) | `owl-pool/src/common` | 1 起 |
| `security` + `security.admin`(鉴权/锁定/会话/IP/限流/告警) | `pool-server/src/security` | 2 |
| `apikey`(哈希/策略/IP/限流/EffortPolicy) | `owl-pool/src/apikey` | 3 |
| `catalog`(PublishedModel/ModelRoute/Discovery) | `owl-pool/src/catalog` | 3 |
| `gateway`(OpenAI 兼容控制器/路由/SSE/Sticky/续接/调用日志) | `owl-pool/src/gateway`(逻辑)+ `pool-server/src/http/gateway-api`(协议端点) | 3 |
| `gateway` 上游适配(`*UpstreamChatClient`/`*ProtocolMapper`)+ `codex` + `mimo` + `bridge`(Java 侧) | `pool-server/src/upstream` | 4 |
| `bridge/*.mjs`(Node 桥本体) | `pool-server/bridge/` **平移不改**(进程模型 stdio JSON 行不变) | 4 |
| `billing`(钱包/预占结算/账本/价格)+ `KeyBudget` | `owl-pool/src/billing` | 5 |
| `member`(成员门户/自助 Key/并发)+ `diagnostics` | `owl-pool/src/member` 等 | 5 |
| `schedule.BackupScheduler` + `tools`(备份/恢复) | `pool-server/src/backup`;新增「备份 zip → SQLite 导入器」替代 H2/PG 迁移器 | 5/6 |
| `static/`(管理台/成员台前端 1.8 万行) | **不移植**,由 owl 桌面端原生 ManagerTab 重写 | 6 |
| `HomePageController` / 静态页 | 不需要(入口就是 owl 桌面) | — |

## 6. REST API 兼容清单(按阶段)

统一响应体沿用 `ApiResponse{ok, data, error, code}`;业务错误走错误码(如 `checkin.notSupported`)。
鉴权层级(阶段 2 起):网关 Key 只拦 `/v1/*`;管理端拦 `/api/*`(`/api/member/*` 例外);成员端拦 `/api/member/*`。

**阶段 1(已列入本次交付)**
- `GET /healthz`(无鉴权:`{status, db, uptimeSeconds}`,db 不可达 503)
- 账号:`GET/POST /api/accounts`、`GET/PUT/DELETE /api/accounts/{id}`、`PATCH /api/accounts/{id}/enabled`
- 签到:`POST /api/checkin/all`、`POST /api/checkin/accounts/{accountId}`、`GET /api/checkin/records`、`DELETE /api/checkin/records/{id}`、`DELETE /api/checkin/records`

**阶段 2**:管理端 `login/logout/setup/session/password`;账号 `ping`、`credits/refresh`、浏览器授权(`auth/login|status|cancel|input`);备份 `GET /api/backups/status`;凭证健康 `/api/credentials/*`。

**阶段 3**:Key `GET/POST /api/keys`、`PATCH /api/keys/{id}(/enabled)`、`DELETE(软/永久)`、`GET/PUT /api/keys/{id}/budget`;模型目录 `/api/models/*`(上架/发现/同步/核验);网关审计 `/api/gateway/*`(status/logs/usage*/stream)。

**阶段 4**:网关对外 `POST /v1/chat/completions`、`GET /v1/models`、`POST /v1/messages(+count_tokens)`、`POST/GET/DELETE /v1/responses(/{id})`;诊断 `/api/model-diagnostics/*`。

**阶段 5**:计费 `/api/billing/*`(rates/rate-drafts/wallets/ledger);成员管理 `/api/members/*`;成员自助 `/api/member/*`(login/overview/keys/usage/billing/playground/concurrency)。

偏离记录：
- 账号接口的凭证脱敏暂用「字符串值一律打码为 `***`」，PUT 时值为 `***` 的键视为保持原值；阶段 2 移植 manager `AccountResponse` 后替换为按平台精细脱敏。
- `GET /api/checkin/records` 追加可选 `?limit=`（manager 固定 50）。
- 错误码→HTTP 状态映射先按码后缀实现（`*notFound`→404 等），阶段 2 对照 GlobalExceptionHandler 校正。
- 管理端 Cookie 名为 `owl_pool_admin`（manager 是 `loean_admin`）：客户端是全新的 owl 桌面端，无兼容负担；其余鉴权语义逐条对齐。
- 环境变量统一 `OWL_POOL_*` 前缀（`OWL_POOL_ADMIN_*` 对应 `MANAGER_ADMIN_*`，`OWL_POOL_TRUSTED_PROXY_COUNT` 对应 `manager.security.trusted-proxy-count`）。
- 限流三层（§8#7）在 manager 里本就挂在网关过滤器（`/v1/*`），故随阶段 3 网关交付，不在阶段 2。
- 管理员凭据存储沿用 manager 的 `admin_credentials` 单行表（SQLite 实现），salt/派生值与 Java 版字节兼容，凭据可直搬。
- resolve 的账号级过滤（WorkBuddy/Trae 模型快照、SDK bridge 能力、工具续接 ContinuationRegistry、Qoder 特例）随阶段 4；目录级容量判定（discovered 容量表）已就位——发现同步（ModelDiscoveryService）在阶段 4，现阶段容量经管理端/SQLite 直填。
- sticky 存储默认进程内存（manager 有 Redis 选项）；团队部署需要共享亲和时补 Redis 实现。
- Grok 上游已移植（近透传 + SSE 转发，usage 口径显式请求 include_usage）。
- 阶段 4A 已交付：ZCode/Claude 上游（Anthropic 协议兼容客户端：三通道端点、OAuth beta 头与 claude-cli 身份头、thinking 预算注入、缓存折算、流解码器）与对外 `/v1/messages`、`/v1/messages/count_tokens`（AnthropicStreamBridge 流桥、协议错误体、count_tokens 粗算）。
- 阶段 4A-2 已交付：WorkBuddy 上游（仅 SSE→OpenAI chunk 本地转换、收尾 chunk 承载 finish+usage、渠道铁律头、指纹键递归剥除、hy3* 缺省思考档 high、非流式=流式聚合）与 Trae 上游（GetUserToken 换 JWT、完整 agent 身份头组、SOLO 自定义事件 output/token_usage/done/error、done+产出双完整性门槛、functionFor 注入钩子）。
- 阶段 4A-3 已交付：Gemini 上游（generateContent 协议映射全量：systemInstruction/contents 角色映射/functionCall 与 functionResponse 反查/thought→reasoning_content/thoughtsTokenCount 计入 completion、toolConfig、仅 data:URL 内联图；alt=sse 流解码器要求显式 finishReason；RESOURCE_EXHAUSTED→RATE 换号）。**阶段 4A 完成，网关已覆盖 manager 全部 HTTP 直连平台（WORKBUDDY/TRAE/ZCODE/CLAUDE/GEMINI/GROK）**。
- 阶段 6 首步已交付：owl 桌面 Rail「号池 Manager」按钮（独立窗口打开 pool-server 管理台，OWL_MANAGER_URL 可覆盖）+ 工作台 Manager tab（WebView 嵌入，healthz 探活空态）；原生面板按域渐进替换。
- 阶段 4B-1 已交付：SDK 桥运行时——manager 的 bridge/*.mjs 原样平移（bridge/ 独立包 + 依赖锁）+ TS 移植 SdkRuntimeClient（环境白名单清洗、4MiB 帧上限、终端事件摘除、shutdown→杀树→工作区清理）+ SdkBridgeManager（凭据指纹复用、home 根防逃逸、30s 空闲回收）+ SdkBridgeChatClient（回合事件队列、text_delta 流式、tool_call 即 DEFERRED 段 usage -1 哨兵、错误码→受控故障映射）；CURSOR/COPILOT/QODER 三平台进网关。
- 4B 余量：codex/mimo 运行时、Responses 协议、模型发现同步、Claude OAuth token 刷新（现 OAuth 账号直接使用存量 accessToken）、WB/Trae 账号模型快照域、工具续接的暂停恢复（现 DEFERRED 即取消回合，下轮全量重放，见偏离记录）。
- 计费预占（BillingGuard/admission 并发租约）不在阶段 3：manager 中管理员自有 Key 本就不计费，成员钱包预占随阶段 5。

## 7. 数据与迁移策略

- SQLite 建表沿用 manager 的表名与列名(驼峰→snake_case),阶段只建当前域的表:`accounts`、`check_in_records`,后续域随阶段补表。
- 时间列用 INTEGER(epoch 毫秒);布尔用 INTEGER 0/1;BigDecimal 用 TEXT/REAL(金额列用 TEXT 保精度,阶段 5 定)。
- **割接桥**:manager 的每日备份 zip 内每表一个 `<表名>.jsonl`(ISO-8601 时间)。阶段 6 写导入器:解压 → 逐表类型转换(时间→ms、布尔→0/1)→ 灌入 SQLite,幂等(非空表拒绝或 `--force` 跳过,对齐 manager 语义)。割接当天停 Java → `sqlite3` 导入 → 起 pool-server。
- 回滚:Java 版保留至割接稳定;SQLite 文件整体可备份,风险可控。

## 8. 安全与韧性加固对照表(重写不得丢失)

| # | manager 机制 | 重写落点 | 阶段 |
|---|---|---|---|
| 1 | `AdminGuard` Controller 层兜底鉴权(过滤器失效仍拦截);自救模式仅回环 | `security/admin-guard`(过滤器层 + requireSession 双层) | **2 已做** |
| 2 | `AdminAuthFilter` 白名单仅 login/logout/setup/session;`X-Admin-Key` 常量时间比较 | `security/admin-guard`(ANONYMOUS_ADMIN_ENDPOINTS 精确匹配) | **2 已做** |
| 3 | 登录失败锁定(IP+用户名),计数写透磁盘 JSON,重启不重置;10 次/10 分钟;用户名维度阈值 5 倍跨 IP 聚合 | `security/lockout` | **2 已做** |
| 4 | 会话持久化(只存 SHA-256),重启不掉线;删文件强制下线;TTL 12h | `security/admin-service` + `security/snapshot-file` | **2 已做** |
| 5 | PBKDF2-HMAC-SHA256 加盐口令(120k 迭代,与 Java 凭据字节兼容);`sourceFingerprint` 防凭据搬家 | `security/crypto` + `security/admin-service` | **2 已做** |
| 6 | `ClientIpResolver` 全站唯一 IP 结论;`trusted-proxy-count=0` 不信 XFF | `security/client-ip` | **2 已做** |
| 7 | 限流三层:全局 600/min(可 Redis)→ 单 IP 300/min → 单 Key | `security/rate-limit`(挂在网关过滤器,manager 亦然) | 3 |
| 8 | Key 明文只出现一次、库存 SHA-256;吊销与停用分离;IP 白名单 CIDR | `owl-pool/src/apikey` | 3 |
| 9 | 请求体按实际字节限 32MB(不信任 Content-Length) | `pool-server/src/http/body.ts` | **1 已做** |
| 10 | `GatewayAdmission` 并发租约(有界排队) | `owl-pool/src/gateway` | 3 |
| 11 | 非回环绑定且无 TLS 启动告警;默认绑 127.0.0.1 | `pool-server/src/index.ts` | **1 已做(绑定)** |
| 12 | `Masker`/`UpstreamMessages` 凭证与上游消息脱敏收口 | `owl-pool/src/common` | **1 起随用随移植** |
| 13 | bridge 子进程 env 白名单清洗、auth-home 隔离、授权域名白名单 | bridge 平移,天然保留 | 4 |
| 14 | 告警 webhook(dedupKey 12h 抑制)+ 凭证临期巡检(warn 7d/critical 1d) | `pool-server/src/alert` | 4 |
| 15 | WorkBuddy authFile 读取白名单(官方文件名 or 配置根目录) | `owl-pool/src/checkin/providers/workbuddy` | **1 已做** |
| 16 | 备份一致性快照 + 轮换;调用日志 90 天分批清理 | `pool-server/src/backup`、`gateway` janitor | 5/3 |

## 9. 阶段计划与验收标准

| 阶段 | 内容 | 验收 |
|---|---|---|
| **0 骨架（已交付）** | owl-pool 包 + pool-server 服务壳 + healthz + SQLite 建表 + 构建测试接线 | `npm run build / check / test` 全绿；`/healthz` 返回 db 状态 |
| **1 账号+签到（已交付）** | 账号 CRUD、WorkBuddy/Trae 签到 Provider(含 9074 风控换号)、签到服务(单号/全量/补签判定)、记录、每日定时 | Provider 测试覆盖成功/已签/未开启/鉴权失败/风控重试/HTML 拦截;REST 冒烟测试 |
| **2 鉴权与安全（已交付）** | §8 的 1-6 项（管理端全套：setup/login/logout/session/password、守卫接入 `/api/**`、补签挂钩登录） | 锁定（双维度+快照恢复）/会话持久化（TTL/重启）/口令强度各有测试；非回环绑定需鉴权就绪 |
| **3 Key+模型+OpenAI 网关（已交付）** | Key 域（哈希/IP 策略/思考策略/成员子 Key 继承）、模型目录（CapabilityRequest/档位刻度/resolve 路由收敛）、`/v1/chat/completions` 流式+非流式、`/v1/models`、认证链（全局/IP/Key 限流+白名单）、号池路由（积分加权/冷却分级落库/sticky/换号≤3）、调用日志、Grok 上游 | 域测试 + mock 上游全流程（sanitize/SSE/[DONE]/换号/冷却/日志） |
| 4 全上游+全协议 | Anthropic/Responses 协议、ZCode/Claude/Gemini/Grok/WorkBuddy/Trae chat 客户端、bridge/codex/mimo 运行时、诊断 | 三协议一致性测试;bridge 冒烟 |
| 5 计费+成员+备份 | 预占/结算/REVIEW/Janitor、成员门户、备份恢复 | 计费用例逐条对照 Java(动钱,测最狠) |
| 6 桌面端+割接 | owl 桌面 ManagerTab(最左侧入口)、备份 zip 导入器、数据割接 | owl 内全功能可用;生产数据完整迁入;Java 退役 |

## 10. 风险与对策

- **隐藏行为丢失**(最大风险):对照验收 + 移植必读 Java 源码,不看二手概要;§8 对表销号。
- **上游接口漂移**:签到/网关接口来自逆向,官方随时变更——重写期行为以 Java 版线上表现为准,发现漂移两边都要修。
- **SQLite 并发写**:团队模式多 Key 并发调用日志写入,WAL + 单写线程;若日后不够,Repository 接口换 PG 实现,领域层不动。
- **金额精度**:人民币计费用BigDecimal,TS 侧金额一律以「分」或字符串运算,禁止 float 直接参与(阶段 5 细化)。
- **双跑漂移**:并行期 Java 仍是生产,TS 版禁接生产数据;割接一次性切换,不做长期双写。
