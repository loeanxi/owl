# Owl 更新日志

<!--
每次提交都要在本文件补条目，pre-commit 会检查（规则见 COMMIT_SPEC.md「更新日志」一节）。
- 按日期分组，最新日期在最上面：`## YYYY-MM-DD`
- 日期下按类别分组，只用这五个，顺序固定：新增 / 改进 / 修复 / 移除 / 维护
- 条目：`- `scope` 一句话说明`，scope 与提交信息一致；跨包改动省略 scope
- 当天同类别标题已存在时追加到末尾，不要重复建标题
桌面端「设置 → 更新日志」构建时读取本文件。
-->

## 2026-10-15

### 修复

- `desktop` 启动时桥还没连上导致的空白：头像、左下角账号与用量概览首发失败后每 3 秒重试，不再定格在占位或「统计中」

## 2026-10-14

### 新增

- `owl-life-guide` 人生指南检索接入《程序员延寿指南》：life_guide_search 支持 guide 与 longevity 双数据源，按关键词/小节/单条查询全因死亡率长寿清单
- `desktop` 人生指南面板增加「程序员延寿指南」标签页：单篇 README 长文、小节目录筛选与跳转，jsDelivr 拉取与本地缓存
- `coding-agent` 桥重启后自动续跑被打断的会话：已完成的工具结果按检查点补回、不确定的调用只标记不重跑，排队消息与运行计时跨重启保留
- `desktop` 重启后回到原来的位置：会话、侧栏页面、设置分区、研究工作台与滚动位置按账号恢复；灵动岛保留进行中的任务、完成提醒与未发完的回复

### 改进

- `desktop` Token 生涯看板改版：趋势可切 30 天 / 90 天 / 今年 / 全部（长范围按周聚合），可按 Agent 筛选，新增年度热力图、输入输出与缓存构成和估算费用
- `desktop` 窄窗口与开着工作台时界面不再挤压重叠：标题栏灵动岛独占一列、900px 以下菜单收进「更多」，输入框、对话头与会话侧栏按所在列宽自适应
- `desktop` 生命监护独立页改为「设置 → 诊断」按需体检：标题栏只在有异常时提醒，异常项置顶并给出去处，可复制报告；后台改为 5 分钟一轮，Loean 等内置供应商不再误报「没有地址」，未配置的功能不算异常
- `desktop` 插件市场数千条列表切换选中、筛选不再卡顿：行组件按需重渲染，分类计数一次算好，屏幕外的行跳过布局与绘制
- `desktop` 资讯信源与设置改版：粘贴网站首页或 RSS 地址自动识别订阅源，信源按有问题 / 正常 / 已关闭分组并用大白话说明出错原因；设置收拢为自动采集、模型、精选多少、采集频率与按需显示的密钥

### 修复

- `pool` WorkBuddy 1M 窗口会话不再降级到 200k 通道；上下文估算去掉 Loean 的 2 倍系数，600k 请求不会被提前压缩
- `owl-career` MiniMax Code 用量改读 ~/.minimax 会话目录，旧名 ~/.mavis 的目录联接不再让同一批文件重复计数
- `desktop` 对话「工作过程」只有当前运行的最后一段显示进行中：已结束的段不会因残留的运行中工具复活，暂停后续跑从续跑时刻重新计时，空闲排队消息不再凭空出现进行中行

## 2026-10-13

### 新增

- `coding-agent` 研究任务记录来源摘录、缺失材料与工具和模型目录匹配，支持已有产物独立检查，组件检查通过不会标记原目标完成
- `desktop` 研究工作台增加实时与恢复的任务卡，区分用户声明、模型回复和组件检查，继续使用统一任务入口
- `desktop` 子智能体可在主区只读打开查看活动记录，对话区入口切换同会话的其它子智能体；产物卡片归到产生它的那一轮
- `desktop` 支持多账号，各账号会话、设置与模型凭据独立，可设密码切换；左下角头像菜单与个人主页
- `pool` Trae 账号可扫描导入本机 IDE 凭证并自动续期，凭证 JSON 整段粘贴自动分字段

### 改进

- `desktop` 界面颜色收敛为主题角色变量，终端、号池 Manager 与预览跟随主题与壁纸配色切换；号池站点嵌入时跟随 Owl 外观

### 修复

- `coding-agent` 研究检查点与反编译工具参数 schema 扁平化为单个 object，校验失败报错附可照抄 JSON 模板，弱模型空参数不再连发失败
- `coding-agent` 纯思考响应截断后逐级增加输出额度并携带有限工作草稿自动续跑，保持思考等级，连续截断不再自动中止
- `coding-agent` 长任务默认取消总轮数上限，agentMaxTurns 支持 0 表示无限，显式轮数预算继续生效
- `coding-agent` 上游确认的上下文窗口作为声明上限，WorkBuddy 按上游口径估算以便提前压缩，溢出时提示已开始压缩
- `coding-agent` 研究任务支持中英文自有声明，另开任务保留附件与图片摘要，并区分当前输入和历史条件，避免把旧拒绝套在新的正常任务上

### 维护

