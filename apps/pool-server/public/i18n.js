/* loean 站点语言层（T1）。
 *
 * 设计约定（改动前先读这一段，否则很容易踩坑）：
 *  1. 词表是「扁平 key」，形如 { "home.hero.title": { zh, en } }；key 全局唯一、便于全文搜索。
 *  2. 插值用具名占位符 t("key", { name }) → 词表里写 {name}；
 *     禁止把一句话拆成两半再拼（中英语序不同，拼出来会像机翻）——
 *     条件分支请各写成一条完整句子的 key，不要拼半句。
 *  3. 复数暂不引 ICU：确需变格时手写 "x.one" / "x.other" 两条 key。
 *  4. 装饰性品牌字（ONE STATION 等）与产品专名（OpenAI / Trae 等）不进词表，原地保留，
 *     避免出现 zh 与 en 完全相同的噪音条目。
 *  5. 防闪策略 C：HTML 里保留中文作为默认文本（禁 JS 也能读、SEO 也能读），
 *     JS 仅在「语言 ≠ zh」时替换，因此中文用户路径与改造前完全一致、零闪烁。
 *     代价是本文件必须在 <head> 里同步加载（不能加 defer），否则判定语言前已渲染中文。
 *
 * 覆盖范围：data-i18n / data-i18n-attr（属性）/ data-i18n-html（含标记的整块）。
 * 「整块替换」用于一条中文句子里夹着多个元素的场景，例如页脚。
 */
