/* Owl UI review prototype. Synthetic data only. No bridge requests or app writes. */
(function () {
  'use strict';
  const esc = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const text = (id, value, tagName = 'span', cls = '') => `<${tagName} class="${cls}" data-fd-id="${id}" data-fd-editable="text">${esc(value)}</${tagName}>`;
  const b = (label, action, cls = '', id = action) => {
    const markup = button(label, action, cls);
    const anchor = `data-fd-id="settings-btn-${id}"`;
    return /data-fd-id=/.test(markup) ? markup.replace(/data-fd-id="[^"]*"/, anchor) : markup.replace('<button', `<button ${anchor}`);
  };
  const i = (id, value = '', placeholder = '', type = 'text') => `<input class="input" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" data-fd-id="settings-field-${id}" data-fd-editable="value" aria-label="${esc(id)}">`;
  const s = (id, options, selected = '') => `<select class="select" data-fd-id="settings-field-${id}" data-fd-editable="value" aria-label="${esc(id)}">${options.map(option => { const pair = typeof option === 'string' ? [option, option] : option; return `<option value="${esc(pair[0])}" ${pair[0] === selected ? 'selected' : ''}>${esc(pair[1])}</option>`; }).join('')}</select>`;
  const ta = (id, value = '', placeholder = '', height = 136, cls = '') => `<textarea class="textarea ${cls}" style="min-height:${height}px;resize:vertical" data-fd-id="settings-field-${id}" data-fd-editable="value" aria-label="${esc(id)}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`;
  const f = (id, title, desc, control) => `<label class="field" data-fd-id="settings-field-group-${id}">${text(`settings-label-${id}`, title, 'span', 'subheading')}${control}${desc ? text(`settings-help-${id}`, desc, 'span', 'muted small') : ''}</label>`;
  const r = (id, title, desc, control) => `<div class="row" data-fd-id="settings-row-${id}"><div style="min-width:0">${text(`settings-row-title-${id}`, title, 'div', 'subheading')}${desc ? text(`settings-row-description-${id}`, desc, 'div', 'muted small') : ''}</div><div style="flex-shrink:0">${control}</div></div>`;
  const pill = (label, tone = '') => `<span class="tag ${tone}">${esc(label)}</span>`;
  const effect = (id, message, note = '') => `<div class="notice" data-fd-id="settings-notice-${id}" style="display:flex;align-items:flex-start;gap:10px">${icon('check', 17)}<div>${text(`settings-effect-${id}`, message, 'div')}${note ? text(`settings-effect-help-${id}`, note, 'div', 'muted small') : ''}</div></div>`;
  const block = (id, title, body, desc = '') => `<section class="settings-section" data-fd-id="settings-section-${id}"><div style="margin-bottom:14px">${text(`settings-section-title-${id}`, title, 'h3', 'subheading')}${desc ? text(`settings-section-description-${id}`, desc, 'p', 'muted small') : ''}</div>${body}</section>`;
  const footer = () => '';
  const sourceHint = () => '';
  const authPrompt = (type = 'text') => {
    const prompts = {
      text: ['企业域名', '填写企业登录使用的域名。', i('auth-answer-text', '', '例如 github.example.invalid')],
      secret: ['补充授权密钥', '填写登录流程请求的密钥。', i('auth-answer-secret', '', '输入授权密钥', 'password')],
      manual_code: ['手动授权码', '将浏览器提供的授权码粘贴到这里。', i('auth-answer-manual-code', '', '输入浏览器提供的授权码')],
      select: ['选择登录方式', '选择当前账号使用的登录方式。', s('auth-answer-select', [['personal', '个人账号'], ['enterprise', '企业账号']], 'personal')]
    };
    const prompt = prompts[type] || prompts.text;
    return `<div class="notice warning" data-fd-id="settings-auth-prompt-${type}"><div class="subheading">${prompt[0]}</div><p class="muted small" style="margin:5px 0 10px">${prompt[1]}</p><div style="display:flex;gap:8px;align-items:center">${prompt[2]}${b('提交', 'auth-answer', 'primary', `auth-answer-${type}`)}</div><div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center"><span class="small muted">${type === 'manual_code' ? '设备码：OWL-DEMO' : '等待补充授权信息'}</span>${b('取消登录', 'auth-cancel', 'ghost', `auth-cancel-${type}`)}</div></div>`;
  };
  const oauthHtml = (promptType = 'text') => `<div class="form-stack">${f('quick-provider','选择服务','选择已有账号的模型服务。',s('quick-provider',[['demo-browser','浏览器授权服务'],['demo-api','API Key 服务']],'demo-browser'))}<div class="card" style="padding:18px"><div style="display:flex;align-items:center;gap:10px">${icon('browser',20)}<span class="subheading">浏览器授权</span></div><p class="muted small" style="margin:8px 0 14px">授权完成后，回到 Owl 继续。</p>${b('打开浏览器继续','oauth-start','primary')}<label style="display:flex;align-items:center;gap:9px;margin-top:14px" data-fd-id="settings-enterprise-login"><input type="checkbox" data-fd-id="settings-field-enterprise" data-fd-editable="value"><span class="small">使用 GitHub 企业版</span></label></div><div class="card" style="padding:18px">${f('quick-api-key','API Key','粘贴服务提供的密钥。',i('quick-api-key','','输入 API Key','password'))}<div style="display:flex;justify-content:flex-end;margin-top:12px">${b('保存 API Key','api-key-save','primary')}</div></div>${authPrompt(promptType)}</div>`;

  const providers = [
    {id:'team-gateway', name:'团队网关', letter:'T', protocol:'OpenAI 兼容', count:3, models:[['owl-code-pro','Owl Code Pro','128k','8k','推理'],['owl-chat','Owl Chat','64k','8k','通用'],['owl-vision','Owl Vision','128k','16k','视觉']]},
    {id:'personal', name:'个人连接', letter:'P', protocol:'Anthropic 兼容', count:2, models:[['owl-reason','Owl Reason','200k','16k','推理'],['owl-fast','Owl Fast','64k','8k','快速']]},
    {id:'development', name:'开发环境', letter:'D', protocol:'OpenAI Responses', count:0, models:[]}
  ];

  const providerCard = (provider, expanded = false) => `<section class="provider-card" data-fd-id="settings-provider-${provider.id}">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px"><div style="display:flex;align-items:center;gap:12px"><div style="width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--color-owl-hover);font-weight:600">${provider.letter}</div><div>${text(`settings-provider-name-${provider.id}`, provider.name, 'div', 'subheading')}<div class="muted small" style="margin-top:3px">${provider.protocol} <span style="padding:0 6px">·</span> ${provider.count} 个模型</div></div></div><div style="display:flex;gap:8px">${b('添加模型', 'model-add', 'ghost', `model-add-${provider.id}`)}${b(icon('more',18),'provider-menu','ghost',`provider-menu-${provider.id}`)}</div></div>
    ${expanded ? `<div class="divider" style="margin:18px 0"></div><div class="table"><div class="table-row muted small" style="display:grid;grid-template-columns:minmax(0,1fr) 80px 70px 52px;gap:12px;padding:0 0 10px"><span>模型</span><span>上下文</span><span>最大输出</span><span></span></div>${provider.models.map(model => `<div class="table-row" data-fd-id="settings-model-${model[0]}" style="display:grid;grid-template-columns:minmax(0,1fr) 80px 70px 52px;gap:12px;align-items:center"><div>${text(`settings-model-name-${model[0]}`,model[1],'div')}<div class="muted small" style="margin-top:3px;font-family:monospace">${model[0]} ${pill(model[4])}</div></div><span class="small">${model[2]}</span><span class="small">${model[3]}</span>${b('删除','model-delete','ghost',`delete-${model[0]}`)}</div>`).join('')}</div>` : ''}
    ${provider.count === 0 ? `<div class="notice" style="margin-top:16px"><span class="muted small">还没有模型。添加模型后可在新会话中选择。</span></div>` : ''}
  </section>`;

  const builtinNames = [
    ['preamble','人设与沟通规则','用清晰、直接的语言沟通，根据任务复杂度调整回复。'],
    ['tools','工具清单','描述当前会话可使用的工具及其职责。'],
    ['rules','行为规则','工作流程、执行边界与验证要求。'],
    ['docs','文档指引','帮助 Owl 查找项目与产品文档。'],
    ['addendum','附加指令','当前环境提供的补充要求。'],
    ['project_context','项目指令','项目目录中的团队开发约定。'],
    ['skills','可用技能','当前环境中可使用的技能说明。'],
    ['cwd','工作目录','当前会话使用的工作目录。']
  ];

  window.OWL_SETTINGS = {
    general: {
      title:'常规', description:'设置默认工作环境，开始下一次工作时更顺手。',
      html: () => `<div class="form-stack">${block('workspace','工作环境',`<div class="form-stack">${f('workspace','默认工作目录','新建会话会从这个目录开始。',i('workspace','D:\\owl\\owl-re-v1\\owl-mono','输入项目目录'))}${f('shell','命令行程序','执行命令使用的程序路径；保存后用于新会话。',i('shell','C:\\Program Files\\Git\\bin\\bash.exe','输入 Shell 可执行文件路径'))}</div>`)}${block('data-location','数据存放位置',`<div class="card" style="padding:18px">${r('agent-directory','Owl 数据目录','模型配置、设置与会话历史保存在这里。',pill('只读'))}<div class="code" style="margin-top:12px;padding:12px;overflow-wrap:anywhere" data-fd-id="settings-data-path">D:\\owl\\demo-data</div></div>`)}${effect('general','工作环境设置用于新会话','当前会话继续使用创建时的工作目录与命令行程序。')}${footer('general')}${sourceHint()}</div>`
    },
    providers: {
      title:'模型与供应商', description:'连接你的模型服务，并管理可用于会话的模型。',
      html: () => `<div class="form-stack"><div style="display:flex;align-items:center;justify-content:space-between;gap:16px" data-fd-id="settings-provider-toolbar"><div>${text('settings-provider-count','3 个供应商 · 5 个模型','div','subheading')}${text('settings-provider-toolbar-help','支持浏览器授权、API Key 与自定义地址。','div','muted small')}</div>${b(`${icon('plus',16)} 添加供应商`,'provider-add','primary')}</div><div class="notice" style="display:flex;gap:10px;align-items:center" data-fd-id="settings-connect-shortcut">${icon('shield',18)}<div style="flex:1">${text('settings-connect-title','使用账号快速连接','div')}${text('settings-connect-help','选择服务后，在浏览器完成授权。','div','muted small')}</div>${b('浏览器登录','oauth','ghost')}</div>${providers.map((provider,index)=>providerCard(provider,index===0)).join('')}${effect('providers','连接完成后，新会话即可选择模型')}${sourceHint()}</div>`
    },
    plugins: {
      title:'插件', description:'为 Owl 添加工具与技能，按需启用你的工作能力。',
      html: () => `<div class="form-stack">${block('plugin-add','添加插件',`<div style="display:flex;gap:10px;align-items:center">${i('plugin-source','','npm:包名、Git 地址或本地路径')}${b('添加','add-plugin','primary')}</div><p class="muted small" style="margin-top:9px">支持 npm 包、Git 仓库、本地目录以及 .ts / .js 文件。</p>`)}${block('plugin-list','已添加的插件',`<div class="card" style="padding:0 18px">${[
        ['project-tools','项目工具','npm:owl-demo-project-tools','npm',true,'工具入口：project.ts'],
        ['review-assistant','代码检查','https://example.invalid/owl/review.git','Git',true,''],
        ['local-note','本地笔记','D:\\owl\\owl-re-v1\\owl-mono\\plugins\\notes.ts','本地文件',false,'']
      ].map(plugin=>`<div class="row" data-fd-id="settings-plugin-${plugin[0]}"><div style="min-width:0;flex:1"><div style="display:flex;gap:9px;align-items:center">${text(`settings-plugin-name-${plugin[0]}`,plugin[1],'span','subheading')}${pill(plugin[3])}</div><div class="muted small" style="margin-top:5px;font-family:monospace;overflow-wrap:anywhere">${plugin[2]}</div>${plugin[5]?`<div class="muted small" style="margin-top:3px">${plugin[5]}</div>`:''}</div><div style="display:flex;align-items:center;gap:12px">${b(plugin[4]?'已启用':'已停用','toggle-plugin','ghost',`toggle-${plugin[0]}`)}${b('删除','delete-plugin','ghost',`delete-${plugin[0]}`)}</div></div>`).join('')}</div>`)}<div class="notice warning" data-fd-id="settings-plugin-migration" style="display:flex;gap:14px;align-items:center"><div style="flex:1">${text('settings-migration-title','发现 2 项旧版扩展配置','div')}${text('settings-migration-help','迁移后可在这里统一管理。已有配置仍会正常加载。','div','small muted')}</div>${b('迁移到插件','migrate-plugins','ghost')}</div>${effect('plugins','插件更改会在新会话中生效')}${sourceHint()}</div>`
    },
    appearance: {
      title:'外观', description:'选择适合工作环境的主题，让界面保持舒适。',
      html: () => `<div class="form-stack">${block('theme','界面主题',`<div class="swatches" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px">${[
        ['light','浅色','#faf9f5','#f1efe8','#ffffff','#d9d5c7'],
        ['dark','深色','#262624','#1f1e1d','#2f2e2b','#45443e'],
        ['system','跟随系统','#faf9f5','#f1efe8','#2f2e2b','#d9d5c7']
      ].map(theme=>`<button class="card" type="button" data-action="theme-${theme[0]}" data-fd-id="settings-theme-${theme[0]}" style="text-align:left;padding:12px;${theme[0]==='dark'?'outline:2px solid #2f9e5a;outline-offset:2px;':''}"><div style="height:118px;display:flex;overflow:hidden;border-radius:8px;border:1px solid ${theme[5]};background:${theme[2]}"><div style="width:29%;background:${theme[3]};padding:14px 7px"><div style="height:5px;border-radius:2px;background:${theme[5]};margin-bottom:12px"></div><div style="height:4px;width:75%;background:${theme[5]};margin-bottom:7px"></div><div style="height:4px;width:75%;background:${theme[5]}"></div></div><div style="flex:1;background:${theme[0]==='system'?'linear-gradient(125deg,#faf9f5 50%,#262624 50%)':theme[2]};padding:22px 9px 12px"><div style="height:4px;width:62%;margin:0 auto 11px;background:${theme[5]}"></div><div style="height:4px;width:85%;margin:0 auto 24px;background:${theme[5]}"></div><div style="height:20px;border:1px solid ${theme[5]};border-radius:5px;background:${theme[4]}"></div></div></div><div style="display:flex;align-items:center;justify-content:space-between;padding-top:14px">${text(`settings-theme-label-${theme[0]}`,theme[1])}${theme[0]==='dark'?icon('check',16):''}</div></button>`).join('')}</div>`)}${effect('appearance','主题更改立即生效','跟随系统会随操作系统的深浅色设置自动切换。')}<div class="card" style="padding:18px" data-fd-id="settings-appearance-preview"><div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">${icon('leaf',20)}${text('settings-theme-preview-title','熟悉的 Owl，清晰的工作界面','div','subheading')}</div>${text('settings-theme-preview-body','内容、工具与操作在不同主题下保持一致。正文易读，次要信息安静，绿色留给主要行动。','p','muted')}</div></div>`
    },
    prompts: {
      title:'提示词', description:'告诉 Owl 怎样与你协作，也可以查看和编辑它对你的了解。',
      html: () => `<div class="form-stack">${effect('prompts','保存后用于新会话','长期指令和用户印象追加在内置规则之后。')}${block('custom-instructions','长期指令',`${ta('custom-instructions','回复使用中文，先说明结论。\n解释代码时给出具体示例。\n完成改动后简要说明验证结果。','写下你的沟通偏好与工作约定。',145)}<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:10px"><span class="muted small">留空时使用 Owl 默认规则。</span>${b('保存长期指令','save','primary','save-custom-instructions')}</div>`)}${block('user-impression','我的档案',`${ta('user-impression','偏好：使用中文交流，关注修改原因与验证结果。','Owl 会在聊天中记录值得记住的偏好，你也可以直接编辑。',110)}<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:10px"><span class="muted small">Owl 在聊天中也会更新这份档案。</span>${b('保存档案','save','primary','save-user-impression')}</div>`)}${block('builtin-prompts','内置规则',`<div class="card" style="padding:0 16px">${builtinNames.map(item=>`<details data-fd-id="settings-builtin-${item[0]}" style="border-bottom:1px solid var(--color-owl-border);padding:12px 0"><summary style="cursor:pointer;font-size:13px">${text(`settings-builtin-title-${item[0]}`,item[1])} <span class="muted small" style="float:right">只读</span></summary><p class="muted small" style="padding:10px 0 0;line-height:1.7">${item[2]}</p></details>`).join('')}</div>`,'查看构成当前系统提示词的规则分区。')}</div>`
    },
    archive: {
      title:'归档', description:'管理暂时收起的会话，并设置自动清理时间。',
      html: () => `<div class="form-stack">${block('retention','自动清理',`<div class="card" style="padding:18px">${r('retention','归档保留时间','超过保留时间的会话会被永久删除。',`<div style="display:flex;align-items:center;gap:8px"><div style="width:70px">${i('retention-days','15','','number')}</div><span class="small muted">天</span>${b('保存','save','primary','save-retention')}</div>`)}<div class="notice warning" style="margin-top:14px;display:flex;align-items:flex-start;gap:10px">${icon('clock',16)}<span class="small">每小时以及应用启动时自动清理。删除后的会话无法恢复。</span></div></div>`)}${block('archive-list','已归档会话',`<div class="card" style="padding:0 18px"><div class="row muted small"><span>会话与来源</span><span>保留状态</span></div>${[
        ['layout','整理页面布局','owl-demo','10 月 1 日 14:20','13 天后删除',false],
        ['api','梳理接口字段','sample-project','9 月 25 日 10:35','7 天后删除',false],
        ['old','早期探索记录','owl-demo','9 月 19 日 09:10','1 天后删除',true]
      ].map(entry=>`<div class="row" data-fd-id="settings-archive-${entry[0]}" style="gap:16px"><div style="flex:1;min-width:0">${text(`settings-archive-name-${entry[0]}`,entry[1],'div','subheading')}<div class="muted small" style="margin-top:5px">${entry[2]} <span style="padding:0 4px">·</span> 归档于 ${entry[3]}</div></div><div style="text-align:right"><span class="tag ${entry[5]?'warning':''}">${entry[4]}</span><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">${b('恢复','restore','ghost',`restore-${entry[0]}`)}${b('删除','delete-archive','ghost',`delete-archive-${entry[0]}`)}</div></div></div>`).join('')}</div>`,'恢复的会话会回到原项目。')}${sourceHint()}</div>`
    },
    json: {
      title:'高级配置', description:'直接编辑 settings.json，适合需要精细配置的用户。',
      html: () => `<div class="form-stack"><div class="notice" style="display:flex;gap:10px;align-items:flex-start" data-fd-id="settings-json-notice">${icon('code',18)}<div>${text('settings-json-description','其他设置页面的保存结果会同步到这里。','div')}${text('settings-json-help','确认格式正确后保存；配置按字段合并。','div','muted small')}</div></div><div class="card" style="padding:0;overflow:hidden" data-fd-id="settings-json-editor"><div style="display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid var(--color-owl-border)"><span class="code small">settings.json</span>${pill('JSON')}</div>${ta('raw-json',JSON.stringify({theme:'dark',shellPath:'C:\\Program Files\\Git\\bin\\bash.exe',plugins:['npm:owl-demo-project-tools'],owlCustomPrompt:'回复使用中文，先说明结论。',owlUserImpression:'示例档案'},null,2),'',330,'code')}<div class="muted small" style="padding:9px 16px;border-top:1px solid var(--color-owl-border)">UTF-8 <span style="padding:0 8px">·</span> 2 空格缩进</div></div>${footer('json','保存前会检查 JSON 格式。')}${sourceHint()}</div>`
    },
    about: {
      title:'关于 Owl', description:'你的桌面 AI 工作伙伴。',
      html: () => `<div class="form-stack"><div style="padding:20px 0 28px;border-bottom:1px solid var(--color-owl-border);display:flex;gap:18px;align-items:center" data-fd-id="settings-product"><div style="width:64px;height:64px;border-radius:18px;display:grid;place-items:center;background:rgba(47,158,90,.1);color:#2f9e5a">${icon('leaf',36)}</div><div>${text('settings-product-name','Owl','h2')}<div class="muted" style="margin-top:6px">桌面版 <span style="padding:0 6px">·</span> v0.1.0</div></div></div>${block('about-product','产品信息',`<div class="card" style="padding:0 18px">${r('product-foundation','运行基础','基于 pi coding agent 的桌面应用。',pill('桌面版'))}${r('model-total','已配置模型','来自你的供应商配置。','<span class="small">3 个供应商 · 5 个模型</span>')}</div>`)}${block('about-environment','本机数据',`<div class="card" style="padding:18px">${text('settings-about-path-title','Owl 数据目录','div','subheading')}<div class="code muted small" style="margin-top:10px;overflow-wrap:anywhere" data-fd-id="settings-about-data-path">D:\\owl\\demo-data</div><p class="muted small" style="margin-top:8px">保存设置、模型声明与会话历史。</p></div>`)}${sourceHint()}</div>`
    }
  };

  window.OWL_SETTINGS_DIALOGS = {
    providerAdd: {
      title:'添加供应商', description:'选择接入方式，连接你的模型服务。',
      html: () => `<div class="form-stack"><div class="settings-grid"><button class="card" type="button" data-action="oauth" data-fd-id="settings-connect-oauth" style="padding:16px;text-align:left">${icon('browser',22)}<div class="subheading" style="margin-top:10px">浏览器授权</div><p class="muted small" style="margin-top:5px">使用服务账号登录</p></button><div class="card" data-fd-id="settings-connect-custom" style="padding:16px;outline:1px solid #2f9e5a">${icon('code',22)}<div class="subheading" style="margin-top:10px">自定义连接</div><p class="muted small" style="margin-top:5px">配置地址、协议与 API Key</p></div></div><div class="settings-grid">${f('provider-id','供应商 ID *','字母或数字开头，可含 . _ -。',i('provider-id','','例如 team-gateway'))}${f('provider-name','显示名称','便于在列表中识别。',i('provider-name','','例如 团队网关'))}</div>${f('provider-url','服务地址 *','填写供应商的 Base URL。',i('provider-url','','https://api.example.invalid/v1'))}${f('provider-protocol','API 协议 *','选择服务提供的接口协议。',s('provider-protocol',[['openai-completions','OpenAI 兼容'],['anthropic-messages','Anthropic 兼容'],['openai-responses','OpenAI Responses']],'openai-completions'))}${f('provider-key','API Key','也可以填写 $环境变量名。',i('provider-key','','粘贴 API Key 或环境变量引用','password'))}<div style="display:flex;justify-content:space-between;gap:10px"><div>${b('清空','clear-provider','ghost')}</div><div style="display:flex;gap:8px">${b('取消','close-modal','ghost')}${b('保存供应商','provider-save','primary')}</div></div></div>`
    },
    modelAdd: {
      title:'添加模型', description:'将服务支持的模型加入会话选择列表。',
      html: () => `<div class="form-stack"><div class="notice">供应商：团队网关 <span class="muted small">team-gateway</span></div><div class="settings-grid">${f('model-id','模型 ID *','与供应商提供的模型标识一致。',i('model-id','','例如 owl-code-pro'))}${f('model-name','显示名称','留空时使用模型 ID。',i('model-name','','例如 Owl Code Pro'))}${f('model-context','上下文窗口','单位为 tokens，可留空。',i('model-context','','128000','number'))}${f('model-output','最大输出','单位为 tokens，可留空。',i('model-output','','8192','number'))}</div><label class="row" data-fd-id="settings-model-reasoning"><div><span class="subheading">推理模型</span><p class="muted small">启用该模型的推理能力标记。</p></div><input type="checkbox" data-fd-id="settings-field-model-reasoning" data-fd-editable="value" aria-label="推理模型"></label><div style="display:flex;justify-content:flex-end;gap:8px">${b('取消','close-modal','ghost')}${b('保存模型','model-save','primary')}</div></div>`
    },
    oauth: {
      title:'连接模型服务', description:'通过账号授权或 API Key 接入。',
      html: () => oauthHtml()
    },
    oauthText: {
      title:'连接模型服务', description:'授权流程 · 企业域名',
      html: () => oauthHtml('text')
    },
    oauthSecret: {
      title:'连接模型服务', description:'授权流程 · 密钥输入',
      html: () => oauthHtml('secret')
    },
    oauthManualCode: {
      title:'连接模型服务', description:'授权流程 · 手动授权码',
      html: () => oauthHtml('manual_code')
    },
    oauthSelect: {
      title:'连接模型服务', description:'授权流程 · 选项回答',
      html: () => oauthHtml('select')
    },
    authSuccess: {
      title:'连接完成', description:'你的模型服务已准备好。',
      html: () => `<div style="text-align:center;padding:18px 6px" data-fd-id="settings-auth-success"><div style="margin:0 auto 18px;width:52px;height:52px;display:grid;place-items:center;border-radius:50%;background:rgba(47,158,90,.12);color:#2f9e5a">${icon('check',26)}</div>${text('settings-auth-success-title','模型服务已连接','h3','subheading')}${text('settings-auth-success-body','新建会话后，即可在模型列表中选择使用。','p','muted')}<div style="margin-top:22px">${b('完成','close-modal','primary')}</div></div>`
    },
    providerDelete: {
      title:'删除供应商', description:'请确认要移除的配置。',
      html: () => `<div class="form-stack"><div class="notice warning" data-fd-id="settings-provider-delete-confirm">删除“团队网关”也会移除该供应商下的 3 个模型声明。</div><p class="muted small">你可以之后重新添加供应商和模型。</p><div style="display:flex;justify-content:flex-end;gap:8px">${b('取消','close-modal','ghost')}${b('删除供应商','provider-delete-confirm','danger')}</div></div>`
    },
    archiveDelete: {
      title:'永久删除会话', description:'此操作会删除会话文件。',
      html: () => `<div class="form-stack"><div class="card" style="padding:18px" data-fd-id="settings-archive-delete-target"><div class="subheading">整理页面布局</div><p class="muted small" style="margin-top:6px">来自 owl-demo · 归档于 10 月 1 日</p></div><div class="notice warning">会话内容将永久删除，无法恢复。</div><div style="display:flex;justify-content:flex-end;gap:8px">${b('取消','close-modal','ghost')}${b('永久删除','archive-delete-confirm','danger')}</div></div>`
    }
  };
})();