- `repo` 新增工具 schema 契约检查脚本与约定文档，拦截 anyOf-of-objects 参数与缺模板报错

## 2026-10-12

### 新增

- `coding-agent` 研究工作台接入 REA 静态分析、运行规则与进度检查点、失败诊断和提示词管理
- `desktop` 会话栏与主区收进统一工作区框，对话列加宽，工具行显示退出码
- `desktop` 定时任务新会话可指定模型，Agent 报错时记为失败
- `coding-agent` 提示词要求并行发起独立工具调用并限制调查规模
- `owl-safety-net` 拦截会改写共享工作区的 git stash
- `ai` 显式拒答保留原文并按失败结束，不再重试或当作上下文溢出
- `desktop` 设置新增「更新日志」分区，按日期与类别展示仓库更新记录
- `desktop` 外观新增液态玻璃与毛玻璃预设，桌面壳可切换清透、轻雾、亚克力窗口背板
- `owl-github` 新增 GitHub 工具插件，经本机 gh 操作 PR、Issue、Actions 与 Release
- `desktop` 变更侧栏新增提交历史视图，可看提交详情、推送分支并查看 GitHub CI 状态
- `desktop` 上下文页重做为统计、趋势、上下文浏览器与事件文件活动，可逐步下钻原文
- `desktop` 任务清单移到对话区右上角，工具行区分守卫拦截与非零退出，状态行显示输出速度
- `desktop` 研究工作台的当前项目与主会话分开记录，切换互不带动；置顶会话不再在其它分组重复出现
- `desktop` 我的助理改为对话为主、日程浮层可展开，顶部显示今日剩余与下一项
- `owl-career` Token 生涯秒开上次快照并后台增量刷新，Cursor 用量改拉官方接口

### 改进

- `desktop` 桌面桥模型与认证请求外移为独立 handler

### 修复

- `coding-agent` print 模式被守卫中止时输出原因并以失败退出
- `coding-agent` 编辑前必读在文件未变时跨轮次有效，结构化 oldText 给出可执行报错
- `coding-agent` 覆盖写入前必读只拦 write，cat 输出与自身编辑也算读过；read 按 wc -l 计行，中文破折号可匹配
- `coding-agent` bash 的 grep 无匹配、diff 有差异等答案型非零退出不再标为错误，Shell 补 Maven 路径与 UTF-8 locale
- `owl-safety-net` Git Bash 用 /d/ 写法 cd 进工作区时不再误判为离开工作区
- `coding-agent` 研究检查点有未解决 blockers 时不能标记完成，反编译与发布参数报错指明缺漏

### 维护

- `repo` 桌面端与 Office 插件测试接入 CI，coding-agent 按已知失败清单判定
- `repo` 每次提交须同步补充更新日志，pre-commit 校验

## 2026-10-10

### 新增

- `pool` WorkBuddy 积分记录到期时间，选号优先消耗临期积分
- `evaluation` 新建测评选模型时可按供应商筛选

### 改进

- `desktop` 地图、壁纸、生命监测与 Token 生涯拆成独立桥插件包

### 修复

- `desktop` 外链改走侧边栏或系统浏览器，不再把主窗口导航走
- `models` 同 ID 覆盖内置模型时保留未声明的能力字段，设置页可勾选识图

## 2026-10-09

### 新增

- `desktop` 构建指纹对齐与状态写盘可靠性加固

## 2026-10-08

### 新增

- `git` 忽略规则更新
- `desktop` 人生监测对话、拖入附件与本地图片权限
- `pool` 网关计费事务、缓存结算与账号额度
- `desktop` 请求轮次预算、浏览器填表与审批同步
- `desktop` 更换桌面应用图标
- `desktop` 启动时拉起号池，托盘可重启后台服务
- `ai` 接入 Cursor Provider，设置页支持多账号与启用模型过滤
- `desktop` 壳层接上置顶栏、自适应面板与镜像协议
- `desktop` 镜像投影、帧投递与捕获增强
- `desktop` 会话与工作台面板按容器自适应
- `desktop` 图标栏支持置顶功能入口
- `pool` 计费管理端、费率草稿与 PG 导入脚本
- `pool` 管理台静态资源与站点路由

### 改进

- `desktop` 桌面桥请求分发按域拆分并外移 handler

### 修复

- `desktop` 读取目录返回浅层列表，不再当作改文件证据
- `pool` 原生空缓存保留已验证读数，TRAE 与 CODEX 丢掉输出上限
- `pool` 无效或重叠用量改为未知，不再沿用估算
- `ai` 额度与未知用量错误不再当成临时故障重试
- `desktop` 人生监测文案与专家面板小修
- `ai` loean 默认网关改指向 pool-server

### 维护

- `pool` 补上桥接用量重叠与缺失的完整性检查

## 2026-10-07

### 新增