(function () {
  const STORAGE_KEY = "loean-ui-lang";
  const SUPPORTED = ["zh", "en"];
  const DEFAULT_LANG = "zh";

  /* ---------- 词表：本轮只覆盖首页（home.*） ---------- */
  const DICT = {
    "backup.title": { zh: "备份状态", en: "Backup status" },
    "backup.scope": { zh: "显示本次服务启动后的最近备份状态；历史备份是否可恢复需单独验证。", en: "Shows backup results since this server started. Historical restore capability must be verified separately." },
    "backup.unavailable": { zh: "暂时无法读取备份状态，请稍后刷新", en: "Backup status is unavailable. Refresh to retry." },
    "backup.lastSuccess": { zh: "本次启动后最近完整备份：{time}", en: "Last complete backup since startup: {time}" },
    "backup.files": { zh: "归档 {count} 个文件，跳过 {skipped} 个文件", en: "{count} files archived; {skipped} files skipped" },
    "backup.issues": { zh: "发现 {count} 项问题，请检查备份日志、磁盘空间及目录权限。", en: "{count} issues found. Check backup logs, disk space and directory permissions." },
    "backup.state.NEVER_RUN": { zh: "本次启动后尚未执行", en: "Not run since startup" },
    "backup.state.DISABLED": { zh: "自动备份已关闭", en: "Automatic backups disabled" },
    "backup.state.RUNNING": { zh: "备份正在执行", en: "Backup running" },
    "backup.state.SUCCESS": { zh: "备份完整完成", en: "Backup completed" },
    "backup.state.PARTIAL": { zh: "备份部分完成，需要处理", en: "Backup partially completed" },
    "backup.state.FAILED": { zh: "备份失败，需要处理", en: "Backup failed" },
    "backup.archive.SUCCESS": { zh: "已归档", en: "Archived" },
    "backup.archive.PARTIAL": { zh: "归档不完整", en: "Partial archive" },
    "backup.archive.FAILED": { zh: "归档失败", en: "Archive failed" },
    "backup.archive.NOT_PRESENT": { zh: "目录尚未使用", en: "Directory not in use" },
    "diagnostic.tab": { zh: "实测诊断", en: "Live diagnostics" },
    "diagnostic.intro": { zh: "对指定账号和模型进行实际调用，记录通过项目、失败原因及检查时间。结果与人工能力核验分别保存。", en: "Test a specific account and model. Keep check results, failure reasons and timestamps separate from manual capability verification." },
    "diagnostic.configure": { zh: "选择检查范围", en: "Configure checks" },
    "diagnostic.account": { zh: "账号", en: "Account" },
    "diagnostic.chooseAccount": { zh: "请选择账号", en: "Select an account" },
    "diagnostic.accountReady": { zh: "{platform} · 本轮仅使用这个账号", en: "{platform} · Only this account is used" },
    "diagnostic.accountDisabled": { zh: "{platform} · 账号已停用，可查看历史记录", en: "{platform} · Disabled account; history remains available" },
    "diagnostic.disabled": { zh: "已停用", en: "Disabled" },
    "diagnostic.model": { zh: "平台模型名称", en: "Upstream model" },
    "diagnostic.modelPlaceholder": { zh: "例如：模型目录中的实际模型名称", en: "Exact model name from the catalog" },
    "diagnostic.timeout": { zh: "每项超时（秒）", en: "Timeout per check (seconds)" },
    "diagnostic.cases": { zh: "检查项目", en: "Checks" },
    "diagnostic.case.TEXT": { zh: "文本回复", en: "Text response" },
    "diagnostic.case.STREAM": { zh: "流式输出", en: "Streaming response" },
    "diagnostic.case.TOOLS": { zh: "工具调用", en: "Tool call" },
    "diagnostic.case.TOOL_CONTINUATION": { zh: "工具结果续接", en: "Tool continuation" },
    "diagnostic.case.IMAGE": { zh: "图片输入", en: "Image input" },
    "diagnostic.case.LONG_CONTEXT": { zh: "长上下文", en: "Long context" },
    "diagnostic.spend": { zh: "开始后会消耗所选账号的上游额度，不扣成员钱包。只使用固定测试内容和安全的模拟工具。", en: "Tests consume the selected account’s upstream quota, not a member wallet. They use fixed prompts and a safe simulated tool." },
    "diagnostic.start": { zh: "开始实测", en: "Run checks" },
    "diagnostic.cancel": { zh: "取消本轮检查", en: "Cancel this run" },
    "diagnostic.latestResults": { zh: "最近实测结果", en: "Latest check results" },
    "diagnostic.runResults": { zh: "本轮检查结果", en: "Run results" },
    "diagnostic.runSummary": { zh: "{account} · {model} · {status} · {time}", en: "{account} · {model} · {status} · {time}" },
    "diagnostic.latestHint": { zh: "选择账号和模型查看最近检查。通过某一项不代表其他能力也已确认。", en: "Select an account and model to see recent checks. Passing one check does not verify other capabilities." },
    "diagnostic.notChecked": { zh: "尚无这项检查的实测结果", en: "No recorded result for this check" },
    "diagnostic.separateCheck": { zh: "本轮不检查此能力，需另行核验", en: "Not included in this run; verify separately" },
    "diagnostic.stale": { zh: "账号或模型信息已变化，请重新检查后再作为当前依据。", en: "Account or model details have changed. Run the check again for current evidence." },
    "diagnostic.historical": { zh: "历史结果", en: "Historical result" },
    "diagnostic.tokens": { zh: "输入 Token：{input} · 输出 Token：{output}", en: "Input tokens: {input} · Output tokens: {output}" },
    "diagnostic.history": { zh: "检查记录", en: "Run history" },
    "diagnostic.time": { zh: "发起时间", en: "Started" },
    "diagnostic.details": { zh: "查看结果", en: "View results" },
    "diagnostic.empty": { zh: "暂无符合条件的检查记录", en: "No matching check runs" },
    "diagnostic.chooseCases": { zh: "请至少选择一项检查", en: "Select at least one check" },
    "diagnostic.status.QUEUED": { zh: "等待开始", en: "Queued" },
    "diagnostic.status.PENDING": { zh: "等待检查", en: "Pending" },
    "diagnostic.status.RUNNING": { zh: "检查中", en: "Running" },
    "diagnostic.status.PASSED": { zh: "通过", en: "Passed" },
    "diagnostic.status.FAILED": { zh: "未通过", en: "Failed" },
    "diagnostic.status.NOT_TESTED": { zh: "未实测", en: "Not tested" },
    "diagnostic.status.CANCELLED": { zh: "已取消", en: "Cancelled" },
    "diagnostic.status.TIMED_OUT": { zh: "超时", en: "Timed out" },
    "billing.currencyName": { zh: "人民币 (CNY)", en: "Chinese yuan (CNY)" },
    "billing.restartShort": { zh: "服务待重启", en: "Server restart needed" },
    "billing.thInputRate": { zh: "输入（元/百万 Token）", en: "Input (CNY / 1M tokens)" },
    "billing.thOutputRate": { zh: "输出（元/百万 Token）", en: "Output (CNY / 1M tokens)" },
    "billing.thCacheReadRate": { zh: "缓存读取（元/百万 Token）", en: "Cache read (CNY / 1M tokens)" },
    "billing.thCacheWriteRate": { zh: "缓存写入（元/百万 Token）", en: "Cache write (CNY / 1M tokens)" },
    "billing.cachePriceHint": { zh: "缓存单价可留空，表示未提供；填写 0 表示免费。", en: "Leave cache rates blank when unavailable; enter 0 only when free." },
    "billing.cachePriceLegend": { zh: "“—”表示未提供缓存单价；“¥0.00”表示免费。", en: "“—” means no cache rate is provided; “¥0.00” means free." },
    "billing.cacheChargingNote": { zh: "缓存用量可核实时按缓存价；仅能确认完整输入 Token 总数时按普通输入价；总数也无法确认时，按现有估算规则处理或进入待核对。", en: "Verified cache usage uses cache rates. If only the complete input token total is known, the standard input rate applies. If that total is also unknown, existing estimation rules apply or the charge is sent for review." },
    "billing.legacyAmount": { zh: "{amount} credit", en: "{amount} credits" },
    "billing.legacyBalanceNote": { zh: "历史测试余额（非人民币）", en: "Historical test balance (not CNY)" },
    "billing.legacyRecord": { zh: "历史测试记录（非人民币）", en: "Historical test record (not CNY)" },
    "member.models.mobileRates": { zh: "输入 {prompt} / 输出 {completion}（每百万 Token）", en: "Input {prompt} / output {completion} per 1M tokens" },
    "member.models.mobileCacheRates": { zh: "缓存读取 {read} / 缓存写入 {write}（每百万 Token）", en: "Cache read {read} / cache write {write} per 1M tokens" },
    "member.usage.deferred": { zh: "本轮待结算", en: "Turn settlement pending" },
    "pool.verifyTitle": { zh: "记录模型能力核验", en: "Record model capability verification" },
    "pool.verifyHint": { zh: "请完成真实联调后记录已确认的版本与能力，仅勾选已确认支持的能力。", en: "After actual integration testing, record confirmed version and capabilities. Select only confirmed capabilities." },
    "pool.verifyUnknownVersionHint": { zh: "真实联调后记录能力。上游只提供调用名、未公布实际版本时，版本留空即可；仅勾选已确认支持的能力。", en: "Record capabilities after actual integration testing. If the provider gives only a calling name and no actual version, leave the version blank. Select only confirmed capabilities." },
    "pool.verificationSource": { zh: "核验依据", en: "Verification source" },
    "pool.verify": { zh: "核验能力", en: "Verify capabilities" },
    "pool.verified": { zh: "已核验", en: "Verified" },
    "pool.invalidated": { zh: "核验已失效", en: "Verification invalidated" },
    "pool.unverified": { zh: "尚未核验", en: "Not verified" },
    "admin.usage.src.deferred": { zh: "本轮待结算", en: "Turn settlement pending" },
    "admin.usage.src.deferred.tip": { zh: "工具等待阶段，本轮结束后统一结算", en: "Waiting for tools; usage is settled when the turn completes" },
    "pool.authInput": { zh: "粘贴官方授权码或回调内容（可选）", en: "Paste the official authorization code or callback (optional)" },
    "pool.submitAuthInput": { zh: "提交授权内容", en: "Submit authorization input" },
    "pool.authInputSent": { zh: "已提交，等待官方授权结果", en: "Submitted. Waiting for authorization." },
    "pool.unknownVersionRequiresExactRoute": { zh: "版本未知时，每条已启用路由的平台模型名称都必须与公开调用名完全一致；其他路由可先保持未启用。", en: "When the version is unknown, every enabled route must use exactly the public model name. Other routes can remain disabled for review." },
    "pool.discoveryUnavailable": { zh: "最近同步未发现", en: "Not found in the latest sync" },
    "pool.discoveryAvailable": { zh: "最近一次发现", en: "Last discovered" },
    "pool.staticCandidate": { zh: "预置候选，需核验", en: "Preset candidate; verification required" },
    "pool.availableModes": { zh: "适用模式：{modes}", en: "Available in: {modes}" },
    /* Account pool expansion and public model capabilities. */
    "pool.nav": { zh: "模型管理", en: "Model management" },
    "pool.subtitle": { zh: "配置成员可选模型、能力与主备路由", en: "Configure public models, capabilities, and fallback routes" },
    "pool.loading": { zh: "正在加载…", en: "Loading…" },
    "pool.images": { zh: "图片输入", en: "Image input" },
    "pool.tools": { zh: "工具调用", en: "Tool calling" },
    "pool.reasoning": { zh: "推理等级", en: "Reasoning effort" },
    "pool.text": { zh: "文本对话", en: "Text chat" },
    "pool.capabilitiesUnknown": { zh: "能力待核验", en: "Capabilities need verification" },
    "pool.otherCapabilitiesUnknown": { zh: "其他能力待核验", en: "Other capabilities need verification" },
    "pool.upstreamMultimodal": { zh: "上游标记多模态", en: "Upstream marks multimodal" },
    "pool.capabilities": { zh: "能力", en: "Capabilities" },
    "pool.publicModel": { zh: "公开模型", en: "Public model" },
    "pool.count": { zh: "共 {total} 个模型配置 · 已上架 {published} 个 · 待上架草稿 {drafts} 个", en: "{total} model configurations · {published} published · {drafts} drafts" },
    "pool.contextValue": { zh: "上下文 {count} Tokens", en: "{count} context tokens" },
    "pool.priorityValue": { zh: "优先级 {priority}", en: "Priority {priority}" },
    "pool.published": { zh: "已上架", en: "Published" },
    "pool.draft": { zh: "未上架", en: "Unpublished" },
    "pool.publish": { zh: "上架", en: "Publish" },
    "pool.unpublish": { zh: "下架", en: "Unpublish" },
    "pool.batchPublish": { zh: "批量确认上架", en: "Review and publish selected" },
    "pool.batchPublishCount": { zh: "批量确认上架（{count}）", en: "Review and publish selected ({count})" },
    "pool.batchPublishHint": { zh: "只勾选已核对公开能力和平台路由的草稿。", en: "Select only drafts whose public capabilities and routes you have reviewed." },
    "pool.batchPublished": { zh: "已上架 {count} 个模型", en: "Published {count} model(s)" },
    "pool.batchPublishFailed": { zh: "本批模型均未上架：{message}", en: "None of the selected models were published: {message}" },
    "pool.selectVisibleDrafts": { zh: "选择当前列表中的所有未上架模型", en: "Select all visible unpublished models" },
    "pool.selectDraft": { zh: "选择未上架模型 {model}", en: "Select unpublished model {model}" },
    "pool.editExisting": { zh: "编辑已有模型", en: "Edit existing model" },
    "pool.addRouteToExisting": { zh: "添加备用路由", en: "Add backup route" },
    "pool.addPendingRouteToExisting": { zh: "添加待启用备用路由", en: "Add disabled backup route" },
    "pool.generateMissingDrafts": { zh: "补齐草稿和路由", en: "Fill missing drafts and routes" },
    "pool.generateMissingDraftsHint": { zh: "为所有平台已发现的新模型生成未上架草稿；同名已有模型会补充平台备用路由，若已上架则新路由保持未启用。原有名称、能力等配置不变。", en: "Create unpublished drafts for new models discovered across platforms. Add backup routes to existing same-name models; new routes on published models stay disabled. Existing names and capabilities remain unchanged." },
    "pool.draftsGenerated": { zh: "已补齐缺失草稿和同名平台路由，请到对应列表核对。", en: "Missing drafts and same-name platform routes have been filled. Review the corresponding lists." },
    "pool.draftGenerationFailed": { zh: "补齐草稿和路由失败：{message}", en: "Could not fill missing drafts and routes: {message}" },
    "pool.publicEmpty": { zh: "暂无已上架模型。请到“待上架草稿”核对并上架。", en: "No published models yet. Review and publish models under Drafts awaiting publication." },
    "pool.draftsEmpty": { zh: "暂无待上架草稿。同步可用模型后会自动生成，也可手动添加。", en: "No drafts awaiting publication. Sync available models to create them, or add one manually." },
    "pool.discoveredEmpty": { zh: "尚未发现模型。先添加并授权账号，再同步可用模型；也可手动添加。", en: "No models discovered. Add and authorize an account, then sync available models, or add one manually." },
    "pool.createFromDiscovered": { zh: "配置模型草稿", en: "Configure model draft" },
    "pool.route": { zh: "平台路由", en: "Platform route" },
    "pool.routes": { zh: "平台路由", en: "Platform routes" },
    "pool.removeRoute": { zh: "移除", en: "Remove" },
    "pool.actualModel": { zh: "平台模型名称", en: "Platform model name" },
    "pool.priority": { zh: "优先级（数字越小越优先）", en: "Priority (lower numbers first)" },
    "pool.efforts": { zh: "推理等级（不勾选表示不支持）", en: "Reasoning efforts (leave unticked if unsupported)" },
    "pool.effortNone": { zh: "none（关闭思考）", en: "none (no reasoning)" },
    "pool.newModel": { zh: "+ 手动添加模型", en: "+ Add model manually" },
    "pool.editModel": { zh: "编辑公开模型", en: "Edit public model" },
    "pool.editDraft": { zh: "编辑待上架草稿", en: "Edit unpublished draft" },
    "pool.invalidId": { zh: "请填写不含空格的公开模型名称。", en: "Enter a public model name without spaces." },
    "pool.needRoute": { zh: "上架前至少启用一条平台路由。", en: "Enable at least one platform route before publishing." },
    "pool.saved": { zh: "模型配置已保存", en: "Model configuration saved" },
    "pool.synced": { zh: "同步请求已完成，请核对各模型更新时间后上架。", en: "Sync request completed. Review each model’s last-seen time before publishing." },
    "pool.discoveryAttention": { zh: "模型同步提醒", en: "Model sync alert" },
    "pool.discoveryFailedAt": { zh: "{platform} 最近一次同步失败（{time}）：{message}。已保留上次成功的模型列表。", en: "{platform} sync failed at {time}: {message}. The last successful model list is retained." },
    "pool.discoveryRemoved": { zh: "{platform} 当前已启用账号的可见目录未发现 {count} 个曾记录模型：{models}", en: "{platform}: {count} previously recorded model(s) were not found in the latest visible catalog for enabled accounts: {models}" },
    "pool.discoveryAffected": { zh: "{platform} 请核查这些公开模型的路由：{models}", en: "{platform} public model routes to review: {models}" },
    "pool.discoverySyncFailed": { zh: "{platform} 同步失败：{message}。已保留上次成功的模型列表。", en: "{platform} sync failed: {message}. The last successful model list is retained." },
    "pool.discoverySyncStats": { zh: "{platform} 同步完成：较上次目录新增 {added}、减少 {removed}、未变化 {unchanged}。", en: "{platform} sync complete: {added} more than the previous catalog, {removed} fewer, {unchanged} unchanged." },
    "pool.discoveryAdded": { zh: "{platform} 此前新发现 {count} 个模型：{models}。请核验后手动上架。", en: "{platform} previously discovered {count} new model(s): {models}. Review them before publishing." },
    "pool.discoveryStatusUnavailable": { zh: "同步已执行，但读取同步状态失败，请刷新页面确认结果。", en: "Sync ran, but its status could not be loaded. Refresh to check the result." },
    "pool.discoveryUnknownReason": { zh: "未提供具体原因", en: "No reason provided" },
    "pool.routeUnavailable": { zh: "当前可见目录未发现", en: "Not found in the current visible catalog" },
    "pool.confirmDelete": { zh: "删除公开模型“{model}”？成员将无法再选择此模型。", en: "Delete public model “{model}”? Members will no longer be able to select it." },
    "pool.confirmDeleteDraft": { zh: "删除待上架草稿“{model}”？", en: "Delete unpublished draft “{model}”?" },
    "pool.publicTab": { zh: "公开模型", en: "Public models" },
    "pool.draftsTab": { zh: "待上架草稿", en: "Drafts awaiting publication" },
    "pool.draftModel": { zh: "待上架模型", en: "Model awaiting publication" },
    "pool.discoveredTab": { zh: "已发现模型", en: "Discovered models" },
    "pool.platformFilter": { zh: "平台筛选", en: "Filter platform" },
    "pool.allPlatforms": { zh: "全部平台", en: "All platforms" },
    "pool.sync": { zh: "同步可用模型", en: "Sync available models" },
    "pool.publicHint": { zh: "这里只展示已上架、可供已授权成员调用的公开模型。", en: "Only published models available to authorized members appear here." },
    "pool.draftsHint": { zh: "各平台新发现的模型会自动保存为未上架草稿。核对能力与平台路由后，可勾选并批量确认上架。", en: "Newly discovered models across platforms are saved as unpublished drafts. Review their capabilities and routes, then select and publish them together." },
    "pool.discoveredHint": { zh: "这里列出各平台已发现的模型。同名模型可补充备用路由；新草稿请在“待上架草稿”中核对和上架。", en: "Discovered models from every platform appear here. Same-name models can gain backup routes; review and publish new drafts under Drafts awaiting publication." },
    "pool.publicId": { zh: "调用时使用的模型名称", en: "Model name used in API calls" },
    "pool.displayName": { zh: "显示名称", en: "Display name" },
    "pool.description": { zh: "介绍", en: "Description" },
    "pool.version": { zh: "模型版本", en: "Model version" },
    "pool.versionOptional": { zh: "模型版本（可选）", en: "Model version (optional)" },
    "pool.versionPublishHint": { zh: "版本未公布时可留空；此时各平台已启用路由的模型名称须与公开调用名完全一致。", en: "If the version is unpublished, leave it blank; then every enabled platform route must use exactly the public model name." },
    "pool.publicEfforts": { zh: "对外支持的推理等级", en: "Public reasoning efforts" },
    "pool.publicEffortsHint": { zh: "这里勾选向 API 调用方承诺的等级；每一档都必须有已启用的路由实际提供。", en: "Tick the efforts promised to API clients. Every effort needs an enabled route that provides it." },
    "pool.routeEfforts": { zh: "此平台路由支持的推理等级", en: "Reasoning efforts supported by this route" },
    "pool.missingRoutesForEfforts": { zh: "对外填写的推理等级 {efforts} 没有已启用的路由支持。请修改对外等级，或添加确实支持这些等级的路由。", en: "No enabled route supports these public reasoning efforts: {efforts}. Adjust the public efforts or add routes that actually support them." },
    "pool.sort": { zh: "显示顺序", en: "Display order" },
    "pool.context": { zh: "上下文长度（Tokens）", en: "Context window (tokens)" },
    "pool.qoderDefaults": { zh: "Qoder CN 默认配置", en: "Qoder CN defaults" },
    "pool.qoderDefaultsHint": { zh: "可选。只在客户端未传对应参数时使用；选项来自当前已发现的 Qoder 模型。", en: "Optional. Applied only when a client omits the parameter. Choices come from the currently discovered Qoder model." },
    "pool.qoderDefaultReasoning": { zh: "默认思考强度", en: "Default reasoning effort" },
    "pool.qoderDefaultContext": { zh: "默认上下文窗口", en: "Default context window" },
    "pool.qoderFollowDefault": { zh: "沿用 Qoder 默认", en: "Use Qoder default" },
    "pool.qoderReasoningOff": { zh: "关闭思考", en: "Reasoning off" },
    "pool.qoderUnavailableChoice": { zh: "{value}（当前不可用）", en: "{value} (currently unavailable)" },
    "pool.qoderUnknownModel": { zh: "部分 Qoder 路由还未出现在已发现目录；请先同步模型后选择默认值。", en: "Some Qoder routes are missing from the discovered catalog. Sync models before choosing defaults." },
    "pool.qoderSomeOptionsUnknown": { zh: "目录尚未提供完整的可调范围；未列出的配置将沿用 Qoder 默认。", en: "The catalog has not provided every adjustable option. Unlisted settings use Qoder defaults." },
    "pool.qoderUnsupportedDefault": { zh: "所选默认值已不在当前 Qoder 模型的可调范围内，请重新选择或沿用 Qoder 默认。", en: "A selected default is no longer supported by the current Qoder model. Choose another value or use the Qoder default." },
    "pool.output": { zh: "最大输出（Tokens）", en: "Maximum output (tokens)" },
    "pool.addRoute": { zh: "+ 添加备用路由", en: "+ Add fallback route" },
    "pool.routeHint": { zh: "同一模型可配置多个平台备用路由，数字越小越优先。从“已发现模型”为已上架模型添加的路由先保持未启用，核对图片、工具及推理等级后再启用。", en: "The same model can use backup routes across platforms; lower numbers have priority. A route added to a published model from Discovered models stays disabled until you review its image, tool, and reasoning support." },
    "pool.keyModels": { zh: "允许使用的模型", en: "Allowed models" },
    "pool.allowAll": { zh: "全部上架模型（含以后上架）", en: "All published models, including future additions" },
    "pool.allowAllShort": { zh: "全部上架模型", en: "All published models" },
    "pool.allowSelected": { zh: "仅所选模型", en: "Selected models only" },
    "pool.allowedCount": { zh: "已授权 {count} 个模型", en: "{count} allowed models" },
    "pool.keyHint": { zh: "选择“仅所选模型”但不勾选时，该 Key 不能调用任何模型。", en: "Selecting no models in “Selected models only” blocks all model calls for this key." },
    "pool.login": { zh: "登录 / 重新授权", en: "Sign in / Reauthorize" },
    "pool.traeLogin": { zh: "登录 / 重新登录", en: "Sign in / Sign in again" },
    "pool.traeLoginRequired": { zh: "待登录", en: "Sign-in required" },
    "pool.traeManualAdvanced": { zh: "手动填写 session（备用）", en: "Enter session manually (fallback)" },
    "pool.saveAuthorize": { zh: "保存并授权", en: "Save and authorize" },
    "pool.loginFromList": { zh: "账号已保存，请在账号列表中点击登录。", en: "Account saved. Use Sign in from the account list." },
    "pool.accountHint": { zh: "可先保存账号再登录授权；也可填写官方 Token 或服务器上的凭证目录。编辑时留空保留原凭证。", en: "Save the account, then sign in. You can also supply an official token or a credentials directory on the server. Leave fields blank when editing to keep existing credentials." },
    "pool.traeAccountHint": { zh: "可留空 session，保存后在独立浏览器登录 Trae，系统会自动同步。编辑时留空保留原凭证。", en: "You can leave session blank, then sign in to Trae in a separate browser after saving. The session syncs automatically. Leave fields blank when editing to keep existing credentials." },
    "pool.runtimeHome": { zh: "凭证目录（服务器绝对路径，可空）", en: "Credentials directory (absolute server path, optional)" },
    "pool.runtimeHomePh": { zh: "留空由服务自动创建独立目录", en: "Leave blank to create an isolated directory automatically" },
    "pool.apiKey": { zh: "官方 Token（可选）", en: "Official token (optional)" },
    "pool.pat": { zh: "GitHub PAT（可选）", en: "GitHub PAT (optional)" },
    "pool.qoderCnPat": { zh: "Qoder CN 官方 PAT（可选）", en: "Qoder CN official PAT (optional)" },
    "pool.qoderCheckinPat": { zh: "Qoder CN 签到 PAT（可选）", en: "Qoder CN check-in PAT (optional)" },
    "pool.qoderCheckinPatPh": { zh: "从 qoder.cn/account/integrations 创建；填后可领取活动权益", en: "Create it at qoder.cn/account/integrations to claim campaign benefits" },
    "pool.cursorSessionToken": { zh: "Cursor 会话 Token（可选，用于实时额度）", en: "Cursor session token (optional, enables live quota)" },
    "pool.cursorSessionTokenPh": { zh: "留空则读取本机 Cursor 桌面端登录；也可粘贴浏览器 WorkosCursorSessionToken", en: "Leave blank to reuse the local Cursor desktop sign-in, or paste the browser WorkosCursorSessionToken" },
    "pool.tokenPh": { zh: "手动导入时填写，在线授权可留空", en: "Enter to import manually; leave blank for online sign-in" },
    "pool.authTitle": { zh: "授权账号 · {name}", en: "Authorize account · {name}" },
    "pool.authHint": { zh: "打开官方授权页面完成登录，再返回这里查看结果。授权状态每两秒更新。", en: "Open the official authorization page and complete sign-in, then return here. Status refreshes every two seconds." },
    "pool.traeAuthTitle": { zh: "登录 Trae · {name}", en: "Sign in to Trae · {name}" },
    "pool.traeAuthHint": { zh: "请确认独立浏览器窗口登录的是「{name}」对应的 Trae 账号；登录后系统会自动验证并同步。", en: "Make sure the separate browser window signs in to the Trae account for {name}. The session is verified and synced automatically." },
    "pool.traeAuthStarting": { zh: "正在打开独立浏览器…", en: "Opening a separate browser…" },
    "pool.traeAuthWaiting": { zh: "已打开独立浏览器，请在官网完成登录", en: "A separate browser is open. Complete sign-in on the official site." },
    "pool.traeAuthComplete": { zh: "Trae 登录完成", en: "Trae sign-in complete" },
    "pool.traeAuthExpired": { zh: "Trae 登录信息未通过积分验证，请重新登录", en: "Trae sign-in failed the credit check. Please sign in again." },
    "pool.traeCancelFailed": { zh: "取消 Trae 登录失败：{message}", en: "Could not cancel Trae sign-in: {message}" },
    "pool.authStarting": { zh: "正在启动官方授权…", en: "Starting official authorization…" },
    "pool.authWaiting": { zh: "等待完成授权…", en: "Waiting for authorization…" },
    "pool.authComplete": { zh: "账号授权完成", en: "Account authorized" },
    "pool.authStopped": { zh: "本次授权已结束，可重新发起。", en: "This authorization ended. You can start again." },
    "pool.authCancelled": { zh: "已取消本次授权", en: "Authorization canceled" },
    "pool.openAuth": { zh: "打开官方授权页面", en: "Open official authorization page" },
    "pool.deviceCode": { zh: "设备码", en: "Device code" },
    "pool.cancelAuth": { zh: "取消授权", en: "Cancel authorization" },
    "pool.retryAuth": { zh: "重新发起", en: "Start again" },
    "pool.close": { zh: "关闭", en: "Close" },
    "member.models.authorized": { zh: "当前 Key 可用模型", en: "Models available to your key" },
    "member.connect.endpoint": { zh: "请求路径", en: "Request path" },
    "common.lang.toggle.title": { zh: "切换到英文", en: "Switch to Chinese" },
    "common.lang.toggle.label": { zh: "EN", en: "中文" },
    "common.theme.toggle.title": { zh: "切换到浅色主题", en: "Switch to light theme" },
    "common.theme.toggle.title.light": { zh: "切换到深色主题", en: "Switch to dark theme" },
    "common.theme.toggle.label": { zh: "浅色", en: "Light" },
    "common.theme.toggle.label.light": { zh: "深色", en: "Dark" },

    "home.title": { zh: "loean · AI 服务入口", en: "loean · AI Service Gateway" },
    "home.brand.aria": { zh: "loean 首页", en: "loean home" },
    "home.topbar.tagline": { zh: "成员空间 · 管理工作台", en: "Member space · Admin console" },
    "home.topbar.admin": { zh: "管理员入口 ↗", en: "Admin entry ↗" },
    "home.top.member": { zh: "成员空间", en: "Member space" },
    "home.top.admin": { zh: "管理工作台", en: "Admin console" },
    "home.top.contact": { zh: "联系我们", en: "Contact" },

    "home.hero.title": {
      zh: "一个入口，<br /><em>接入你的 AI 服务。</em>",
      en: "One gateway,<br /><em>wired to your AI services.</em>",
    },
    "home.hero.lead": {
      zh: "查看个人额度、完成客户端配置、核对每一次调用。你的接入信息都在这里，清楚而有序。",
      en: "Check your quota, finish client setup, and audit every call. Everything you need to connect lives here — clear and in order.",
    },
    "home.hero.cta.member": { zh: "进入成员空间 ↗", en: "Open member space ↗" },
    "home.hero.cta.admin": { zh: "管理员登录", en: "Admin sign-in" },
    /* 混排句：英文侧只保留标签，不再向英文读者解释一个英文短语 */
    "home.hero.invite": { zh: "BY INVITATION · 由管理员邀请开通", en: "BY INVITATION" },

    "home.spec.aria": { zh: "服务概览", en: "Service overview" },
    "home.spec.protocols": { zh: "双协议", en: "Dual protocol" },
    "home.spec.protocols.value": { zh: "OpenAI · Anthropic", en: "OpenAI · Anthropic" },
    "home.spec.keys": { zh: "独立 Key", en: "Isolated keys" },
    "home.spec.keys.value": { zh: "额度 · 到期 · 白名单", en: "Quota · Expiry · Allowlist" },
    "home.spec.usage": { zh: "用量可查", en: "Usage audit" },
    "home.spec.usage.value": { zh: "按次 · 按日 · 可追溯", en: "Per call · Daily · Traceable" },

    "home.roles.aria": { zh: "选择身份", en: "Choose your role" },
    "home.role.member.no": { zh: "01 / MEMBER", en: "01 / MEMBER" },
    "home.role.member.title": { zh: "我是成员", en: "I am a member" },
    "home.role.member.body": {
      zh: "查看自己的 Key、剩余额度与调用结果，按步骤完成接入。",
      en: "See your key, remaining quota, and call results, then follow the steps to connect.",
    },
    "home.role.member.cta": { zh: "进入成员空间 →", en: "Open member space →" },
    "home.role.admin.no": { zh: "02 / ADMIN", en: "02 / ADMIN" },
    "home.role.admin.title": { zh: "我是管理员", en: "I am an admin" },
    "home.role.admin.body": {
      zh: "管理成员 Key、全局用量与服务状态。",
      en: "Manage member keys, global usage, and service health.",
    },
    "home.role.admin.cta": { zh: "进入管理工作台 →", en: "Open admin console →" },

    "home.features.aria": { zh: "服务特点", en: "Service highlights" },
    "home.feature.quota.no": { zh: "A", en: "A" },
    "home.feature.quota.title": { zh: "额度看得见", en: "Quota in plain sight" },
    "home.feature.quota.body": {
      zh: "总额度、剩余量、今日调用与最近结果，成员随时自查；管理员按 Key 核对消耗，异常一眼定位。",
      en: "Total quota, remaining balance, today's calls, and latest results are always self-service for members; admins reconcile spend per key and spot anomalies at a glance.",
    },
    "home.feature.trace.no": { zh: "B", en: "B" },
    "home.feature.trace.title": { zh: "问题有迹可循", en: "Trace issues by request" },
    "home.feature.trace.body": {
      zh: "每次调用都有记录和请求编号；遇到失败时，凭编号联系管理员排查原因。",
      en: "Each call has a record and request ID. If one fails, share the ID with an admin to investigate.",
    },
    "home.feature.budget.no": { zh: "C", en: "C" },
    "home.feature.budget.title": { zh: "消耗可控制", en: "Spend under control" },
    "home.feature.budget.body": {
      zh: "独立 Key 配额原子预占、并发不超卖；停用、过期、限流即时生效，预算始终在维护者手里。",
      en: "Per-key quota is reserved atomically and never oversold under concurrency; disable, expiry, and rate limits take effect immediately, so the budget stays with its owner.",
    },

    "home.contact.aria": { zh: "联系我们", en: "Contact us" },
    "home.contact.label": { zh: "联系我们", en: "Contact" },
    "home.contact.qq.title": { zh: "点击复制 QQ 号", en: "Click to copy the QQ number" },
    "home.contact.qq.copied": { zh: "QQ {qq} 已复制 ✓", en: "QQ {qq} copied ✓" },
    "home.contact.qq.failed": { zh: "复制失败，请手动选择", en: "Copy failed — please select it manually" },

    "home.footer.note": { zh: "自用小团队中转 · BY INVITATION", en: "Private team relay · BY INVITATION" },

    /* ---------- 首页：档案馆改版新增 ---------- */
    "home.hero.eyebrow": { zh: "LOEAN · TEAM AI STATION", en: "LOEAN · TEAM AI STATION" },
    "home.archive.aria": { zh: "服务档案", en: "Service dossier" },
    "home.archive.title": { zh: "服务档案", en: "Service dossier" },
    "home.archive.sub": {
      zh: "像查索引一样核对你的接入要素。",
      en: "Check the essentials of your access like a card index.",
    },
    "home.footer.big": {
      zh: "把接入这件事，<i>一次安顿清楚。</i>",
      en: "Get access settled — <i>once and for all.</i>",
    },

    /* ---------- 成员端：登录页 ---------- */
    "member.title": { zh: "loean · 成员空间", en: "loean · Member Space" },
    "member.brand.aria.home": { zh: "返回 loean 首页", en: "Back to loean home" },
    "member.brand.aria.space": { zh: "loean 成员空间首页", en: "loean member space home" },
    "member.login.h1": { zh: "继续你的<br /><em>AI 工作流。</em>", en: "Continue your<br /><em>AI workflow.</em>" },
    "member.login.lead": {
      zh: "查看钱包余额、完成客户端配置、核对每一次调用。模型调用 Key 与网页登录账号彼此独立。",
      en: "Check your wallet balance, finish client setup, and audit every call. Your API key is separate from your web login.",
    },
    "member.login.points.aria": { zh: "成员空间能力", en: "Member space capabilities" },
    "member.login.point.own": { zh: "仅查看本人信息", en: "Your own data only" },
    "member.login.point.quota": { zh: "独立计费", en: "Isolated billing" },
    "member.login.point.trace": { zh: "调用可追踪", en: "Traceable calls" },
    "member.login.h2": { zh: "成员登录", en: "Member sign-in" },
    "member.login.sub": { zh: "请使用管理员开通的成员账号。", en: "Use the member account your admin created." },
    "member.login.username": { zh: "成员账号", en: "Member account" },
    "member.login.username.ph": { zh: "请输入成员账号", en: "Enter your member account" },
    "member.login.password": { zh: "密码", en: "Password" },
    "member.login.password.ph": { zh: "请输入密码", en: "Enter your password" },
    "member.login.submit": { zh: "登录成员空间 ↗", en: "Sign in to member space ↗" },
    "member.login.noAccount": { zh: "还没有账号？请联系管理员开通。", en: "No account yet? Ask your admin to create one." },
    "member.login.adminLink": { zh: "管理员登录", en: "Admin sign-in" },

    /* ---------- 成员端：导航与通用 ---------- */
    "member.nav.aria": { zh: "成员导航", en: "Member navigation" },
    "member.nav.overview": { zh: "总览", en: "Overview" },
    "member.nav.key": { zh: "我的 Key", en: "My key" },
    "member.nav.models": { zh: "模型列表", en: "Models" },
    "member.nav.playground": { zh: "模拟调用", en: "Playground" },
    "member.nav.billing": { zh: "计费", en: "Billing" },
    "member.nav.connect": { zh: "接入配置", en: "Setup" },
    "member.nav.usage": { zh: "调用记录", en: "Call log" },
    "member.nav.keyShort": { zh: "Key", en: "Key" },
    "member.nav.modelsShort": { zh: "模型", en: "Models" },
    "member.nav.playgroundShort": { zh: "模拟", en: "Play" },
    "member.nav.billingShort": { zh: "计费", en: "Billing" },
    "member.nav.connectShort": { zh: "接入", en: "Setup" },
    "member.nav.usageShort": { zh: "记录", en: "Log" },
    "member.nav.logout": { zh: "退出", en: "Sign out" },
    "member.rail.quotaAria": { zh: "钱包速览", en: "Wallet at a glance" },
    "member.rail.remaining": { zh: "钱包余额", en: "Wallet balance" },
    "member.rail.todayCalls": { zh: "今日调用", en: "Calls today" },
    "member.rail.todayTokens": { zh: "今日消耗", en: "Used today" },
    "member.rail.usernameFallback": { zh: "成员空间", en: "Member space" },
    "member.rail.glance": { zh: "速览", en: "AT A GLANCE" },
    "member.login.eyebrow": { zh: "MEMBER ACCESS / 成员空间", en: "MEMBER ACCESS" },
    "member.rail.memberFallback": { zh: "成员", en: "Member" },
    "member.logout.title": { zh: "退出登录", en: "Sign out" },
    "member.contact.aria": { zh: "联系我们", en: "Contact us" },
    "member.contact.label": { zh: "联系我们", en: "Contact" },
    "member.contact.qq.title": { zh: "点击复制 QQ 号", en: "Click to copy the QQ number" },
    "member.copy.short": { zh: "复制", en: "Copy" },
    "member.copy.requestId": { zh: "复制编号", en: "Copy id" },
    "member.copy.identifier": { zh: "复制标识", en: "Copy id" },
    "member.copy.done": { zh: "已复制", en: "Copied" },
    "member.copy.toast": { zh: "已复制到剪贴板", en: "Copied to clipboard" },
    "member.copy.denied": { zh: "浏览器未授予剪贴板权限，请手动复制", en: "Clipboard blocked — please copy manually" },
    "member.copy.tooltip": { zh: "点击复制", en: "Click to copy" },
    "member.search.models": { zh: "搜索模型…", en: "Search models…" },
    "member.search.modelsAria": { zh: "搜索模型", en: "Search models" },
    "member.refresh": { zh: "刷新", en: "Refresh" },
    "member.viewAll": { zh: "查看全部 →", en: "View all →" },
    "member.noMatchModels": { zh: "没有匹配的模型", en: "No matching models" },
    "member.empty.records": { zh: "暂无调用记录", en: "No calls yet" },
    "member.empty.recordsFiltered": { zh: "暂无匹配的调用记录", en: "No matching calls" },

    /* ---------- 成员端：总览 ---------- */
    "member.overview.kicker": { zh: "MY WORKSPACE / 个人总览", en: "MY WORKSPACE / OVERVIEW" },
    "member.overview.greeting": { zh: "你好，{name}。", en: "Hello, {name}." },
    "member.overview.greetingPlain": { zh: "你好。", en: "Hello." },
    "member.overview.lead": { zh: "余额、接入与调用结果都在这里。", en: "Balance, setup, and call results all live here." },
    "member.overview.keyEnabled": { zh: "个人 Key 已启用", en: "Your key is active" },
    "member.overview.quotaTitle": { zh: "WALLET BALANCE / 钱包余额", en: "WALLET BALANCE" },
    "member.overview.loading": { zh: "正在读取钱包余额…", en: "Loading wallet balance…" },
    "member.overview.walletDetail": { zh: "调用前按估算预占，结束后按真实用量结算并退还差额。", en: "Estimated cost is held before the call, settled against real usage afterwards, and the difference refunded." },
    "member.overview.unlimited": { zh: "不限", en: "Unlimited" },
    "member.overview.expiresAt": { zh: "有效期至 {time}", en: "Valid until {time}" },
    "member.overview.expiresNone": { zh: "未设置到期时间", en: "No expiry set" },
    "member.overview.todayCalls": { zh: "今日调用", en: "Calls today" },
    "member.overview.businessDay": { zh: "当前业务日", en: "Current business day" },
    "member.overview.todayTokens": { zh: "今日消耗", en: "Used today" },
    "member.overview.wallet": { zh: "钱包余额", en: "Wallet balance" },
    "member.overview.walletNone": { zh: "未开户", en: "No wallet" },
    "member.overview.walletSub": { zh: "联系管理员开户/充值", en: "Ask an admin to open or top up" },
    "member.overview.walletChargingOff": { zh: "扣费关闭", en: "charging off" },
    "member.overview.latest": { zh: "最近一次调用", en: "Latest call" },
    "member.overview.latestNone": { zh: "暂无", en: "None" },
    "member.overview.latestNever": { zh: "尚未产生调用", en: "No calls yet" },
    "member.overview.quick": { zh: "快速接入", en: "Quick setup" },
    "member.overview.fullGuide": { zh: "完整指南 →", en: "Full guide →" },
    "member.overview.openaiEntry": { zh: "OpenAI 兼容入口", en: "OpenAI-compatible endpoint" },
    "member.overview.recommended": { zh: "推荐模型", en: "Recommended model" },
    "member.overview.assigned": { zh: "{platform} 已分配", en: "{platform} assigned" },
    "member.overview.chooseInSetup": { zh: "请在接入配置页选择", en: "Choose one on the Setup page" },
    "member.overview.viewSteps": { zh: "查看配置步骤 ↗", en: "View setup steps ↗" },
    "member.overview.modelList": { zh: "模型列表 →", en: "Model list →" },
    "member.overview.recent": { zh: "最近调用", en: "Recent calls" },
    "member.overview.modelPreview": { zh: "可选模型预览", en: "Selectable models" },
    "member.overview.allModels": { zh: "全部模型 →", en: "All models →" },
    "member.overview.loadingModels": { zh: "登录后加载模型目录…", en: "Loading model catalog…" },
    "member.overview.modelsEmpty": { zh: "暂无可选模型，请联系管理员分配模型。", en: "No models available. Ask your admin to assign models." },
    "member.overview.more": { zh: "还有 {count} 个 →", en: "{count} more →" },
    "member.overview.keyLink": { zh: "查看我的 Key →", en: "View my key →" },

    /* ---------- 成员端：我的 Key ---------- */
    "member.key.kicker": { zh: "MY ACCESS / 我的 KEY", en: "MY ACCESS / MY KEY" },
    "member.key.h1": { zh: "我的 Key", en: "My key" },
    "member.key.lead": { zh: "你的使用范围、钱包余额和有效期。", en: "Your scope, wallet balance, and validity." },
    "member.key.personal": { zh: "PERSONAL KEY", en: "PERSONAL KEY" },
    "member.key.copyNote": { zh: "完整 Key 仅在管理员首次发放或轮换时提供。这里仅展示前缀与尾号，便于核对身份。", en: "The full key is shown only when an admin issues or rotates it. Only the prefix and suffix appear here, so you can verify identity." },
    "member.key.expiry": { zh: "到期时间", en: "Expires" },
    "member.key.rate": { zh: "速率限制", en: "Rate limit" },
    "member.key.state": { zh: "KEY 状态", en: "Key status" },
    "member.key.helpTitle": { zh: "需要充值或更新 Key？", en: "Need a top-up or a new key?" },
    "member.key.helpBody": { zh: "请联系管理员，并提供上方 Key 标识或调用记录里的请求编号，便于快速定位。", en: "Contact an admin with the key identifier above or a request id from your call log." },
    "member.key.allowance": { zh: "TOKEN ALLOWANCE", en: "TOKEN ALLOWANCE" },
    "member.key.walletNote": { zh: "人民币余额，按实际用量扣减", en: "CNY balance, charged by real usage" },
    "member.key.viewBilling": { zh: "查看计费明细 →", en: "View billing detail →" },
    "member.key.noExpiry": { zh: "不过期", en: "Never expires" },
    "member.key.perMinute": { zh: "{count} 次 / 分钟", en: "{count} / min" },

    /* ---------- 成员端：模型列表 ---------- */
    "member.models.kicker": { zh: "MODEL CATALOG / 模型列表", en: "MODEL CATALOG" },
    "member.models.h1": { zh: "可选模型", en: "Selectable models" },
    "member.models.sub": { zh: "查看你可以使用的模型、能力和单价。", en: "View your available models, capabilities, and prices." },
    "member.models.available": { zh: "当前可选", en: "Selectable" },
    "member.models.priced": { zh: "已标价", en: "Priced" },
    "member.models.pricedSub": { zh: "管理员配置的单价", en: "Rates set by an admin" },
    "member.models.currency": { zh: "货币", en: "Currency" },
    "member.models.chargeState": { zh: "扣费状态", en: "Charging" },
    /* 仅用于 JS 写入前的静态占位（真正的值由 renderBilling 填充条数） */
    "member.billing.rateCountPlaceholder": { zh: "0 条", en: "0 items" },
    "member.models.catalog": { zh: "目录", en: "Catalog" },
    "member.models.toSetup": { zh: "去接入配置 →", en: "Go to setup →" },
    "member.models.thId": { zh: "模型 ID", en: "Model ID" },
    "member.models.thEffort": { zh: "推理等级", en: "Reasoning" },
    "member.models.chargingOn": { zh: "扣费已启用", en: "Charging enabled" },
    "member.models.chargingOff": { zh: "扣费关闭 · 单价仅供参考", en: "Charging off · rates are indicative" },
    "member.models.countAll": { zh: "共 {count} 个模型，可复制模型 ID 到客户端。", en: "{count} models. Copy an ID into your client." },
    "member.models.countFiltered": { zh: "匹配 {shown} / {total} 个模型。", en: "{shown} of {total} models match." },
    "member.models.unpriced": { zh: "未标价", en: "Unpriced" },
    "member.models.marked": { zh: "已标价", en: "Priced" },
    "member.models.gotoConnect": { zh: "去接入配置 →", en: "Go to setup →" },

    /* ---------- 成员端：模拟调用 ---------- */
    "member.playground.kicker": { zh: "PLAYGROUND / 模拟调用", en: "PLAYGROUND" },
    "member.playground.h1": { zh: "模拟调用", en: "Playground" },
    "member.playground.lead": { zh: "选择公开模型，在网页里直接发起一次真实对话。", en: "Pick a published model and chat with it right here." },
    "member.playground.chooseModel": { zh: "选择模型", en: "Choose a model" },
    "member.playground.billedNote": { zh: "对话通过你的 Key 真实转发到模型，按所选模型的公开单价从钱包余额扣费；每次调用都会记入「调用记录」。", en: "Messages are really forwarded through your key and charged at the model's published rate from your wallet; every call shows up in the call log." },
    "member.playground.clear": { zh: "清空对话", en: "Clear chat" },
    "member.playground.placeholder": { zh: "输入消息，Ctrl+Enter 发送…", en: "Type a message; Ctrl+Enter to send…" },
    "member.playground.send": { zh: "发送 ↗", en: "Send ↗" },
    "member.playground.empty": { zh: "选好模型，发一句话试试。", en: "Pick a model and say hello." },
    "member.playground.you": { zh: "你", en: "You" },
    "member.playground.assistant": { zh: "模型", en: "Model" },
    "member.playground.thinking": { zh: "正在生成…", en: "Generating…" },
    "member.playground.chargingOn": { zh: "真实扣费已启用", en: "Real charging enabled" },
    "member.playground.chargingOff": { zh: "扣费未启用 · 不扣余额", en: "Charging off · wallet untouched" },
    "member.playground.noModels": { zh: "当前 Key 没有可用模型", en: "No models for your key" },
    "member.playground.modelRequired": { zh: "请先选择模型", en: "Pick a model first" },
    "member.playground.metaTokens": { zh: "本轮 {tokens} Tokens", en: "{tokens} tokens this turn" },
    "member.playground.metaCost": { zh: "预估 {amount}", en: "≈ {amount}" },
    "member.playground.metaLatency": { zh: "耗时 {time}", en: "{time}" },

    /* ---------- 成员端：计费 ---------- */
    "member.billing.kicker": { zh: "BILLING / 计费", en: "BILLING" },
    "member.billing.h1": { zh: "我的计费", en: "My billing" },
    "member.billing.loading": { zh: "加载中…", en: "Loading…" },
    "member.billing.restartRequired": { zh: "当前服务仍按旧币种运行，请等待管理员在 IDE 重启服务；旧钱包和流水按原单位显示，人民币计费暂不可用。", en: "The server still uses the old currency. Wait for an admin to restart it in the IDE. Historical wallet and ledger values use their original unit; CNY billing is unavailable." },
    "member.billing.rateRestartRequired": { zh: "模型单价正在升级为按百万 Token 计价，请等待管理员重启服务。", en: "Model rates are being upgraded to per 1M tokens. Wait for an admin to restart the server." },
    "member.billing.ratesWaitingRestart": { zh: "人民币模型单价将在服务重启后显示。", en: "CNY model rates will appear after the server restarts." },
    "member.billing.walletTitle": { zh: "WALLET / 钱包余额", en: "WALLET" },
    "member.billing.walletIndependent": { zh: "钱包余额是唯一的调用限额", en: "Wallet balance is the only limit" },
    "member.billing.needTopUp": { zh: "需要充值请联系管理员", en: "Contact an admin to top up" },
    "member.billing.viewRates": { zh: "查看模型单价 →", en: "View model rates →" },
    "member.billing.enabled": { zh: "扣费启用", en: "Charging on" },
    "member.billing.disabled": { zh: "扣费关闭", en: "Charging off" },
    "member.billing.noticeEnabled": { zh: "钱包计费已启用；配置单价的模型按用量结算，未配置单价或非零兜底价的调用会被拒绝。Token 配额独立生效。", en: "Wallet charging is on. Priced models are billed by usage; calls without a model or fallback rate are rejected. Your token quota applies separately." },
    "member.billing.noticeDisabled": { zh: "扣费关闭。仍可查看钱包与单价，Token 配额独立生效。", en: "Charging is off. You can still view your wallet and rates; your token quota applies separately." },
    "member.billing.walletSub": { zh: "{currency} · 与 Token 配额相互独立", en: "{currency} · separate from your token quota" },
    "member.billing.walletSubNone": { zh: "管理员开户/充值后显示余额", en: "Balance appears once an admin opens one" },
    "member.billing.opened": { zh: "已开户", en: "Open" },
    "member.billing.noWallet": { zh: "未开户", en: "Not opened" },
    "member.billing.publicRates": { zh: "公开单价", en: "Public rates" },
    "member.billing.rateCount": { zh: "{count} 条", en: "{count} rates" },
    "member.billing.ratesEmpty": { zh: "管理员尚未配置公开单价；配好单价后即可按量计费。", en: "No public rates configured yet. Calls are billed once an admin sets them." },
    "member.billing.ratesEmptyEnabled": { zh: "管理员尚未配置公开单价；若也没有兜底价，模型调用会在转发前被拒绝。", en: "No public rates have been configured. Calls are rejected before routing if no fallback rate is set." },
    "member.billing.recent": { zh: "近期流水", en: "Recent ledger" },
    "member.billing.selfOnly": { zh: "仅本人", en: "You only" },
    "member.billing.ledgerEmpty": { zh: "暂无流水。充值或扣费启用后会出现在这里。", en: "No ledger entries yet. They appear here once top-ups or charging begin." },
    "member.billing.ledgerMore": { zh: "加载更多", en: "Load more" },
    "member.billing.ledgerLoading": { zh: "加载中…", en: "Loading…" },
    "member.billing.thModel": { zh: "模型", en: "Model" },
    "member.billing.thTime": { zh: "时间", en: "Time" },
    "member.billing.thType": { zh: "类型", en: "Type" },
    "member.billing.thStatus": { zh: "状态", en: "Status" },
    "member.billing.thAmount": { zh: "金额", en: "Amount" },
    "member.billing.thBalanceAfter": { zh: "余额后", en: "Balance after" },
    "member.billing.reservedAmount": { zh: "预占 {amount}", en: "Reserved {amount}" },
    "member.billing.typeUsage": { zh: "调用扣费", en: "Usage charge" },
    "member.billing.typeTopUp": { zh: "充值", en: "Top-up" },
    "member.billing.typeAdjustment": { zh: "调账", en: "Adjustment" },
    "member.billing.typeRefund": { zh: "退款", en: "Refund" },
    "member.billing.statusPending": { zh: "结算中", en: "Settling" },
    "member.billing.statusReview": { zh: "待核对用量", en: "Usage review" },
    "member.billing.statusPosted": { zh: "已入账", en: "Posted" },
    "member.billing.statusVoided": { zh: "已作废", en: "Voided" },

    /* ---------- 成员端：接入配置 ---------- */
    "member.connect.kicker": { zh: "GET CONNECTED / 接入配置", en: "GET CONNECTED" },
    "member.connect.h1": { zh: "三步完成接入", en: "Connect in three steps" },
    "member.connect.lead": { zh: "选择协议和公开模型，填写你的客户端配置。", en: "Choose a protocol and public model to configure your client." },
    "member.connect.step1Title": { zh: "取得个人 Key", en: "Get your personal key" },
    "member.connect.step1Body": { zh: "从管理员处获取完整 Key。请妥善保存，勿发送到公开聊天或代码仓库。", en: "Get the full key from an admin. Keep it safe — never post it in public chats or repositories." },
    "member.connect.step2Title": { zh: "填写服务地址与模型", en: "Fill in the endpoint and model" },
    "member.connect.step2Body": { zh: "把右侧地址、个人 Key 和已分配模型填写进你的客户端设置。", en: "Enter the endpoint, your key, and the assigned model in your client settings." },
    "member.connect.step3Title": { zh: "发起一次测试调用", en: "Make a test call" },
    "member.connect.step3Body": { zh: "完成后可在“调用记录”中确认状态；失败时复制请求编号联系管理员。", en: "Check the status in your call log. If it fails, copy the request id and contact an admin." },
    "member.connect.openai": { zh: "Chat Completions", en: "Chat Completions" },
    "member.connect.anthropic": { zh: "Anthropic Messages", en: "Anthropic Messages" },
    "member.connect.copy": { zh: "复制", en: "Copy" },
    "member.connect.chooseModel": { zh: "选择模型", en: "Choose a model" },
    "member.connect.noModels": { zh: "暂无可选模型，请联系管理员。", en: "No models available. Contact your admin." },
    "member.connect.reading": { zh: "正在读取接入配置…", en: "Loading your setup…" },
    "member.connect.copySample": { zh: "复制配置示例", en: "Copy config sample" },
    "member.connect.viewLog": { zh: "查看调用记录 →", en: "View call log →" },
    "member.connect.note": { zh: "模型与服务地址以管理员实际分配为准。页面不会展示或存储你的完整 Key。", en: "The model and endpoint follow what your admin assigned. This page never shows or stores your full key." },
    "member.connect.confirmModel": { zh: "请联系管理员确认模型", en: "Ask an admin to confirm the model" },

    /* ---------- 成员端：CC Switch 一键接入 ---------- */
    "member.ccswitch.title": { zh: "CC Switch 一键接入", en: "One-click setup for CC Switch" },
    "member.ccswitch.lead": { zh: "已安装 CC Switch 桌面端？粘贴完整 Key，点击下方按钮即可把本站写入 CC Switch 的供应商列表（Claude Code、Codex 或 OpenAI 兼容客户端），无需手动编辑配置。", en: "Using the CC Switch desktop app? Paste your full key and click a button below to add this relay to CC Switch (Claude Code, Codex, or OpenAI-compatible clients) — no manual config editing." },
    "member.ccswitch.keyLabel": { zh: "完整 API Key", en: "Full API key" },
    "member.ccswitch.keyPlaceholder": { zh: "粘贴完整 Key（sk-…）", en: "Paste your full key (sk-…)" },
    "member.ccswitch.keyNote": { zh: "Key 只会在本地浏览器里拼装导入链接，不会提交到服务器。", en: "The key is only assembled into the import link inside your browser — it is never sent to the server." },
    "member.ccswitch.importClaude": { zh: "导入到 CC Switch · Claude Code", en: "Import to CC Switch · Claude Code" },
    "member.ccswitch.importCodex": { zh: "导入到 CC Switch · Codex", en: "Import to CC Switch · Codex" },
    "member.ccswitch.compatTitle": { zh: "OPENAI COMPATIBLE · 经 /V1", en: "OPENAI COMPATIBLE · VIA /V1" },
    "member.ccswitch.importOpencode": { zh: "OpenCode", en: "OpenCode" },
    "member.ccswitch.importOpenclaw": { zh: "OpenClaw", en: "OpenClaw" },
    "member.ccswitch.importHermes": { zh: "Hermes", en: "Hermes" },
    "member.ccswitch.importGrokbuild": { zh: "Grok Build", en: "Grok Build" },
    "member.ccswitch.copyLink": { zh: "复制导入链接", en: "Copy import link" },
    "member.ccswitch.needKey": { zh: "请先粘贴完整 API Key", en: "Paste your full API key first" },
    "member.ccswitch.launchHint": { zh: "已尝试唤起 CC Switch；若无反应请确认已安装，或复制链接手动导入。", en: "Tried to open CC Switch. If nothing happened, make sure it is installed, or copy the link and import manually." },
    "member.ccswitch.note": { zh: "需要 CC Switch v3.19 及以上版本；导入时软件内会弹出确认框。链接包含完整 Key，请勿转发给他人。", en: "Requires CC Switch v3.19+. The app asks for confirmation before importing. The link contains your full key — never share it." },
    "member.ccswitch.providerName": { zh: "loean 中转 · {host}", en: "loean relay · {host}" },

    /* ---------- 成员端：调用记录 ---------- */
    "member.usage.kicker": { zh: "MY ACTIVITY / 调用记录", en: "MY ACTIVITY / CALL LOG" },
    "member.usage.h1": { zh: "我的调用记录", en: "My call log" },
    "member.usage.range": { zh: "业务日 {date} · {zone}", en: "Business day {date} · {zone}" },
    "member.usage.rangeNone": { zh: "业务日 —", en: "Business day —" },
    "member.usage.dateAria": { zh: "选择业务日", en: "Choose a business day" },
    "member.usage.calls": { zh: "当日调用", en: "Calls that day" },
    "member.usage.tokens": { zh: "当日消耗", en: "Used that day" },
    "member.usage.fails": { zh: "未完整成功", en: "Not fully successful" },
    "member.usage.recent": { zh: "最近调用", en: "Recent calls" },
    "member.usage.filterAll": { zh: "全部", en: "All" },
    "member.usage.filterOk": { zh: "成功", en: "Success" },
    "member.usage.filterOther": { zh: "未完整成功", en: "Not fully successful" },
    "member.usage.thTime": { zh: "时间", en: "Time" },
    "member.usage.thModel": { zh: "模型", en: "Model" },
    "member.usage.thStatus": { zh: "状态", en: "Status" },
    "member.usage.thRequestId": { zh: "请求编号", en: "Request id" },
    "member.usage.prevPage": { zh: "上一页", en: "Previous" },
    "member.usage.nextPage": { zh: "下一页", en: "Next" },
    "member.usage.pageInfo": { zh: "第 {page} / {pages} 页 · 共 {count} 条", en: "Page {page} of {pages} · {count} calls" },
    "member.usage.note": { zh: "遇到问题时复制请求编号发给管理员；内部账号与网络信息不会在成员端显示。", en: "If something fails, copy the request id to your admin. Internal accounts and network details are never shown here." },

    /* ---------- 成员端：状态词与时间 ---------- */
    "member.status.OK": { zh: "成功", en: "Success" },
    "member.status.ABORTED": { zh: "已中断", en: "Aborted" },
    "member.status.FAIL": { zh: "失败", en: "Failed" },
    "member.status.FAILED": { zh: "失败", en: "Failed" },
    "member.status.ACTIVE": { zh: "已启用", en: "Active" },
    "member.status.DISABLED": { zh: "已停用", en: "Disabled" },
    "member.status.EXPIRED": { zh: "已过期", en: "Expired" },
    "member.status.EXHAUSTED": { zh: "额度用尽", en: "Quota exhausted" },
    "member.status.UNKNOWN": { zh: "未知", en: "Unknown" },
    "member.time.today": { zh: "今天 {time}", en: "Today {time}" },

    /* ---------- 成员端：提示与错误 ---------- */
    "member.error.sessionExpired": { zh: "登录已过期，请重新登录", en: "Your session expired — please sign in again" },
    "member.error.unauthenticated": { zh: "未认证", en: "Not authenticated" },
    "member.error.requestFailed": { zh: "请求失败（HTTP {status}）", en: "Request failed (HTTP {status})" },
    "member.error.loginFailed": { zh: "登录失败", en: "Sign-in failed" },
    "member.error.unavailable": { zh: "成员空间暂时不可用，请稍后再试", en: "Member space is temporarily unavailable — please try again later" },
    "member.logout.confirm": { zh: "确定要退出成员中心吗？", en: "Sign out of the member portal?" },
    "member.logout.done": { zh: "已退出登录", en: "Signed out" },
    "member.dlg.confirmTitle": { zh: "确认操作", en: "Confirm action" },
    "member.dlg.confirm": { zh: "确认", en: "Confirm" },
    "member.dlg.cancel": { zh: "取消", en: "Cancel" },

    /* ---------- 成员端：低余额预警与充值 ---------- */
    "member.lowbalance.low": { zh: "钱包余额 {amount}，已低于建议阈值。余额用尽后调用会被拒绝，请及时充值。", en: "Wallet balance is {amount}, below the suggested threshold. Calls are rejected once it runs out — please top up." },
    "member.lowbalance.exhausted": { zh: "钱包余额已用尽，调用会被拒绝。充值到账后自动恢复。", en: "Your wallet balance is used up and calls are rejected. Access resumes once a top-up lands." },
    "member.topup.button": { zh: "充值", en: "Top up" },
    "member.topup.title": { zh: "联系管理员充值", en: "Top up via an admin" },
    "member.topup.lead": { zh: "充值目前由管理员人工处理。请通过下方方式联系，说明充值金额并提供你的成员账号；到账后可在计费页看到充值流水。", en: "Top-ups are handled manually by an admin. Reach out below with the amount and your member account; the entry appears on the billing page once it lands." },
    "member.topup.accountLabel": { zh: "我的成员账号", en: "My member account" },
    "member.topup.close": { zh: "知道了", en: "Got it" },
    "member.topup.viewBilling": { zh: "查看计费明细 →", en: "View billing detail →" },

    /* ---------- 成员端：总览趋势图与快速接入 ---------- */
    "member.trend.title": { zh: "近 7 天调用", en: "Last 7 days" },
    "member.trend.total": { zh: "共 {calls} 次 · {tokens} Tokens", en: "{calls} calls · {tokens} tokens" },
    "member.trend.tip": { zh: "{date}：调用 {calls} · 未完整成功 {fails} · {tokens} Tokens · {cost}\n点击查看该日调用记录", en: "{date}: {calls} calls · {fails} not fully successful · {tokens} tokens · {cost}\nClick to view that day's log" },
    "member.trend.empty": { zh: "暂无趋势数据", en: "No trend data yet" },
    "member.overview.copyCurl": { zh: "复制 curl 示例", en: "Copy curl sample" },
    "member.overview.copyModel": { zh: "复制模型 ID", en: "Copy model id" },
    "member.connect.sampleTitle": { zh: "CONFIG SAMPLE", en: "CONFIG SAMPLE" },
    "member.connect.envTab": { zh: "ENV", en: "ENV" },

    /* ---------- 成员端：失败可诊断 ---------- */
    "member.usage.thLatency": { zh: "延迟", en: "Latency" },
    "member.usage.tokSplit": { zh: "入 {prompt} · 出 {completion}", en: "in {prompt} · out {completion}" },
    "member.usage.tokTitle": { zh: "输入 {prompt} / 输出 {completion}", en: "Input {prompt} / output {completion}" },
    "member.usage.tokCache": { zh: "缓存读 {read} / 缓存写 {write}", en: "cache read {read} / cache write {write}" },
    "member.usage.viewFailed": { zh: "查看该次调用的记录 →", en: "View this call in the log →" },
    "member.errorCat.client": { zh: "客户端请求问题：请检查请求参数与格式", en: "Client request issue: check your request parameters" },
    "member.errorCat.server": { zh: "服务端异常：请联系管理员并提供请求编号", en: "Server-side issue: contact an admin with the request id" },
    "member.errorCat.quota": { zh: "触发限流或配额限制：请降低频率或联系管理员", en: "Rate or quota limit hit: slow down or contact an admin" },
    "member.errorCat.stream": { zh: "流式输出中断：可直接重试该请求", en: "Stream interrupted: you can retry the request" },

    /* ---------- 通用：日期选择器（替代浏览器原生日历弹层） ---------- */
    "dp.aria.label": { zh: "选择日期", en: "Choose a date" },
    "dp.prev": { zh: "上个月", en: "Previous month" },
    "dp.next": { zh: "下个月", en: "Next month" },
    "dp.chooseMonth": { zh: "选择月份", en: "Choose a month" },
    "dp.clear": { zh: "清除", en: "Clear" },
    "dp.now": { zh: "此刻", en: "Now" },
    "dp.ok": { zh: "确定", en: "OK" },
    "dp.title": { zh: "{year} 年 {month} 月", en: "{monthName} {year}" },
    "dp.titleMonthOnly": { zh: "{year} 年", en: "{year}" },

    /* ==================================================================
     * 【批次 C2 · index.html 管理台静态文案】—— 本块由 index.html 改造批次维护。
     * 约定：只收 index.html 里真实存在的静态中文；运行时由 app.js 写入的文案
     * （例如 #accounts-sub、#dlg-title、#login-title 等 id 定位节点）不进本块，
     * 它们仍由 app.js 自己的 admin.* 键负责，避免两边重复定义同一个 key。
     * 若需改动，请只增删本块内的条目，不要动上方其它批次的内容。
     * ================================================================== */

    /* ---- 页面标题 / 品牌 / 导航 ---- */
    "admin.title": { zh: "loean · 账号池网关", en: "loean · Account Pool Gateway" },
    "admin.brandMarkAlt": { zh: "loean 花押", en: "loean seal" },
    "admin.nav.aria": { zh: "主导航", en: "Main navigation" },
    "admin.nav.overview": { zh: "总览", en: "Overview" },
    "admin.nav.accounts": { zh: "账号", en: "Accounts" },
    "admin.nav.members": { zh: "成员", en: "Members" },
    "admin.nav.billing": { zh: "计费", en: "Billing" },
    "admin.nav.usage": { zh: "用量", en: "Usage" },
    "admin.nav.records": { zh: "签到记录", en: "Check-in log" },
    "admin.adminName": { zh: "当前管理员", en: "Signed-in admin" },
    "admin.changePassword": { zh: "修改口令", en: "Change password" },
    "admin.logout": { zh: "退出登录", en: "Sign out" },
    "admin.refresh": { zh: "刷新", en: "Refresh" },

    /* ---- 通用表头 / 对话框动作 / 筛选 ---- */
    "admin.th.name": { zh: "名称", en: "Name" },
    "admin.th.platform": { zh: "平台", en: "Platform" },
    "admin.th.status": { zh: "状态", en: "Status" },
    "admin.th.credits": { zh: "积分", en: "Credits" },
    "admin.th.creditsQuota": { zh: "积分 / 额度", en: "Credits / quota" },
    "admin.th.remark": { zh: "备注", en: "Note" },
    "admin.th.ops": { zh: "操作", en: "Actions" },
    "admin.dlg.cancel": { zh: "取消", en: "Cancel" },
    "admin.dlg.save": { zh: "保存", en: "Save" },
    "admin.dlg.confirm": { zh: "确认", en: "Confirm" },
    "admin.dlg.enabled": { zh: "启用", en: "Enabled" },
    "admin.dlg.optional": { zh: "可选", en: "Optional" },
    "admin.filter.all": { zh: "全部", en: "All" },
    "admin.filter.ok": { zh: "正常", en: "Healthy" },
    "admin.filter.bad": { zh: "异常", en: "Failing" },

    /* ---- 侧栏 · 网关状态与接口地址 ---- */
    "admin.gateway.expand": { zh: "展开网关状态", en: "Expand gateway status" },
    "admin.gateway.unknown": { zh: "状态未知", en: "Status unknown" },
    "admin.gateway.status": { zh: "网关状态", en: "Gateway status" },
    "admin.gateway.rateTitle": { zh: "今日调用成功率", en: "Today's success rate" },
    "admin.gateway.latencyTitle": {
      zh: "最近 50 条调用记录中的成功调用平均延迟",
      en: "Average latency of successful calls in the last 50 records",
    },
    "admin.gateway.recentLatency": { zh: "近期平均延迟", en: "Recent avg latency" },
    "admin.gateway.poolReady": { zh: "启用且未冷却", en: "Enabled, not cooling" },
    "admin.gateway.successRate": { zh: "今日调用成功率", en: "Success rate today" },
    "admin.endpoints.title": { zh: "接口地址", en: "Endpoints" },

    /* ---- 总览 ---- */
    "admin.overview.h1": { zh: "总览", en: "Overview" },
    "admin.overview.sub": { zh: "账号健康度 · 今日签到 · 今日调用", en: "Account health · check-ins today · calls today" },
    "admin.overview.checkinAll": { zh: "一键签到全部", en: "Check in all" },
    "admin.overview.kpiTokensToday": { zh: "今日 Tokens", en: "Tokens today" },
    "admin.overview.kpiAccounts": { zh: "账号总数", en: "Total accounts" },
    "admin.overview.kpiCheckin": { zh: "今日签到", en: "Checked in today" },
    "admin.overview.kpiCalls": { zh: "今日调用", en: "Calls today" },
    "admin.overview.healthTitle": { zh: "账号健康", en: "Account health" },
    "admin.overview.viewAll": { zh: "查看全部", en: "View all" },
    "admin.overview.recentTitle": { zh: "最近调用", en: "Recent calls" },
    "admin.overview.detail": { zh: "明细", en: "Detail" },

    /* ---- 账号 ---- */
    "admin.accounts.h1": { zh: "账号", en: "Accounts" },
    "admin.accounts.creditsTitle": { zh: "下方账号积分合计", en: "Total credits of the accounts below" },
    "admin.accounts.refreshCredits": { zh: "刷新积分 / 额度", en: "Refresh credits / quota" },
    "admin.accounts.checkCreds": { zh: "检凭证", en: "Verify credentials" },
    "admin.accounts.checkinAll": { zh: "签到全部", en: "Check in all" },
    "admin.accounts.add": { zh: "+ 添加账号", en: "+ Add account" },
    "admin.accounts.searchPh": { zh: "搜索名称 / 备注…", en: "Search name / note…" },
    "admin.accounts.thCheckin": { zh: "今日签到", en: "Checked in today" },

    /* ---- 成员 ---- */
    "admin.members.h1": { zh: "成员", en: "Members" },
    "admin.members.sub": {
      zh: "开通成员空间 · 分配专属 Key · 控制个人额度",
      en: "Open member spaces, assign personal keys, and cap individual quota",
    },
    "admin.members.entry": { zh: "查看成员入口 ↗", en: "Open member portal ↗" },
    "admin.members.new": { zh: "+ 开通成员", en: "+ New member" },
    "admin.members.thMember": { zh: "成员", en: "Member" },
    "admin.members.thKey": { zh: "专属 Key", en: "Personal key" },
    "admin.members.thQuota": { zh: "钱包余额", en: "Wallet" },
    "admin.members.wallet.none": { zh: "未开户", en: "No wallet" },
    "admin.members.act.delete": { zh: "删除成员", en: "Delete" },
    "admin.members.dlgTitle.delete": { zh: "删除成员", en: "Delete member" },
    "admin.members.confirmDelete": { zh: "删除成员「{name}」？其账号与专属 Key 将被删除，成员钱包与计费流水保留为历史记录。", en: "Delete member “{name}”? The account and personal keys will be removed; the wallet and billing ledger are kept as history." },
    "admin.members.confirmDeleteWithBalance": { zh: "删除成员「{name}」？其账号与专属 Key 将被删除。成员钱包仍有余额 {balance}，删除后不再展示（计费流水保留），请确认无需退款或调账。", en: "Delete member “{name}”? The account and personal keys will be removed. The wallet still holds {balance}, which will no longer be shown (ledger kept) — make sure no refund or adjustment is needed." },
    "admin.members.toast.deleted": { zh: "成员已删除", en: "Member deleted" },
    "admin.members.thCreated": { zh: "创建时间", en: "Created" },

    /* ---- 计费 ---- */
    "admin.billing.h1": { zh: "计费", en: "Billing" },
    "admin.billing.newRate": { zh: "+ 模型单价", en: "+ Model rate" },
    "admin.billing.chargeSwitch": { zh: "扣费开关", en: "Charging switch" },
    "admin.billing.rateCount": { zh: "模型单价", en: "Model rates" },
    "admin.billing.configured": { zh: "已配置", en: "Configured" },
    "admin.billing.walletCount": { zh: "成员钱包", en: "Member wallets" },
    "admin.billing.opened": { zh: "已开户", en: "Opened" },
    "admin.billing.tabRates": { zh: "模型单价", en: "Model rates" },
    "admin.billing.tabRateDrafts": { zh: "模型单价（草稿）", en: "Rate drafts" },
    "admin.billing.tabWallets": { zh: "成员钱包", en: "Member wallets" },
    "admin.billing.tabLedger": { zh: "计费流水", en: "Billing ledger" },
    "admin.billing.thModel": { zh: "模型", en: "Model" },
    "admin.billing.thMember": { zh: "成员", en: "Member" },
    "admin.billing.thBalance": { zh: "钱包余额", en: "Wallet balance" },
    "admin.billing.thOpened": { zh: "开户", en: "Opened" },
    "admin.billing.thUpdated": { zh: "更新时间", en: "Updated" },
    "admin.billing.thTime": { zh: "时间", en: "Time" },
    "admin.billing.thType": { zh: "类型", en: "Type" },
    "admin.billing.thAmount": { zh: "金额", en: "Amount" },
    "admin.billing.thBalanceBefore": { zh: "余额前", en: "Balance before" },
    "admin.billing.thBalanceAfter": { zh: "余额后", en: "Balance after" },

    /* ---- 用量 ---- */
    "admin.usage.h1": { zh: "用量明细", en: "Usage detail" },
    "admin.usage.live": { zh: "实时", en: "Live" },
    "admin.usage.note": { zh: "流式调用在收尾 chunk 带 usage 时入账", en: "Streaming calls are billed when the final chunk carries usage" },
    "admin.usage.dateTitle": {
      zh: "按业务日（Asia/Shanghai）统计，留空为今天",
      en: "Counted by business day (Asia/Shanghai); leave empty for today",
    },
    "admin.usage.tabDetail": { zh: "用量明细", en: "Usage detail" },
    "admin.usage.tabCredits": { zh: "积分扣减", en: "Credit deductions" },
    "admin.usage.tabLifetime": { zh: "历史总调用", en: "Lifetime calls" },
    "admin.usage.kpiFails": { zh: "失败", en: "Failed" },
    "admin.usage.thTime": { zh: "时间", en: "Time" },
    "admin.usage.thModel": { zh: "模型", en: "Model" },
    "admin.usage.thAccount": { zh: "账号", en: "Account" },
    "admin.usage.thLatency": { zh: "延迟", en: "Latency" },
    "admin.usage.thClientIp": { zh: "客户端 IP", en: "Client IP" },
    "admin.usage.creditToday": { zh: "今日扣减合计", en: "Deducted today" },
    "admin.usage.creditAttributed": { zh: "已归因请求", en: "Attributed requests" },
    "admin.usage.creditAttributedSub": { zh: "含失败请求", en: "Includes failed calls" },
    /* 首页 KPI 标签用这条（不带计数） */
    "admin.usage.creditUnknownLabel": { zh: "待归因 / 未知", en: "Unattributed / unknown" },
    "admin.usage.creditUnknownSub": { zh: "积分接口未回填", en: "Not yet backfilled by the credit API" },
    "admin.usage.thCreditUsed": { zh: "扣积分", en: "Credits used" },
    /* 扣积分 KPI 卡片（总扣积分 / 今日已用） */
    "admin.usage.creditTotal": { zh: "总扣积分", en: "Total credits used" },
    "admin.usage.creditTotalPending": { zh: "待归因", en: "Pending attribution" },
    "admin.usage.creditTotalSub": { zh: "全部请求均已归因", en: "All requests attributed" },
    "admin.usage.creditTotalWithUnknown": { zh: "含 {unknown} 条未归因", en: "Includes {unknown} unattributed" },
    "admin.usage.creditUsedToday": { zh: "今日已用", en: "Used today" },
    "admin.usage.creditUsedSub": { zh: "业务日 {date}", en: "Business day {date}" },
    "admin.usage.creditUsedSubNoDate": { zh: "业务日 —", en: "Business day —" },
    "admin.usage.tokensIn": { zh: "累计输入 tokens", en: "Cumulative input tokens" },
    "admin.usage.tokensOut": { zh: "累计输出 tokens", en: "Cumulative output tokens" },
    "admin.usage.breakdownTitle": { zh: "调用来源构成", en: "Call source breakdown" },
    "admin.usage.thBucket": { zh: "口径", en: "Basis" },
    "admin.usage.thCallCount": { zh: "调用数", en: "Calls" },
    "admin.usage.thDesc": { zh: "说明", en: "Notes" },

    /* ---- API Key ---- */
    /* 词条含 <code> 标记，故 index.html 上需同时挂 data-i18n 与 data-i18n-html="self" */
    "admin.keys.sub": {
      zh: "客户端用 <code>Authorization: Bearer sk-…</code> 调 OpenAI <code>/v1/chat/completions</code> 或 Anthropic <code>/v1/messages</code>，按 Key/模型路由到账号池",
      en: "Clients call OpenAI <code>/v1/chat/completions</code> or Anthropic <code>/v1/messages</code> with <code>Authorization: Bearer sk-…</code>; requests route to the account pool by key and model",
    },
    "admin.keys.gatewayOn": { zh: "网关已启用", en: "Gateway enabled" },
    "admin.keys.create": { zh: "创建 Key", en: "Create key" },
    "admin.keys.thPrefix": { zh: "前缀", en: "Prefix" },
    "admin.keys.thPlatform": { zh: "绑定平台", en: "Bound platform" },
    "admin.keys.thQuota": { zh: "计费", en: "Billing" },
    "admin.keys.billed": { zh: "成员钱包扣费", en: "Member wallet" },
    "admin.keys.unbilled": { zh: "不扣费（管理员）", en: "Not billed (admin)" },
    "admin.keys.thRate": { zh: "限流", en: "Rate limit" },

    /* ---- 签到记录 ---- */
    "admin.records.h1": { zh: "签到记录", en: "Check-in log" },
    "admin.records.clearAll": { zh: "清空全部", en: "Clear all" },
    "admin.records.thTime": { zh: "时间", en: "Time" },
    "admin.records.thMessage": { zh: "消息", en: "Message" },

    /* ---- 账号对话框 ---- */
    /* 标题 #dlg-title 由 app.js 覆写，此处不进词表 */

    /* ---- API Key 对话框 ---- */
    "admin.keyDlg.create": { zh: "创建 API Key", en: "Create API key" },
    "admin.keyDlg.edit": { zh: "编辑 API Key", en: "Edit API key" },
    "admin.keyDlg.any": { zh: "任意", en: "Any" },
    "admin.keyDlg.boundPlatform": { zh: "绑定平台（可空）", en: "Bound platform (optional)" },
    "admin.keyDlg.boundPlatformShort": { zh: "绑定平台", en: "Bound platform" },
    "admin.keyDlg.ipAllowlist": { zh: "IP 白名单（逗号分隔，可空）", en: "IP allowlist (comma-separated, optional)" },
    "admin.keyDlg.ipAllowlistEdit": { zh: "IP 白名单（逗号分隔，空=不限）", en: "IP allowlist (comma-separated, blank = unlimited)" },
    "admin.keyDlg.ipPh": { zh: "例如 127.0.0.1,192.168.1.0/24", en: "e.g. 127.0.0.1,192.168.1.0/24" },
    "admin.keyDlg.rateLimit": { zh: "限流（次/分钟，可空）", en: "Rate limit (requests/min, optional)" },
    "admin.keyDlg.rateLimitEdit": { zh: "限流（次/分钟，留空或负数=不限）", en: "Rate limit (requests/min, blank or negative = unlimited)" },
    "admin.keyDlg.expiresAt": { zh: "过期时间（可空）", en: "Expires at (optional)" },
    "admin.keyDlg.expiresAtEdit": { zh: "过期时间（空=不过期）", en: "Expires at (blank = never)" },
    "admin.keyDlg.clearExpiresAt": { zh: "清除过期时间", en: "Clear expiry" },
    "admin.keyDlg.enabledRevoke": { zh: "启用（取消勾选=吊销）", en: "Enabled (uncheck to revoke)" },
    "admin.keyDlg.submit": { zh: "创建", en: "Create" },
    "admin.keyDlg.effortTitle": { zh: "思考强度策略（可空）", en: "Effort policy (optional)" },
    "admin.keyDlg.effortCeiling": { zh: "档位上限", en: "Effort ceiling" },
    "admin.keyDlg.effortNone": { zh: "不限", en: "Unlimited" },
    "admin.keyDlg.effortOver": { zh: "超限动作", en: "Over-limit action" },
    "admin.keyDlg.effortDowngrade": { zh: "压到上限（downgrade）", en: "Downgrade to ceiling" },
    "admin.keyDlg.effortDeny": { zh: "拒绝（deny，返回 403）", en: "Deny (403)" },
    "admin.keyDlg.effortMappings": { zh: "改写映射（每行一条）", en: "Rewrite mappings (one per line)" },
    "admin.keyDlg.effortMappingsPh": { zh: "xhigh=high\nxhigh=deny@gpt-6\nmax=high@claude*", en: "xhigh=high\nxhigh=deny@gpt-6\nmax=high@claude*" },
    "admin.keyDlg.effortMappingsInvalid": { zh: "映射格式应为 from=to 或 from=to@模型（前缀模型写作 模型*，后缀写作 *模型）", en: "Expected from=to or from=to@model (use model* for prefix, *model for suffix)" },
    "admin.keyDlg.effortHint": { zh: "仅作用于成员显式指定的思考档位：先按映射改写，再施加上限。留空=不限制。", en: "Only applies to explicitly requested effort levels: mappings rewrite first, then the ceiling applies. Blank = no limit." },

    /* ---- Key 已创建对话框 ---- */
    "admin.keyCreated.title": { zh: "API Key 已创建", en: "API key created" },
    "admin.keyCreated.hint": { zh: "仅显示这一次，请立刻复制保存。关闭后无法再次查看明文。", en: "Shown only once — copy it now. The plaintext cannot be viewed again after closing." },
    "admin.keyCreated.plaintext": { zh: "Key 明文（可选中复制）", en: "Key plaintext (selectable)" },
    "admin.keyCreated.copy": { zh: "复制 Key", en: "Copy key" },
    "admin.keyCreated.saved": { zh: "我已保存", en: "I saved it" },
    "admin.keyCreated.usageTitle": { zh: "用法（OpenAI 兼容）", en: "Usage (OpenAI-compatible)" },
    "admin.keyCreated.copySample": { zh: "复制示例", en: "Copy sample" },

    /* ---- 成员对话框 ---- */
    /* 标题 #member-dlg-title 与提示 #member-dlg-hint 由 app.js 覆写，此处不进词表 */
    "admin.memberDlg.username": { zh: "成员账号", en: "Member account" },
    "admin.memberDlg.usernamePh": { zh: "例如 xiaolin", en: "e.g. xiaolin" },
    "admin.memberDlg.displayName": { zh: "显示名称", en: "Display name" },
    "admin.memberDlg.displayNamePh": { zh: "例如 小林", en: "e.g. Lin" },
    "admin.memberDlg.initialPassword": { zh: "初始口令", en: "Initial password" },
    "admin.memberDlg.passwordPh": { zh: "至少 8 位，含字母和数字/符号", en: "At least 8 chars with letters and digits/symbols" },
    "admin.memberDlg.keyName": { zh: "Key 名称", en: "Key name" },
    "admin.memberDlg.keyNamePh": { zh: "留空则自动生成", en: "Leave blank to auto-generate" },
    "admin.memberDlg.enabled": { zh: "启用成员账号", en: "Enable member account" },
    "admin.memberDlg.submit": { zh: "开通并生成 Key", en: "Create and generate key" },

    /* ---- 模型单价对话框 ---- */
    /* 标题 #billing-rate-dlg-title 由 app.js 覆写，此处不进词表 */
    "admin.rateDlg.model": { zh: "公开模型 ID", en: "Public model ID" },
    "admin.rateDlg.modelPh": { zh: "例如 deepseek-v4.1-flash", en: "e.g. deepseek-v4.1-flash" },

    /* ---- 钱包操作对话框 ---- */
    /* 标题 #billing-wallet-dlg-title 由 app.js 覆写，此处不进词表 */
    "admin.walletDlg.action": { zh: "操作", en: "Action" },
    "admin.walletDlg.topUp": { zh: "充值", en: "Top up" },
    "admin.walletDlg.adjust": { zh: "调账（可为负）", en: "Adjust (may be negative)" },
    "admin.walletDlg.amount": { zh: "金额（元）", en: "Amount (CNY)" },

    /* ---- 成员 Key 已创建对话框 ---- */
    "admin.memberKey.title": { zh: "成员 Key 已创建", en: "Member key created" },
    "admin.memberKey.hint": { zh: "请把 Key 通过安全渠道发给成员。关闭后无法再次查看明文。", en: "Send the key to the member over a secure channel. The plaintext cannot be viewed again after closing." },
    "admin.memberKey.saved": { zh: "我已安全保存", en: "Saved securely" },

    /* ---- 登录台 ---- */
    /* 标题 #login-title 与按钮 #login-submit 由 app.js 按登录/首设两种形态覆写，此处不进词表 */
    "admin.login.username": { zh: "用户名", en: "Username" },
    "admin.login.password": { zh: "口令", en: "Password" },
    "admin.login.submit": { zh: "登录", en: "Sign in" },
    "admin.login.foot": { zh: "仅限服务维护者登录。账号与口令由管理员设置。", en: "Maintainers only. The account and password are set by the admin." },
    "admin.login.backHome": { zh: "← 返回首页", en: "← Back to home" },
    "admin.login.memberEntry": { zh: "成员入口 →", en: "Member portal →" },
    "admin.setup.hint": { zh: "首次使用，请设置管理员账号与口令。此入口在设置完成后自动失效。", en: "First run: set the admin account and password. This entry point stops working once setup is complete." },
    "admin.setup.newPassword": { zh: "新口令", en: "New password" },
    "admin.setup.confirmPassword": { zh: "确认口令", en: "Confirm password" },
    "admin.setup.token": { zh: "初始化令牌", en: "Setup token" },
    "admin.setup.tokenHint": { zh: "请输入安装时生成的初始化令牌。完成首次设置后，该令牌自动失效。", en: "Enter the setup token generated during installation. It stops working once initial setup is complete." },
    "admin.setupTokenRequired": { zh: "请填写安装时生成的初始化令牌，或在服务所在机器通过 localhost 完成首次设置", en: "Enter the setup token generated during installation, or complete setup via localhost on the server." },

    /* ---- 修改口令对话框 ---- */
    "admin.password.title": { zh: "修改口令", en: "Change password" },
    "admin.password.current": { zh: "当前口令", en: "Current password" },
    "admin.password.confirmNew": { zh: "确认新口令", en: "Confirm new password" },
    "admin.password.rule": { zh: "至少 8 位，需同时包含字母与数字/符号。", en: "At least 8 characters, with both letters and digits/symbols." },
    "admin.password.ruleLong": { zh: "至少 8 位，需同时包含字母与数字/符号。修改后所有旧会话失效。", en: "At least 8 characters, with both letters and digits/symbols. All existing sessions are invalidated after the change." },

    /* ---- 确认操作对话框 ---- */
    /* 标题 #dlg-confirm-title 与正文 #dlg-confirm-text 由 app.js 覆写，此处不进词表 */

    /* ================= app.js（管理台）动态文案 =================
       原则：一句话一条 key，禁止拼半句；插值用具名占位符。
       产品专名（WorkBuddy / Trae / Codex / OpenAI）、模型名（low…ultra）、
       字段名（accessToken / authFile / session / deviceId / codexHome /
       defaultReasoningEffort）与 URL 原地保留，不进词表。 */

    /* ---- 登录 / 首次设密 / 改口令 ---- */
    "admin.login.title": { zh: "管理台登录", en: "Admin sign-in" },
    "admin.login.title.setup": { zh: "首次设置管理员", en: "Set up the admin" },
    "admin.login.submit.setup": { zh: "创建并进入", en: "Create and enter" },
    "admin.login.err.required": { zh: "请填写用户名与口令", en: "Enter a username and password" },
    "admin.login.err.mismatch": { zh: "两次输入的口令不一致", en: "The passwords do not match" },
    "admin.login.err.tooShort": { zh: "口令至少 8 位", en: "Password must be at least 8 characters" },
    "admin.login.toast.done": { zh: "已登录", en: "Signed in" },
    "admin.login.toast.setupDone": { zh: "管理员口令已设置", en: "Admin password set" },
    "admin.login.toast.catchUp": { zh: "正在为 {count} 个未签账号补签", en: "Catching up check-ins for {count} unsigned account(s)" },
    "admin.password.err.mismatch": { zh: "两次输入的新口令不一致", en: "The new passwords do not match" },
    "admin.password.err.tooShort": { zh: "新口令至少 8 位", en: "New password must be at least 8 characters" },
    "admin.password.err.failed": { zh: "修改失败", en: "Change failed" },
    "admin.password.toast.done": { zh: "口令已修改，旧会话已失效", en: "Password changed — old sessions are now invalid" },
    "common.logout.confirm": { zh: "确定要退出登录吗？", en: "Sign out now?" },
    "common.logout.done": { zh: "已退出登录", en: "Signed out" },

    /* ---- 通用 ---- */
    "admin.error.requestFailed": { zh: "请求失败", en: "Request failed" },
    "admin.error.retryLater": { zh: "请稍后重试", en: "Please try again later" },
    "admin.load.failed": { zh: "加载失败：{message}", en: "Failed to load: {message}" },
    "admin.toast.deleted": { zh: "已删除", en: "Deleted" },
    "admin.copy.manual": { zh: "请手动 Ctrl+C 复制", en: "Press Ctrl+C to copy manually" },

    /* ---- 凭证状态 / 账号健康 ---- */
    "admin.credential.EXPIRED": { zh: "凭证过期", en: "Credential expired" },
    "admin.credential.ERROR": { zh: "凭证异常", en: "Credential error" },
    "admin.credential.UNKNOWN": { zh: "凭证未知", en: "Credential unknown" },
    "admin.credential.expiresIn": { zh: "{days} 天后过期", en: "Expires in {days} day(s)" },
    "admin.credential.remainingDays": { zh: "剩余 {days} 天", en: "{days} day(s) left" },
    "admin.credential.tipExpiresAt": { zh: " · 过期：{time}", en: " · Expires: {time}" },
    "admin.health.DISABLED": { zh: "停用", en: "Disabled" },
    "admin.health.CRED_WARN": { zh: "凭证临期", en: "Credential expiring soon" },
    "admin.health.USABLE": { zh: "可用", en: "Usable" },
    "admin.health.PENDING_CHECK": { zh: "待检查", en: "Pending check" },
    "admin.health.AUTH_ERROR": { zh: "失效", en: "Invalid" },
    "admin.health.ERROR": { zh: "异常", en: "Error" },
    "admin.health.NORMAL": { zh: "正常", en: "Healthy" },
    "admin.health.PENDING_SIGN": { zh: "待签", en: "Pending check-in" },

    /* ---- 签到 / 今日状态 ---- */
    "admin.status.SUCCESS": { zh: "成功", en: "Success" },
    "admin.checkin.status.ALREADY": { zh: "已签", en: "Already done" },
    "admin.checkin.status.INACTIVE": { zh: "未生效", en: "Not active" },
    "admin.checkin.status.AUTH_ERROR": { zh: "鉴权失败", en: "Auth failed" },
    "admin.checkin.NA": { zh: "不适用", en: "N/A" },
    "admin.checkin.none": { zh: "未签到", en: "Not checked in" },
    "admin.checkin.done": { zh: "已签到", en: "Checked in" },
    "admin.checkin.summary": { zh: "成功 {ok} · 待签 {pending} · 失败 {fail}", en: "{ok} done · {pending} pending · {fail} failed" },
    "admin.checkin.seg.ok": { zh: "成功 {count}", en: "{count} done" },
    "admin.checkin.seg.pending": { zh: "待签 {count}", en: "{count} pending" },
    "admin.checkin.seg.fail": { zh: "失败 {count}", en: "{count} failed" },
    "admin.checkin.toast.done": {
      zh: "签到完成：成功 {ok} · 已签 {already} · 失败 {fail}",
      en: "Check-in finished: {ok} done · {already} already · {fail} failed",
    },

    /* ---- 积分查询 ---- */
    "admin.credits.queryFailed": { zh: "查询失败", en: "Query failed" },
    "admin.credits.querying": { zh: "查询中…", en: "Checking…" },
    "admin.credits.window": { zh: "额度窗口", en: "Quota window" },
    "admin.credits.subscription": { zh: "订阅套餐", en: "Subscription" },
    "admin.credits.primary": { zh: "主窗口", en: "Primary window" },
    "admin.credits.secondary": { zh: "次窗口", en: "Secondary window" },
    "admin.credits.zcode5h": { zh: "5h 额度", en: "5h quota" },
    "admin.credits.zcodeWeekly": { zh: "周额度", en: "Weekly quota" },
    "admin.credits.cursorPlan": { zh: "订阅额度", en: "Plan quota" },
    "admin.credits.cursorOnDemand": { zh: "按需付费", en: "On-demand" },
    "admin.credits.plan": { zh: "套餐", en: "Plan" },
    "admin.credits.addon": { zh: "加购", en: "Add-on" },
    "admin.credits.organization": { zh: "组织", en: "Organization" },
    "admin.credits.unlimited": { zh: "不限量", en: "Unlimited" },
    "admin.credits.unavailable": { zh: "不可用", en: "Unavailable" },
    "admin.credits.openDashboard": { zh: "官网查看", en: "Open dashboard" },
    "admin.credits.used": { zh: "已用", en: "Used" },
    "admin.credits.reset": { zh: "重置", en: "Resets" },
    "admin.credits.empty": { zh: "暂无记录。调用一次网关后，积分扣减会异步回填。", en: "No entries yet. Credit deductions are backfilled after a gateway call." },
    "admin.credits.costUnknown.tip": { zh: "积分未知/待回填", en: "Credits unknown / pending backfill" },
    "admin.credits.costDerived.tip": { zh: "余额差推算", en: "Derived from the balance delta" },
    "admin.credits.toast.refreshed": { zh: "积分 / 额度已刷新", en: "Credits / quota refreshed" },
    "admin.credits.toast.refreshing": { zh: "积分 / 额度正在刷新，请稍候", en: "Credits / quota are being refreshed. Please wait." },
    "admin.credits.toast.batchDone": { zh: "已更新 {count} 个账号的积分 / 额度", en: "Updated credits / quota for {count} accounts" },
    "admin.credits.toast.batchFailed": { zh: "刷新完成：成功 {ok} 个，失败 {failed} 个；失败原因见对应账号", en: "Refresh finished: {ok} succeeded, {failed} failed. See the affected accounts for details." },
    "admin.credits.toast.noAccounts": { zh: "没有可刷新的已启用账号", en: "No enabled accounts to refresh" },
    "admin.credits.toast.invalidResponse": { zh: "积分 / 额度接口未返回账号结果", en: "The credits / quota endpoint returned no account result" },
    "admin.credits.toast.queryFailed": { zh: "{name}：查询失败，{message}", en: "{name}: query failed — {message}" },
    "admin.credits.toast.balance": { zh: "{name}：剩余积分 {amount}", en: "{name}: {amount} credits remaining" },
    "admin.credits.toast.quotaUpdated": { zh: "{name}：额度查询完成，请查看该行结果", en: "{name}: quota check complete. See the result in this row." },
    "admin.credits.toast.queryNote": { zh: "{name}：{message}", en: "{name}: {message}" },
    "admin.credits.toast.noQuotaData": { zh: "{name}：查询完成，但平台未返回可显示的积分或额度", en: "{name}: query complete, but the provider returned no displayable credits or quota." },

    /* ---- 总览 KPI ---- */
    "admin.overview.platforms": { zh: "WorkBuddy {wb} · Trae {trae} · Codex {codex}", en: "WorkBuddy {wb} · Trae {trae} · Codex {codex}" },
    "admin.overview.callsSub": { zh: "失败 {fail} · 成功率 {rate}%", en: "{fail} failed · {rate}% success rate" },

    /* ---- 账号列表 ---- */
    "admin.accounts.summary": { zh: "共 {total} 个 · 启用 {enabled} · 异常 {bad}", en: "{total} total · {enabled} enabled · {bad} failing" },
    "admin.accounts.creditsTotal": { zh: "总积分 {sum}", en: "Total credits {sum}" },
    "admin.accounts.creditsTotal.none": { zh: "总积分 —", en: "Total credits —" },
    "admin.accounts.creditsTotal.tip": { zh: "合计 {count} 个账号积分", en: "Summed across {count} account(s)" },
    "admin.accounts.creditsTotal.tipNone": { zh: "暂无可统计的积分", en: "No credits to total yet" },
    "admin.accounts.empty": { zh: "暂无账号", en: "No accounts yet" },
    "admin.accounts.emptyFiltered": { zh: "没有匹配的账号", en: "No matching accounts" },
    "admin.accounts.emptyHint": { zh: "暂无账号，点右上角「+ 添加账号」", en: "No accounts yet — click “+ Add account” in the top right" },
    "admin.accounts.codexCred": { zh: "codexHome={home} · 默认推理：{effort}", en: "codexHome={home} · Default reasoning: {effort}" },
    "admin.accounts.zcodeCred": { zh: "{channel} · Key {key}", en: "{channel} · Key {key}" },
    "admin.accounts.more": { zh: "更多操作", en: "More actions" },
    "admin.accounts.moreAria": { zh: "{name}的更多操作", en: "More actions for {name}" },
    "admin.accounts.act.checkin": { zh: "签到", en: "Check in" },
    "admin.accounts.act.creditQuery": { zh: "查额度", en: "Check quota" },
    "admin.accounts.act.updateCred": { zh: "更新凭证", en: "Update credential" },
    "admin.accounts.act.checkCred": { zh: "查凭证", en: "Verify credential" },
    "admin.accounts.act.refreshCredit": { zh: "刷积分", en: "Refresh credits" },
    "admin.accounts.act.edit": { zh: "编辑", en: "Edit" },
    "admin.accounts.act.enable": { zh: "启用", en: "Enable" },
    "admin.accounts.act.disable": { zh: "停用", en: "Disable" },
    "admin.accounts.act.del": { zh: "删除", en: "Delete" },
    "admin.accounts.dlg.edit": { zh: "编辑账号", en: "Edit account" },
    "admin.accounts.dlg.create": { zh: "添加账号", en: "Add account" },
    "admin.accounts.err.needCredential": { zh: "请至少填写一项凭证", en: "Fill in at least one credential" },
    "admin.accounts.err.repasteCredential": { zh: "编辑时请重新粘贴凭证（接口不回传明文）", en: "Paste the credential again when editing — the API never returns plaintext" },
    "admin.accounts.toast.updated": { zh: "账号已更新", en: "Account updated" },
    "admin.accounts.toast.created": { zh: "账号已创建", en: "Account created" },
    "admin.accounts.toast.checkin": { zh: "[{name}] {status}：{message}", en: "[{name}] {status}: {message}" },
    "admin.accounts.toast.checkinWithCredits": { zh: "[{name}] {status}：{message}（+{credits}）", en: "[{name}] {status}: {message} (+{credits})" },
    "admin.accounts.toast.pingOk": { zh: "[{name}] 通 · {latency}ms · {message}", en: "[{name}] reachable · {latency}ms · {message}" },
    "admin.accounts.toast.pingFail": { zh: "[{name}] 不通 · {latency}ms · {message}", en: "[{name}] unreachable · {latency}ms · {message}" },
    "admin.accounts.toast.credCheck": { zh: "[{name}] {status}：{message}", en: "[{name}] {status}: {message}" },
    "admin.accounts.toast.credCheckWithDays": { zh: "[{name}] {status} · 剩余 {days} 天：{message}", en: "[{name}] {status} · {days} day(s) left: {message}" },
    "admin.accounts.confirmDel": { zh: "确认删除账号「{name}」？", en: "Delete account “{name}”?" },
    "admin.credentials.toast.checked": { zh: "凭证检查完成：{count} 个账号，异常 {bad}", en: "Credential check finished: {count} account(s), {bad} failing" },
    "admin.cred.effort.modelDefault": { zh: "模型默认", en: "Model default" },
    "admin.cred.accessToken.label": { zh: "accessToken（与 authFile 二选一）", en: "accessToken (or authFile)" },
    "admin.cred.accessToken.ph": { zh: "粘贴 WorkBuddy accessToken", en: "Paste the WorkBuddy accessToken" },
    "admin.cred.authFile.label": { zh: "authFile（本机 workbuddy-desktop.info 路径）", en: "authFile (path to the local workbuddy-desktop.info)" },
    "admin.cred.authFile.ph": { zh: "例如 C:/Users/you/AppData/.../workbuddy-desktop.info", en: "e.g. C:/Users/you/AppData/.../workbuddy-desktop.info" },
    "admin.cred.session.label": { zh: "session（可选，登录后自动同步）", en: "session (optional; synced after sign-in)" },
    "admin.cred.session.ph": { zh: "可留空，使用“保存并授权”自动获取", en: "Leave blank to retrieve it with Save and authorize" },
    "admin.cred.deviceId.label": { zh: "deviceId（可选，16 位数字）", en: "deviceId (optional, 16 digits)" },
    "admin.cred.deviceId.ph": { zh: "缺省将随机生成", en: "Generated randomly if left blank" },
    "admin.cred.codexHome.label": { zh: "codexHome（绝对路径；先用独立 CODEX_HOME 登录 Codex）", en: "codexHome (absolute path; sign in to Codex with a dedicated CODEX_HOME first)" },
    "admin.cred.codexHome.ph": { zh: "例如 D:/manager/data/codex-accounts/account-1", en: "e.g. D:/manager/data/codex-accounts/account-1" },
    "admin.cred.mimoHome.label": { zh: "mimoHome（绝对路径；先用独立 MIMOCODE_HOME 执行 mimo providers login）", en: "mimoHome (absolute path; sign in with a dedicated MIMOCODE_HOME via mimo providers login first)" },
    "admin.cred.mimoHome.ph": { zh: "例如 D:/manager/data/mimo-accounts/account-1", en: "e.g. D:/manager/data/mimo-accounts/account-1" },
    "admin.cred.effort.label": { zh: "默认推理等级（客户端可覆盖）", en: "Default reasoning level (clients may override)" },
    "admin.cred.zcodeApiKey.label": { zh: "apiKey（zcode login 产出的 API Key）", en: "apiKey (the API key produced by zcode login)" },
    "admin.cred.zcodeApiKey.ph": { zh: "见 ~/.zcode/v2/config.json 中启用 provider 的 apiKey", en: "See the enabled provider apiKey in ~/.zcode/v2/config.json" },
    "admin.cred.zcodeChannel.label": { zh: "通道（决定上游端点）", en: "Channel (decides the upstream endpoint)" },
    "admin.cred.zcodeChannel.bigmodel": { zh: "BigModel 国内 Coding Plan", en: "BigModel CN Coding Plan" },
    "admin.cred.zcodeChannel.zai": { zh: "Z.ai 国际 Coding Plan", en: "Z.ai Global Coding Plan" },
    "admin.cred.zcodeChannel.plan": { zh: "轻量 Start Plan", en: "Start Plan" },
    "admin.cred.claudeAuthType.label": { zh: "接入方式", en: "Auth type" },
    "admin.cred.claudeAuthType.apikey": { zh: "API Key（Anthropic 控制台，按量计费）", en: "API Key (Anthropic Console, pay-as-you-go)" },
    "admin.cred.claudeAuthType.oauth": { zh: "OAuth 订阅号（Claude Code 订阅额度，可先建号再授权）", en: "OAuth subscription (Claude Code plan quota; create first, authorize later)" },
    "admin.cred.claudeApiKey.label": { zh: "apiKey（API Key 接入方式时必填）", en: "apiKey (required for API-key auth)" },
    "admin.cred.claudeApiKey.ph": { zh: "sk-ant-…", en: "sk-ant-…" },
    "admin.cred.claudeRefreshToken.label": { zh: "refreshToken（OAuth 接入方式时必填；留空沿用旧值）", en: "refreshToken (required for OAuth auth; leave blank to keep the current value)" },
    "admin.cred.claudeRefreshToken.ph": { zh: "粘贴 refreshToken，或留空后点「保存并授权」走浏览器授权", en: "Paste a refreshToken, or leave blank and click Save & Authorize for the browser flow" },
    "admin.cred.geminiApiKey.label": { zh: "apiKey（Google AI Studio）", en: "apiKey (Google AI Studio)" },
    "admin.cred.geminiApiKey.ph": { zh: "AIza…", en: "AIza…" },
    "admin.cred.grokApiKey.label": { zh: "apiKey（xAI 控制台）", en: "apiKey (xAI Console)" },
    "admin.cred.grokApiKey.ph": { zh: "xai-…", en: "xai-…" },

    /* ---- 成员列表 ---- */
    "admin.members.empty": { zh: "暂无成员，点右上角「+ 开通成员」创建成员账号和专属 Key", en: "No members yet — click “+ Add member” in the top right to create an account and a dedicated key" },
    "admin.members.key.none": { zh: "未分配 Key", en: "No key assigned" },
    "admin.members.key.disabled": { zh: "已停用", en: "Disabled" },
    "admin.members.act.edit": { zh: "编辑", en: "Edit" },
    "admin.members.act.disable": { zh: "停用成员", en: "Disable member" },
    "admin.members.act.restore": { zh: "恢复成员", en: "Restore member" },
    "admin.members.act.rotateKey": { zh: "轮换 Key", en: "Rotate key" },
    "admin.members.dlg.edit": { zh: "编辑成员", en: "Edit member" },
    "admin.members.dlg.create": { zh: "开通成员", en: "Add member" },
    "admin.members.hint.edit": { zh: "停用成员会同时停用其所有专属 Key；恢复后仅恢复最新一枚 Key。", en: "Disabling a member also disables all their dedicated keys; restoring re-enables only the newest key." },
    "admin.members.hint.create": { zh: "开通时会同步生成一枚专属 API Key，明文只显示一次。", en: "A dedicated API key is created at the same time; the plaintext is shown only once." },
    "admin.members.password.reset": { zh: "重置口令（留空不改） ", en: "Reset password (leave blank to keep) " },
    "admin.members.password.initial": { zh: "初始口令 ", en: "Initial password " },
    "admin.members.save.edit": { zh: "保存成员", en: "Save member" },
    "admin.members.save.create": { zh: "开通并生成 Key", en: "Create and generate key" },
    "admin.members.toast.updated": { zh: "成员「{name}」已更新", en: "Member “{name}” updated" },
    "admin.members.toast.enabled": { zh: "成员已恢复", en: "Member restored" },
    "admin.members.toast.disabled": { zh: "成员已停用", en: "Member disabled" },
    "admin.members.error.save": { zh: "保存失败：{message}", en: "Save failed: {message}" },
    "admin.members.error.create": { zh: "开通失败：{message}", en: "Creation failed: {message}" },
    "admin.members.confirmRotate": { zh: "确认轮换「{name}」的 API Key？旧 Key 会立即停用。", en: "Rotate the API key for “{name}”? The old key stops working immediately." },
    "admin.members.confirmEnable": { zh: "确认恢复成员「{name}」？", en: "Restore member “{name}”?" },
    "admin.members.confirmDisable": { zh: "确认停用成员「{name}」？ 停用会同步停用其专属 Key。", en: "Disable member “{name}”? This also disables their dedicated key." },

    /* ---- 计费 ---- */
    "admin.billing.on": { zh: "开", en: "On" },
    "admin.billing.off": { zh: "关", en: "Off" },
    "admin.billing.enabled": { zh: "启用", en: "Enabled" },
    "admin.billing.disabled": { zh: "停用", en: "Disabled" },
    "admin.billing.currency": { zh: "货币 {currency}", en: "Currency {currency}" },
    "admin.billing.legacyCurrency": { zh: "旧服务币种 {currency}", en: "Old server currency: {currency}" },
    "admin.billing.restartRequired": { zh: "当前服务仍按旧币种运行。请在 IDE 重启服务；人民币单价、钱包和流水操作已暂停。", en: "The server still uses the old currency. Restart it in the IDE; CNY rate, wallet, and ledger operations are paused." },
    "admin.billing.rateRestartRequired": { zh: "当前服务仍按旧计价单位运行。请在 IDE 重启服务；百万 Token 单价的展示和编辑已暂停。", en: "The server still uses an old rate unit. Restart it in the IDE; per 1M token rate display and editing are paused." },
    "admin.billing.restartShort": { zh: "待重启服务", en: "Restart needed" },
    "admin.billing.sub.on": { zh: "扣费已启用 · 模型单价 · 成员钱包 · 流水", en: "Charging on · model rates · member wallets · ledger" },
    "admin.billing.sub.off": { zh: "扣费关闭（可先配单价/充值）· 与 Token 配额分离", en: "Charging off (you can still set rates and top up) · separate from token quota" },
    "admin.billing.ratesEmpty": { zh: "暂无模型单价。点击「+ 模型单价」添加。", en: "No model rates yet. Click “+ Model rate” to add one." },
    "admin.billing.walletsEmpty": { zh: "暂无成员。先在「成员」页开通。", en: "No members yet. Create one on the Members page first." },
    "admin.billing.ledgerEmpty": { zh: "暂无流水。充值、调账或调用扣费后会出现在这里。", en: "No ledger entries yet. Top-ups, adjustments, and usage charges appear here." },
    "admin.billing.ledger.charge": { zh: "确认扣费", en: "Post charge" },
    "admin.billing.ledger.refund": { zh: "确认不扣费", en: "Confirm no charge" },
    "admin.billing.ledger.reviewTitle": { zh: "处理待核对流水", en: "Resolve usage review" },
    "admin.billing.ledger.reviewHintCharge": { zh: "核对实际用量后输入应扣金额。提交后会更新成员钱包和流水。", en: "Enter the verified charge. Submitting updates the member wallet and ledger." },
    "admin.billing.ledger.reviewHintRefund": { zh: "确认本次调用不扣费，并结束待核对状态。", en: "Confirm no charge for this call and close its review." },
    "admin.billing.ledger.reviewAmount": { zh: "应扣金额（元）", en: "Charge amount (CNY)" },
    "admin.billing.ledger.reserved": { zh: "预占", en: "Reserved" },
    "admin.billing.ledger.reservedInput": { zh: "预占金额（元）", en: "Reserved amount (CNY)" },
    "admin.billing.ledger.resolvedCharge": { zh: "已确认扣费", en: "Charge posted" },
    "admin.billing.ledger.resolvedRefund": { zh: "已确认不扣费", en: "Review closed without charge" },
    "admin.billing.ledger.invalidAmount": { zh: "请输入不小于 0 的金额，整数最多 12 位、小数最多 6 位。", en: "Enter a nonnegative amount with up to 12 integer and 6 decimal digits." },
    "admin.billing.ledger.confirmCharge": { zh: "确认向成员「{name}」扣费 {amount} 吗？该笔调用预占为 {reserved}，确认后立即生效。", en: "Charge {amount} to member “{name}”? This call has {reserved} on hold; the charge takes effect immediately." },
    "admin.billing.ledger.confirmRefund": { zh: "确认成员「{name}」的这笔调用不扣费吗？确认后将结束待核对状态。", en: "Confirm no charge for member “{name}”’s call? This closes the review." },
    "admin.billing.memberDisabled": { zh: " · 已停用", en: " · disabled" },
    "admin.billing.notOpened": { zh: "未开", en: "Not open" },
    "admin.billing.act.edit": { zh: "编辑", en: "Edit" },
    "admin.billing.act.enable": { zh: "启用", en: "Enable" },
    "admin.billing.act.disable": { zh: "停用", en: "Disable" },
    "admin.billing.act.del": { zh: "删除", en: "Delete" },
    "admin.billing.act.open": { zh: "开户", en: "Open wallet" },
    "admin.billing.act.walletOp": { zh: "充值/调账", en: "Top up / adjust" },
    "admin.billing.rate.edit": { zh: "编辑模型单价", en: "Edit model rate" },
    "admin.billing.rate.create": { zh: "新增模型单价", en: "New model rate" },
    "admin.billing.rate.toast.saved": { zh: "单价已保存", en: "Rate saved" },
    "admin.billing.rate.invalidAmount": { zh: "单价须为非负数，整数最多 12 位、小数最多 6 位。", en: "Rate must be nonnegative with up to 12 integer and 6 decimal digits." },
    "admin.billing.rate.confirmDel": { zh: "删除模型单价「{model}」？", en: "Delete the model rate for “{model}”?" },
    "admin.billing.draft.platform": { zh: "官方平台", en: "Official platform" },
    "admin.billing.draft.platformPh": { zh: "例如 DeepSeek 开放平台", en: "e.g. DeepSeek API" },
    "admin.billing.draft.platformMissing": { zh: "未标注", en: "Unlabeled" },
    "admin.billing.draft.usdPreviewTitle": { zh: "应用时按汇率 {rate} 折算为人民币（保留 2 位小数）", en: "Applied at rate {rate} to CNY (2 decimal places)" },
    "admin.billing.draft.usdNote": { zh: "美元单价应用时将按汇率 {rate} 自动折算为人民币（保留 2 位小数）；草稿保留美元原值，改汇率后可重新应用。", en: "USD drafts are converted to CNY at rate {rate} (2 decimal places) when applied; drafts keep their USD source values and can be re-applied after rate changes." },
    "admin.billing.draft.allPlatforms": { zh: "全部平台", en: "All platforms" },
    "admin.billing.draft.seed": { zh: "从模型目录补齐草稿", en: "Seed drafts from catalog" },
    "admin.billing.draft.new": { zh: "+ 新建草稿", en: "+ New draft" },
    "admin.billing.draft.create": { zh: "新增单价草稿", en: "New rate draft" },
    "admin.billing.draft.edit": { zh: "编辑单价草稿", en: "Edit rate draft" },
    "admin.billing.draft.unchecked": { zh: "未核对", en: "Unchecked" },
    "admin.billing.draft.priceHint": { zh: "价格可留空表示尚未核对；填写 0 表示官方免费。草稿不影响正式计费。", en: "Leave a price blank while unverified; 0 means officially free. Drafts do not affect live billing." },
    "admin.billing.draft.currency": { zh: "币种", en: "Currency" },
    "admin.billing.draft.sourceUrl": { zh: "官方定价页链接", en: "Official pricing URL" },
    "admin.billing.draft.checkedDate": { zh: "核对日期", en: "Checked date" },
    "admin.billing.draft.empty": { zh: "暂无单价草稿。点击「从模型目录补齐草稿」把系统支持的模型全部写入，再全网核对官方价。", en: "No rate drafts yet. Click “Seed drafts from catalog” to add every supported model, then research official prices." },
    "admin.billing.draft.statusDraft": { zh: "草稿", en: "Draft" },
    "admin.billing.draft.statusApplied": { zh: "已应用", en: "Applied" },
    "admin.billing.draft.act.apply": { zh: "应用到正式单价", en: "Apply to rates" },
    "admin.billing.draft.confirmApply": { zh: "把「{model}」的草稿价 输入{prompt} / 输出{completion} 应用为正式模型单价？将覆盖该模型现有正式单价。", en: "Apply draft prices for “{model}” (input {prompt} / output {completion}) to the official model rate? This overwrites its current rate." },
    "admin.billing.draft.confirmApplyForeign": { zh: "把「{model}」的草稿价 输入{prompt} / 输出{completion}（币种 {currency}，非人民币）应用为正式模型单价？正式单价按人民币扣费，应用前请先把数值换算成元。", en: "Apply draft prices for “{model}” (input {prompt} / output {completion}, currency {currency}, not CNY) to the official model rate? Live billing charges in CNY — convert the numbers first." },
    "admin.billing.draft.confirmApplyUsd": { zh: "应用 {model} 的美元单价草稿？{prompt} / {completion} 将按汇率 {rate} 折合为 {cnyPrompt} / {cnyCompletion} 写入正式单价（保留 2 位小数）。", en: "Apply the USD rate draft for {model}? {prompt} / {completion} will be converted at rate {rate} to {cnyPrompt} / {cnyCompletion} (2 decimal places)." },
    "admin.billing.draft.confirmDel": { zh: "删除模型「{model}」的单价草稿？", en: "Delete the rate draft for “{model}”?" },
    "admin.billing.draft.checkedAt": { zh: "核对 {date}", en: "Checked {date}" },
    "admin.billing.draft.sourceLink": { zh: "官方定价页", en: "Official pricing" },
    "admin.billing.draft.countTotal": { zh: "共 {total} 条草稿", en: "{total} drafts" },
    "admin.billing.draft.countHint": { zh: "共 {total} 条草稿 · 当前筛选 {count} 条", en: "{total} drafts · {count} shown" },
    "admin.billing.draft.modelRequired": { zh: "模型名不能为空", en: "Model name is required" },
    "admin.billing.draft.toast.saved": { zh: "草稿已保存", en: "Draft saved" },
    "admin.billing.draft.toast.seeded": { zh: "已补齐 {created} 条草稿（模型池共 {total} 个模型）", en: "Created {created} drafts (model pool has {total} models)" },
    "admin.billing.draft.toast.applied": { zh: "已应用到正式模型单价", en: "Applied to official model rates" },
    "billing.draftHint": { zh: "草稿用于记录全网核对的官方刊例价，不影响正式计费；核对完整后可一键应用到「模型单价」。", en: "Drafts record officially published prices researched from the web and do not affect live billing; apply them to “Model rates” once verified." },
    "billing.draft.thInputRate": { zh: "输入（官方价/百万 Token）", en: "Input (official, per 1M tokens)" },
    "billing.draft.thOutputRate": { zh: "输出（官方价/百万 Token）", en: "Output (official, per 1M tokens)" },
    "billing.draft.thCacheReadRate": { zh: "缓存读取（官方价/百万 Token）", en: "Cache read (official, per 1M tokens)" },
    "billing.draft.thCacheWriteRate": { zh: "缓存写入（官方价/百万 Token）", en: "Cache write (official, per 1M tokens)" },
    "admin.billing.wallet.dlgTitle": { zh: "钱包充值 / 调账", en: "Wallet top-up / adjustment" },
    "admin.billing.wallet.currentBalance": { zh: "当前余额", en: "Current balance" },
    "admin.billing.wallet.previewAfter": { zh: "操作后余额：{balance}（本次 {amount}）", en: "Balance after: {balance} ({amount})" },
    "admin.billing.wallet.previewInvalid": { zh: "请输入有效金额", en: "Enter a valid amount" },
    "admin.billing.memberDeleted": { zh: "已删除成员 {id}", en: "Deleted member {id}" },
    "admin.billing.wallet.toast.adjusted": { zh: "调账完成", en: "Adjustment complete" },
    "admin.billing.wallet.invalidAmount": { zh: "请输入非零金额，整数最多 12 位、小数最多 6 位；充值不能为负数。", en: "Enter a nonzero amount with up to 12 integer and 6 decimal digits. Top-ups cannot be negative." },
    "admin.billing.wallet.migrationRequired": { zh: "历史测试钱包，需先迁移为人民币", en: "Historical test wallet; migrate it to CNY first" },
    "admin.billing.wallet.toast.toppedUp": { zh: "充值完成", en: "Top-up complete" },
    "admin.billing.wallet.toast.opened": { zh: "钱包已开户", en: "Wallet opened" },
    "admin.billing.wallet.confirmTopUp": { zh: "确认为成员「{name}」充值 {amount} 吗？", en: "Top up {amount} for member “{name}”?" },
    "admin.billing.wallet.confirmAdjustAdd": { zh: "确认给成员「{name}」的余额调增 {amount} 吗？", en: "Add {amount} to member “{name}”’s balance?" },
    "admin.billing.wallet.confirmAdjustSub": { zh: "确认从成员「{name}」的余额扣减 {amount} 吗？", en: "Deduct {amount} from member “{name}”’s balance?" },

    /* ---- 签到记录 ---- */
    "admin.records.empty": { zh: "暂无记录", en: "No records yet" },
    "admin.records.count": { zh: "共 {count} 条", en: "{count} records" },
    /* 仅用于 JS 写入前的静态占位（真正的值由 renderRecords 覆写） */
    "admin.records.sub": { zh: "最近签到结果", en: "Recent check-in results" },
    /* 仅用于 JS 写入前的静态占位（真正的值由 uiConfirm 覆写） */
    "admin.dlg.confirmTitle": { zh: "确认操作", en: "Confirm action" },
    /* 仅用于 JS 写入前的静态占位（真正的值由 renderModels/renderBilling 覆写） */
    "admin.billing.wallet.dlgPlaceholder": { zh: "钱包操作", en: "Wallet action" },
    "admin.records.act.del": { zh: "删除", en: "Delete" },
    "admin.records.confirmDel": { zh: "确认删除这条签到记录？", en: "Delete this check-in record?" },
    "admin.records.confirmClear": { zh: "确定要清空所有签到记录吗？此操作不可恢复。", en: "Clear all check-in records? This cannot be undone." },
    "admin.records.dlgTitle.clear": { zh: "清空记录", en: "Clear records" },
    "admin.records.okText.clearAll": { zh: "全部删除", en: "Delete all" },
    "admin.records.toast.cleared": { zh: "记录已清空", en: "Records cleared" },

    /* ---- Key 列表 ---- */
    "admin.keys.empty": { zh: "暂无 Key", en: "No keys yet" },
    "admin.keys.enabled": { zh: "启用", en: "Enabled" },
    "admin.keys.revoked": { zh: "已吊销", en: "Revoked" },
    "admin.keys.perMinute": { zh: "{count}/分", en: "{count}/min" },
    "admin.keys.expiresAt": { zh: " · 过期 {time}", en: " · expires {time}" },
    "admin.keys.copyPrefix.tip": { zh: "复制前缀，用于在用量明细中定位", en: "Copy the prefix to locate this key in the usage detail" },
    "admin.keys.act.edit": { zh: "编辑", en: "Edit" },
    "admin.keys.act.enable": { zh: "启用", en: "Enable" },
    "admin.keys.act.disable": { zh: "停用", en: "Disable" },
    "admin.keys.act.revoke": { zh: "吊销", en: "Revoke" },
    "admin.keys.act.del": { zh: "删除", en: "Delete" },
    "admin.keys.act.delTip": { zh: "从数据库移除；有调用记录或成员专属 Key 不可删", en: "Removes it from the database; keys with call records or member-owned keys cannot be deleted" },
    "admin.keys.err.memberOwned": { zh: "成员专属 Key 不能直接删除，请通过成员管理处理", en: "A member-owned key cannot be deleted directly — manage it through the member instead" },
    "admin.keys.confirmRevoke": { zh: "确认吊销该 API Key？", en: "Revoke this API key?" },
    "admin.keys.confirmDelete": { zh: "确认删除「{name}」？将从数据库移除且不可恢复（吊销是可保留记录的软删除）。", en: "Delete “{name}”? It is removed from the database and cannot be recovered (revoking is a soft delete that keeps records)." },
    "admin.keys.confirmDeleteUnnamed": { zh: "确认删除该 Key？将从数据库移除且不可恢复（吊销是可保留记录的软删除）。", en: "Delete this key? It is removed from the database and cannot be recovered (revoking is a soft delete that keeps records)." },
    "admin.keys.dlgTitle.delete": { zh: "删除 Key", en: "Delete key" },
    "admin.keys.okText.delete": { zh: "删除", en: "Delete" },
    "admin.keys.toast.updated": { zh: "Key 已更新", en: "Key updated" },
    "admin.keys.toast.deleted": { zh: "Key 已删除", en: "Key deleted" },
    "admin.key.sample.hello": { zh: "你好", en: "Hello" },
    "admin.key.sample.orComment": { zh: "# 或 trae/gpt-4o", en: "# or trae/gpt-4o" },

    /* ---- 用量 ---- */
    "admin.usage.src.known": { zh: "已知", en: "Known" },
    "admin.usage.src.known.tip": { zh: "上游返回了 usage", en: "The upstream returned usage" },
    "admin.usage.src.estimated": { zh: "估算", en: "Estimated" },
    "admin.usage.src.estimated.tip": { zh: "上游未回 usage，网关按内容估算", en: "Upstream returned no usage; the gateway estimated it from the content" },
    "admin.usage.src.unknown": { zh: "未知", en: "Unknown" },
    "admin.usage.src.unknown.tip": { zh: "无 usage 数据，用量未知", en: "No usage data; consumption is unknown" },
    "admin.usage.sourceSub": { zh: "已知 {known} · 估算 {estimated} · 未知 {unknown} · 失败 {fail}", en: "{known} known · {estimated} estimated · {unknown} unknown · {fail} failed" },
    "admin.usage.creditUnknown": { zh: "未知 {count} 条未计入", en: "{count} unattributed entr(y/ies) excluded" },
    "admin.usage.empty": { zh: "暂无调用记录。用 API Key 调一次 {code} 即可看到实时用量。", en: "No calls yet. Make one call to {code} with an API key to see live usage." },
    "admin.usage.conn.connected": { zh: "实时已连接", en: "Live — connected" },
    "admin.usage.conn.disconnected": { zh: "已断开", en: "Disconnected" },
    "admin.usage.conn.paused": { zh: "已暂停", en: "Paused" },
    "admin.usage.conn.connecting": { zh: "连接中…", en: "Connecting…" },
    "admin.usage.conn.reconnecting": { zh: "重连中…", en: "Reconnecting…" },
    "admin.usage.conn.unavailable": { zh: "SSE 不可用", en: "SSE unavailable" },

    /* ---- 历史总调用（lifetime） ---- */
    "admin.lifetime.failRate": { zh: "占比 {rate}%", en: "{rate}% of calls" },
    "admin.lifetime.noCalls": { zh: "暂无调用", en: "No calls yet" },
    "admin.lifetime.spanNone": { zh: "暂无调用记录", en: "No calls yet" },
    "admin.lifetime.spanSince": { zh: "自 {date} 起", en: "Since {date}" },
    "admin.lifetime.credit": { zh: "累计扣积分 {credit}", en: "{credit} credits charged in total" },
    "admin.lifetime.creditWithUnknown": { zh: "累计扣积分 {credit} · {unknown} 条未归因", en: "{credit} credits charged in total · {unknown} unattributed" },
    "admin.lifetime.row.all": { zh: "全部调用", en: "All calls" },
    "admin.lifetime.note.all": { zh: "包含成功、失败与中断", en: "Includes successful, failed, and aborted calls" },
    "admin.lifetime.row.known": { zh: "成功（KNOWN）", en: "Success (KNOWN)" },
    "admin.lifetime.note.known": { zh: "上游返回了真实 usage", en: "The upstream returned real usage" },
    "admin.lifetime.row.estimated": { zh: "估算（ESTIMATED）", en: "Estimated (ESTIMATED)" },
    "admin.lifetime.note.estimated": { zh: "按字符数估算，非上游原值", en: "Estimated from character counts, not an upstream value" },
    "admin.lifetime.row.unknown": { zh: "未知（UNKNOWN）", en: "Unknown (UNKNOWN)" },
    "admin.lifetime.note.unknown": { zh: "上游未返回 usage，未计费", en: "The upstream returned no usage; not charged" },
    "admin.lifetime.row.failed": { zh: "失败 / 中断", en: "Failed / aborted" },
    "admin.lifetime.note.failed": { zh: "非 OK 状态，含 ABORTED", en: "Any non-OK status, including ABORTED" },

    /* ---------- 后端通用错误码（GlobalExceptionHandler 直接产生）---------- */
    "err.validation": { zh: "参数校验失败", en: "Request validation failed" },
    "err.validation.field": { zh: "字段 {field} 不合法：{reason}", en: "Field {field} is invalid: {reason}" },
    "err.internal": { zh: "服务内部错误，请稍后重试（{detail}）", en: "Internal server error, please retry ({detail})" },

    /* ---------- 后端错误码（err 语义：均由 BusinessException.code 驱动）----------
     * 键名与后端 BusinessException 构造时传入的 code 完全一致；
     * 前端用 window.loeanI18n.errorText(body) 解析：命中词表则按当前语言渲染，
     * 未命中则回退响应里的 error 原文（后端中文），保证漏配不白屏。
     * {name} 占位符必须与后端 .param(name, value) 的名字逐字对应。 */
    "account.accessTokenUnresolved": { zh: "无法解析 accessToken", en: "Unable to resolve accessToken" },
    "account.codexHomeHasLoadableContent": { zh: "codexHome 不能包含可加载的 Codex 配置或扩展：{name}", en: "codexHome cannot contain loadable Codex configuration or extensions: {name}" },
    "account.codexHomeInUse": { zh: "codexHome 已被其他 CODEX 账号使用", en: "codexHome is already used by another CODEX account" },
    "account.codexHomeInspectionFailed": { zh: "无法检查 codexHome 中的配置或扩展", en: "Failed to inspect Codex configuration or extensions in codexHome" },
    "account.codexHomeNotAbsolute": { zh: "codexHome 必须是绝对路径", en: "codexHome must be an absolute path" },
    "account.codexHomeNotAccessible": { zh: "codexHome 目录不存在或路径无效；请先用该 CODEX_HOME 完成登录", en: "codexHome does not exist or the path is invalid; sign in with that CODEX_HOME first" },
    "account.codexHomeNotDirectChild": { zh: "codexHome 必须是 manager.codex.home-root 下的直接子目录", en: "codexHome must be a direct subdirectory of manager.codex.home-root" },
    "account.codexHomeNotDirectory": { zh: "codexHome 必须是已存在的目录", en: "codexHome must be an existing directory" },
    "account.codexHomeRequired": { zh: "CODEX 账号必须提供独立的 codexHome 绝对路径", en: "CODEX accounts must provide a dedicated absolute codexHome path" },
    "account.codexHomeRootInvalid": { zh: "Codex 账号根目录不存在或无效：manager.codex.home-root", en: "Codex account root directory is missing or invalid: manager.codex.home-root" },
    "account.codexPluginsCustomContent": { zh: "codexHome 不能包含自定义 plugins 内容", en: "codexHome cannot contain custom plugins content" },
    "account.codexPluginsDirInvalid": { zh: "codexHome 不能包含外部或无效的 plugins 目录", en: "codexHome cannot contain an external or invalid plugins directory" },
    "account.codexReasoningEffortInvalid": { zh: "CODEX 默认推理等级无效：{value}", en: "Invalid CODEX default reasoning effort: {value}" },
    "account.codexSkillsCustomContent": { zh: "codexHome 不能包含自定义 skills 内容", en: "codexHome cannot contain custom skills content" },
    "account.codexSkillsDirInvalid": { zh: "codexHome 不能包含外部或无效的 skills 目录", en: "codexHome cannot contain an external or invalid skills directory" },
    "account.credentialParseFailed": { zh: "账号凭证 JSON 解析失败：{id}", en: "Failed to parse account credential JSON: {id}" },
    "account.credentialSerializeFailed": { zh: "凭证序列化失败", en: "Failed to serialize credentials" },
    "account.credentialsRequired": { zh: "credentials 不能为空", en: "Credentials cannot be empty" },
    "account.zcodeApiKeyRequired": { zh: "ZCODE 账号必须提供 apiKey", en: "ZCODE accounts must provide an apiKey" },
    "account.zcodeApiKeyInUse": { zh: "该 ZCode API Key 已属于另一个账号", en: "This ZCode API key already belongs to another account" },
    "account.zcodeChannelInvalid": { zh: "ZCODE 通道无效：{value}", en: "Invalid ZCODE channel: {value}" },
    "account.claudeAuthTypeInvalid": { zh: "CLAUDE authType 无效：{value}（可选 oauth/apikey）", en: "Invalid CLAUDE authType: {value} (oauth or apikey)" },
    "account.claudeRefreshTokenRequired": { zh: "CLAUDE OAuth 账号必须提供 refreshToken", en: "CLAUDE OAuth accounts must provide a refreshToken" },
    "account.claudeRefreshTokenInUse": { zh: "该 CLAUDE refreshToken 已属于另一个账号", en: "This CLAUDE refreshToken already belongs to another account" },
    "account.claudeApiKeyRequired": { zh: "CLAUDE 账号必须提供 apiKey", en: "CLAUDE accounts must provide an apiKey" },
    "account.claudeApiKeyInUse": { zh: "该 CLAUDE apiKey 已属于另一个账号", en: "This CLAUDE apiKey already belongs to another account" },
    "account.geminiApiKeyRequired": { zh: "GEMINI 账号必须提供 apiKey", en: "GEMINI accounts must provide an apiKey" },
    "account.geminiApiKeyInUse": { zh: "该 GEMINI apiKey 已属于另一个账号", en: "This GEMINI apiKey already belongs to another account" },
    "account.grokApiKeyRequired": { zh: "GROK 账号必须提供 apiKey", en: "GROK accounts must provide an apiKey" },
    "account.grokApiKeyInUse": { zh: "该 GROK apiKey 已属于另一个账号", en: "This GROK apiKey already belongs to another account" },
    "account.oauthFlowExpired": { zh: "授权流程不存在或已过期，请重新发起", en: "The authorization flow is gone or expired. Start again." },
    "account.oauthInputRequired": { zh: "请粘贴授权回调地址或授权码", en: "Paste the authorization callback URL or the code" },
    "account.oauthStateMismatch": { zh: "授权回调 state 不匹配，请重新发起授权", en: "Callback state mismatch. Start the authorization again." },
    "account.mimoHomeRequired": { zh: "MIMO 账号必须提供 mimoHome 绝对路径", en: "MIMO accounts must provide a dedicated absolute mimoHome path" },
    "account.mimoHomeInUse": { zh: "mimoHome 已被其他 MIMO 账号使用", en: "mimoHome is already used by another MIMO account" },
    "account.mimoHomeNotAccessible": { zh: "mimoHome 目录不存在或路径无效；请先用该 MIMOCODE_HOME 完成登录", en: "mimoHome does not exist or the path is invalid; sign in with that MIMOCODE_HOME first" },
    "account.mimoHomeNotDirectChild": { zh: "mimoHome 必须是 manager.mimo.home-root 下的直接子目录", en: "mimoHome must be a direct child of manager.mimo.home-root" },
    "account.mimoHomeNotDirectory": { zh: "mimoHome 必须是已存在的目录", en: "mimoHome must be an existing directory" },
    "account.mimoHomeNotAbsolute": { zh: "mimoHome 必须是绝对路径", en: "mimoHome must be an absolute path" },
    "account.notMimoPlatform": { zh: "账号不是 MIMO 平台", en: "Account is not a MIMO platform account" },
    "account.notCodexPlatform": { zh: "账号不是 CODEX 平台", en: "Account is not a CODEX platform account" },
    "account.notFound": { zh: "账号不存在：{id}", en: "Account not found: {id}" },
    "account.traeSessionInvalid": { zh: "Trae session 无效，请重新输入或使用登录功能自动获取", en: "Invalid Trae session. Enter it again or use sign-in to retrieve it automatically." },
    "account.traeLoginExpired": { zh: "Trae 登录已失效，请点击重新登录", en: "Trae sign-in has expired. Sign in again." },
    "account.concurrentUpdate": { zh: "Trae 登录信息刚被更新，请重新打开账号编辑窗口", en: "Trae sign-in changed while you were editing. Reopen this account and try again." },
    "account.traeSessionAlreadyUsed": { zh: "该 Trae 登录会话已绑定另一个账号，请确认登录的账号", en: "This Trae session is already assigned to another account. Check which account you signed in to." },
    "account.traeSessionMissing": { zh: "缺少 session", en: "Missing session" },
    "account.traeSessionRequired": { zh: "TRAE 账号必须提供 session（X-Cloudide-Session）", en: "TRAE accounts must provide a session (X-Cloudide-Session)" },
    "account.traeTokenMissing": { zh: "GetUserToken 未返回 Token", en: "GetUserToken returned no token" },
    "account.unsupportedPlatform": { zh: "不支持的平台：{platform}", en: "Unsupported platform: {platform}" },
    "account.upstreamRejected": { zh: "{message}", en: "Upstream rejected the request: {message}" },
    "account.workbuddyCredentialRequired": { zh: "WORKBUDDY 账号必须提供 accessToken 或 authFile 之一", en: "WORKBUDDY accounts must provide either accessToken or authFile" },
    "admin.changePasswordFailed": { zh: "修改失败：当前口令不正确，或新口令不符合要求", en: "Change failed: the current password is incorrect, or the new password does not meet requirements" },
    "admin.credentialsRequired": { zh: "用户名和口令不能为空", en: "Username and password cannot be empty" },
    "admin.disabled": { zh: "管理端鉴权未启用（manager.admin.enabled=false）", en: "Admin authentication is not enabled (manager.admin.enabled=false)" },
    "admin.disabledLoopbackOnly": { zh: "管理端鉴权已关闭（manager.admin.enabled=false），仅允许本机访问管理接口", en: "Admin authentication is disabled (manager.admin.enabled=false); management APIs are only reachable from localhost" },
    "admin.loginFailed": { zh: "用户名或口令错误，或失败次数过多已被临时锁定", en: "Incorrect username or password, or too many failed attempts and the account is temporarily locked" },
    "admin.newPasswordMismatch": { zh: "两次输入的新口令不一致", en: "The two new passwords do not match" },
    "admin.passwordAlreadySet": { zh: "管理员口令已设置过，请直接登录", en: "The admin password has already been set; please sign in" },
    "admin.passwordFieldsRequired": { zh: "请填写当前口令与新口令", en: "Please enter your current password and a new password" },
    "admin.passwordMismatch": { zh: "两次输入的口令不一致", en: "The two passwords do not match" },
    "admin.passwordTooWeak": { zh: "{reason}", en: "Password does not meet requirements: {reason}" },
    "admin.setupConflict": { zh: "设置失败：口令可能已被其他请求先行设置，请刷新后重试", en: "Setup failed: the password may have been set by another request; refresh and try again" },
    "admin.setupLoopbackOnly": { zh: "出于安全考虑，首次设置仅允许在本机完成：请通过 localhost 访问管理台（远程请使用 SSH 隧道）", en: "For security, first-time setup can only be done on this machine: open the admin console via localhost (use an SSH tunnel when remote)" },
    "admin.setupRequired": { zh: "尚未设置管理员口令，请先完成首次设置", en: "The admin password has not been set yet; complete the initial setup first" },
    "admin.unauthenticated": { zh: "未认证：请先登录", en: "Not authenticated: please sign in first" },
    "admin.usernameRequired": { zh: "用户名不能为空", en: "Username cannot be empty" },
    "apikey.memberIdRequired": { zh: "成员 ID 不能为空", en: "Member ID cannot be empty" },
    "apikey.memberKeyNotDeletable": { zh: "成员专属 Key 不能直接删除，请通过成员管理处理", en: "A member-owned key cannot be deleted directly; manage it through Members" },
    "apikey.nameRequired": { zh: "name 不能为空", en: "Name cannot be empty" },
    "apikey.notFound": { zh: "API Key 不存在：{id}", en: "API key not found: {id}" },
    "apikey.quotaReserved": { zh: "该 Key 有未结算的配额预占（{reserved}）", en: "This key has unsettled reserved quota ({reserved})" },
    "billing.adjustAmountZero": { zh: "调账金额不能为 0", en: "Adjustment amount cannot be 0" },
    "billing.amountInvalid": { zh: "金额格式无效：最多保留 6 位小数且不能超出范围", en: "Invalid amount: use at most 6 decimal places and stay within the supported range" },
    "billing.insufficientBalance": { zh: "余额不足，当前 {balance}，调账后将为 {after}", en: "Insufficient balance: currently {balance}, would become {after} after adjustment" },
    "billing.usageInsufficientBalance": { zh: "钱包余额 {balance} 不足以预占本次预计费用 {required}", en: "Wallet balance {balance} cannot cover the estimated charge of {required}" },
    "billing.memberDisabled": { zh: "成员已停用，无法预占费用", en: "This member is disabled and cannot reserve a charge" },
    "billing.memberNotFound": { zh: "成员不存在", en: "Member not found" },
    "billing.modelNameRequired": { zh: "模型名不能为空", en: "Model name cannot be empty" },
    "billing.notReviewable": { zh: "只有待核对的调用流水可以人工处理", en: "Only usage entries awaiting review can be resolved" },
    "billing.ledgerNotFound": { zh: "计费流水不存在", en: "Billing ledger entry not found" },
    "billing.rateInvalid": { zh: "模型单价无效：不能为负，最多保留 6 位小数", en: "Invalid model rate: it cannot be negative and may have at most 6 decimal places" },
    "billing.rateNotConfigured": { zh: "模型 {model} 未配置单价或非零兜底价", en: "No model rate or nonzero fallback rate is configured for {model}" },
    "billing.rateNotFound": { zh: "单价不存在", en: "Model rate not found" },
    "billing.reservationMissing": { zh: "计费预占流水不存在", en: "Billing reservation not found" },
    "billing.resolveActionInvalid": { zh: "处理方式必须是确认扣费或退款", en: "Choose charge or refund to resolve this entry" },
    "billing.topUpAmountInvalid": { zh: "充值金额必须大于 0（{amount}）", en: "Top-up amount must be greater than 0 ({amount})" },
    "billing.walletMissing": { zh: "成员钱包尚未开户", en: "This member's wallet has not been opened" },
    "billing.walletCurrencyMismatch": { zh: "旧币种钱包（{currency}）尚未迁移，不能进行人民币充值或扣费", en: "The {currency} wallet has not been migrated and cannot be topped up or charged in CNY" },
    "billing.ledgerCurrencyMismatch": { zh: "历史流水（{currency}）不能参与人民币钱包结算", en: "Historical {currency} ledger entries cannot be settled against a CNY wallet" },
    "checkin.codexNotSupported": { zh: "Codex 订阅账号没有签到操作", en: "Codex subscription accounts do not support check-in" },
    "checkin.noAccounts": { zh: "没有可签到的账号", en: "No accounts available for check-in" },
    "checkin.recordNotFound": { zh: "记录不存在：{id}", en: "Record not found: {id}" },
    "gateway.requestIdRequired": { zh: "requestId 不能为空", en: "requestId cannot be empty" },
    "gateway.traceNotFound": { zh: "未找到该 requestId 的调用记录（可能未经过网关，或已超出保留期）", en: "No call record found for this requestId (it may not have gone through the gateway, or it is past the retention period)" },
    "member.credentialsRequired": { zh: "请填写成员账号与密码", en: "Please enter your member account and password" },
    "member.disabled": { zh: "成员账号已停用", en: "Member account is disabled" },
    "member.displayNameFormat": { zh: "成员名称需为 1-64 个字符", en: "Member name must be 1–64 characters" },
    "member.loginFailed": { zh: "成员账号或密码错误，账号可能已停用或被临时锁定", en: "Incorrect member account or password; the account may be disabled or temporarily locked" },
    "member.noApiKey": { zh: "尚未分配 API Key", en: "No API key has been assigned yet" },
    "member.notFound": { zh: "成员不存在：{id}", en: "Member not found: {id}" },
    "member.passwordInvalid": { zh: "{reason}", en: "Invalid password: {reason}" },
    "member.portalDisabled": { zh: "成员空间暂未启用", en: "Member portal is not enabled" },
    "member.unauthenticated": { zh: "未认证：请先登录成员空间", en: "Not authenticated: please sign in to the member portal first" },
    "member.usernameFormat": { zh: "成员账号需为 3-64 位字母、数字、点、短横线或下划线", en: "Member account must be 3–64 characters of letters, digits, dots, hyphens or underscores" },
    "member.usernameTaken": { zh: "成员账号已存在：{username}", en: "Member account already exists: {username}" },
  };

  /* ---------- 语言判定：localStorage 优先，否则跟随浏览器 ---------- */
  function normalizeLang(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    if (raw.startsWith("zh")) return "zh";
    if (SUPPORTED.includes(raw)) return raw;
    return "en";
  }

  function readStored() {
    try {
      return normalizeLang(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      return "";
    }
  }

  function detectBrowser() {
    const list = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || ""];
    for (const item of list) {
      const lang = normalizeLang(item);
      if (lang) return lang;
    }
    return DEFAULT_LANG;
  }

  let current = readStored() || detectBrowser() || DEFAULT_LANG;

  /* ---------- 取词：缺 en 时回退 zh，缺 key 时回退 key 本身（方便肉眼发现漏翻） ---------- */
  function interpolate(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
  }

  function t(key, params) {
    const entry = DICT[key];
    if (!entry) return key;
    const text = entry[current] || entry[DEFAULT_LANG] || key;
    return interpolate(text, params);
  }

  /* 数字与日期的 locale：中文用 zh-CN，英文用 en-US。
     成员端所有 toLocaleString/toLocaleDateString 都必须走这里，
     否则切成英文后数字与日期仍是中文格式。 */
  function locale() {
    return current === "zh" ? "zh-CN" : "en-US";
  }

  /* ---------- 后端错误：把 code + params 渲染成当前语言 ----------
   * 后端 BusinessException 带 code 与命名参数（见 GlobalExceptionHandler），
   * 响应形如 { success:false, error:"账号不存在: 3", code:"account.notFound",
   *           params:{ id:3 } }。
   *
   * 解析顺序：
   *   1) code 有对应词条 → 用词表渲染（跟随语言）；
   *   2) 否则回退 body.error 原文（未码化的老接口、或新增码但词表还没补）；
   *   3) 都没有 → 传进来的兜底 key。
   * 这样任一侧漏配都不会白屏，也不会把中文泄露给英文用户以外的人。
   */
  function errorText(body, fallbackKey, fallbackParams) {
    if (body && typeof body === "object") {
      const code = body.code;
      if (code && Object.prototype.hasOwnProperty.call(DICT, code)) {
        return t(code, body.params || {});
      }
      if (body.error) return String(body.error);
    }
    return fallbackKey ? t(fallbackKey, fallbackParams) : "";
  }

  function formatNumber(value, options) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString(locale(), options);
  }

  /* ---------- 应用到 DOM ---------- */
  function applyOne(el) {
    const key = el.dataset.i18n;
    if (key) {
      /* data-i18n-html="self" 表示这条词条本身含标记（如 <br /><em>），用 innerHTML 注入 */
      if (el.dataset.i18nHtml === "self" || el.dataset.i18nHtml === "true") {
        el.innerHTML = t(key);
      } else {
        el.textContent = t(key);
      }
    }
    const attrSpec = el.dataset.i18nAttr;
    if (attrSpec) {
      attrSpec.split(",").forEach((pair) => {
        const [attr, attrKey] = pair.split(":").map((s) => s && s.trim());
        if (!attr || !attrKey) return;
        el.setAttribute(attr, t(attrKey));
      });
    }
  }

  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach(applyOne);
    scope.querySelectorAll("[data-i18n-attr]").forEach(applyOne);
    scope.querySelectorAll("[data-i18n-html]").forEach(applyOne);
    document.documentElement.lang = current === "zh" ? "zh-CN" : current;
  }

  function updateSwitchers() {
    document.querySelectorAll("[data-lang-toggle]").forEach((button) => {
      button.setAttribute("title", t("common.lang.toggle.title"));
      const label = button.querySelector("[data-lang-label]");
      if (label) label.textContent = t("common.lang.toggle.label");
      button.setAttribute("aria-label", t("common.lang.toggle.title"));
    });
  }

  function setLang(next, persist) {
    const lang = normalizeLang(next) || DEFAULT_LANG;
    const changed = lang !== current;
    current = lang;
    if (persist !== false) {
      try {
        window.localStorage.setItem(STORAGE_KEY, lang);
      } catch {
        // 隐私模式/禁用存储不应阻断切换。
      }
    }
    if (changed) {
      apply();
      updateSwitchers();
      document.dispatchEvent(new CustomEvent("loean:langchange", { detail: { lang } }));
    }
  }

  function bind() {
    document.querySelectorAll("[data-lang-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        setLang(current === "zh" ? "en" : "zh", true);
      });
    });
    updateSwitchers();
  }

  window.loeanI18n = {
    t,
    apply,
    errorText,
    locale,
    formatNumber,
    current: () => current,
    set: (lang) => setLang(lang, true),
    toggle: () => setLang(current === "zh" ? "en" : "zh", true),
    /* 词表里是否已覆盖某 key，供后续批次自检用 */
    has: (key) => Object.prototype.hasOwnProperty.call(DICT, key),
  };

  /* 防闪 C：中文路径不做任何替换；非中文时在首次绘制前就换掉 */
  if (current !== DEFAULT_LANG) {
    const run = () => apply();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
      /* 同步脚本已在 head 执行，这里用 rAF 争取在首帧前替换完 */
      requestAnimationFrame(() => {
        if (document.body) apply();
      });
    } else {
      run();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else {
    bind();
  }
})();