- `pool` 账号登录探活与上游模型目录发现
- `pool` Codex、Claude token 与工具续接钉号
- `pool` 成员登录、自助 Key 与预算接口
- `desktop` Manager 原生面板 + CORS + SPA 重写 + MiMo + 备份（阶段 5/6 主体）
- `pool` manager→owl 数据迁移脚本（PG JSONL → SQLite）
- `desktop` Manager 面板原生 React 化 + pool-server CORS（阶段 6 主体）
- `desktop` 壳层接上预设、分享、队列、定时任务和工作台
- `desktop` 会话里可以看任务轨迹
- `desktop` 加上插件市场页
- `desktop` 加上我的助理页
- `desktop` 加上专家顾问页
- `desktop` 加上八股对练页
- `desktop` 项目页按保留目录过滤工作区
- `desktop` 人生指南加上可上翻的阅读页
- `desktop` 助理、专家和八股目录不再冒充普通项目
- `desktop` 人生监测按通道探活并给出状态
- `desktop` 汇总本机各 Agent 的 Token 生涯
- `desktop` 定时任务到点把提示词送回会话
- `desktop` 会话导出可以按轮勾选后再分享
- `coding-agent` 会话可以绑定 Agent 预设并记住默认项
- `coding-agent` 排队消息可以单条删掉或提前到当前轮
- `pool` 移植 MiMo 对话上游客户端
- `pool` 管理台单页（根因修复：Manager 窗口 404）
- `desktop` 左侧竖栏新增号池 Manager 按钮（阶段 6）
- `desktop` 侧栏新增号池 Manager tab（迁移阶段 6 首步）
- `pool` 备份快照与 manager 备份导入（迁移阶段 5b：数据割接桥）
- `pool` 人民币计费核心（迁移阶段 5a：钱包/账本/费率 + 网关预占结算）
- `pool` SDK 桥运行时（迁移阶段 4B-1，CURSOR/COPILOT/QODER 进网关）
- `pool` Gemini 对话上游（迁移阶段 4A-3，4A 收官）
- `pool` WorkBuddy/Trae 对话上游（迁移阶段 4A-2）
- `pool` ZCode/Claude 上游与 Anthropic 协议端点（迁移阶段 4A）
- `pool` API Key + 模型目录 + OpenAI 网关（manager 迁移阶段 3）
- `pool` 管理端鉴权与安全基座（manager 迁移阶段 2）
- `pool` 新增 owl-pool 领域包与 pool-server 服务壳

### 修复

- `desktop` Manager 面板改为 iframe 嵌入完整管理台 SPA（最稳方案）
- `desktop` Manager 改为 iframe 嵌入完整管理台（含登录/全部功能）
- `desktop` Manager 面板去掉懒挂载状态，改为直接条件渲染
- `desktop` 号池 Manager 白屏三根因修复（render-phase setState / CORS / SPA 转义）
- `pool` Manager 嵌入视图三连修 + MiMo 接线补全（阶段 4B/6）
- `coding-agent` 新建多级目录时补回被丢掉的中间段
- `coding-agent` 助手承诺记住之后允许当轮写入长期记忆
- `coding-agent` Windows 子进程补上用户级 Python 和 UTF-8
- `coding-agent` 工具参数报错只留可执行修正，edit 合并松散续写
- `pool` 清掉全仓检查里的未使用符号
- `desktop` 号池 Manager 按钮改用 WebviewWindow 并补创建权限

### 维护

- `repo` 放宽模板字符串规则，并写明改完要过类型检查
- `pool` 迁移文档补记阶段6桌面入口交付

## 2026-10-06

### 新增

- `desktop` 会话可引用文件、排队跟进并阅读人生指南
- 增加桌面操作与人生指南两个工作区包
- `coding-agent` 启动时安装内置 html-plan 技能
- `coding-agent` 桌面操作语句能检索到 computer 工具
- `coding-agent` 技能可声明必须随其他技能读取
- `desktop` 桌面壳改成灵动岛和双面板，会话可导出并支持暂停继续
- `desktop` 改动卡点文件名在编辑器内高亮待审改动并滚动定位

### 修复

- `coding-agent` 只读探路的非零退出不当成命令失败

## 2026-10-05

### 新增

- `desktop` 回答行展示本轮累计用量,输入框缩略图可点开大图
- `desktop` 桌面端源码更新检查与调试重建入口
- `desktop` 地图工作区重做为地图视图与对话双视图
- `ai` 新增 loean 动态目录厂商并补启动自愈刷新
- `coding-agent` 逆向反编译的代码恢复与质量证据
- `coding-agent` 桌面按需工具与技能发现、验收清单与能力证据

### 修复

- `desktop` 概览热力图铺满最近半年空日
- `owl-genui` 结构化 UI 卡片改为按需,普通回答直接用 Markdown
- `coding-agent` 记忆合并的作用域、上下文工具口径与资讯证据

### 维护

- `repo` 移除自动提交钩子并新增提交规范
- `coding-agent` 测试里字符串拼接改为模板字符串
- 修正 AGENTS.md 里已过时的启动器路径说明
- `coding-agent` 补 genui 工具收敛与桌面用量的 CHANGELOG 条目
- 修正 pre-commit 注释里 npm run check 的方位表述

## 2026-10-04

### 修复

- 移除 pre-commit 中失效的 browser smoke 分支
