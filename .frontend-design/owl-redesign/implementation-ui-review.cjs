const fs=require('fs');const path=require('path');const {chromium}=require('C:/Users/李现/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const dir=__dirname;const shots=path.join(dir,'implementation-ui');fs.mkdirSync(shots,{recursive:true});
const cwd='D:/owl/owl-re-v1/owl-mono';const models=[{id:'demo',name:'界面验收服务',models:[{id:'demo-code',name:'示例代码模型',contextWindow:128000,reasoning:true}]}];
const sample={theme:'dark',lastChangelogVersion:'0.0.3',shellPath:'C:\\Program Files\\PowerShell\\7\\pwsh.exe',plugins:[{source:'npm:sample-tools',enabled:true}],owlCustomPrompt:'使用中文，先说明结论。',owlUserImpression:'开发者，关注界面层级与工作效率。',owlMemory:{enabled:true},owlSidebar:{},owlChatAppearance:{fontSize:16,codeFontSize:13,lineHeight:1.7,width:768,toolRecords:'compact',motion:true}};
const now=new Date().toISOString();
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'C:/Users/李现/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'});const errors=[],requests=[],report=[];let scenario='home';let settings={...sample};
const context=await browser.newContext({viewport:{width:1280,height:800},permissions:['notifications']});await context.addInitScript(()=>{localStorage.setItem('owl.workspaceDir','D:/owl/owl-re-v1/owl-mono');localStorage.removeItem('owl.workbench.open');localStorage.removeItem('owl.sidebar.minimized');});
await context.routeWebSocket('**/ws',ws=>{ws.onMessage(raw=>{const msg=JSON.parse(String(raw));requests.push(msg.type);let result={};switch(msg.type){
case 'models.list':result=models;break;
case 'settings.get':result={agentDir:'D:/owl/ui-review-fixture',settings};break;
case 'settings.set':settings={...settings,...msg.values};result=settings;break;
case 'auth.providers':result=[{id:'demo',name:'界面验收服务',oauth:false,apiKey:true}];break;
case 'session.running':result={running:[]};break;
case 'project.create':result={path:msg.path};break;
case 'commands.list':result={commands:[{name:'new',description:'新建会话',kind:'builtin'},{name:'settings',description:'打开设置页',kind:'builtin'}]};break;
case 'session.list':result=scenario==='chat'?[{id:'ui-review-session',name:'保留现有聊天实现',cwd,modified:now,created:now,firstMessage:'保留现有聊天实现',messageCount:2}]:[];break;
case 'session.resume':result={sessionId:'ui-review-session',cwd,messages:[{role:'user',content:'保留现有聊天实现，只调整外围界面。',timestamp:Date.now()},{role:'assistant',content:[{type:'text',text:'模型回答与工具过程沿用现有实现。\n\n窗口框架、导航、工作台和设置使用新版布局。'}],api:'openai-completions',provider:'demo',model:'demo-code',stopReason:'stop',timestamp:Date.now(),usage:{input:100,output:80,cacheRead:0,cacheWrite:0,totalTokens:180,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}]};break;
case 'session.create':result={sessionId:'ui-review-new'};break;
case 'session.stats':result={thinkingLevel:'medium',availableThinkingLevels:['off','low','medium','high'],supportsThinking:true,contextUsage:{tokens:2000,contextWindow:128000,percent:2}};break;
case 'systemPrompt.preview':result={sections:{preamble:'示例基础规则',tools:'示例工具说明',rules:'现有项目约定',docs:'项目文档',addendum:'补充信息',project_context:'项目上下文',skills:'可用技能',cwd}};break;
case 'memory.list':result={enabled:true,entries:[]};break;
case 'session.archiveConfig':result={retentionDays:15,sessions:[]};break;
case 'fs.tree':result={path:msg.path||'.',truncated:false,entries:[{name:'src',path:'src',isDir:true},{name:'App.tsx',path:'App.tsx',isDir:false},{name:'README.md',path:'README.md',isDir:false}]};break;
case 'fs.read':result={kind:'text',content:'export const ui = "OWL";\n',size:24,truncated:false};break;
case 'fs.search':result=[];break;
case 'git.status':result={repo:true,branch:'main',upstream:'origin/main',entries:[{path:'App.tsx',x:' ',y:'M'}]};break;
case 'git.diff':result={diff:'diff --git a/App.tsx b/App.tsx\n--- a/App.tsx\n+++ b/App.tsx\n@@ -1 +1 @@\n-old\n+new\n'};break;
case 'git.log':result=[];break;
case 'term.create':result={termId:'ui-review-term',shell:'PowerShell'};break;
case 'iab.list':result={pages:[]};break;
case 'iab.open':result={page:{pageId:'ui-review-page',url:msg.url||'about:blank',title:'界面验收',active:true,viewport:{width:900,height:600}}};break;
}
ws.send(JSON.stringify({type:'response',id:msg.id,ok:true,result}));if(msg.type==='term.create')setTimeout(()=>{try{ws.send(JSON.stringify({type:'term.data',termId:'ui-review-term',data:'PS D:\\owl> UI review fixture\r\n'}));}catch{}},50);
});});
const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error: '+e.message);});
for(const theme of ['dark','light']){settings={...settings,theme};scenario='home';await page.goto('http://127.0.0.1:18970');await page.locator('.owl-start-page').waitFor();await page.waitForTimeout(150);await page.screenshot({path:path.join(shots,theme+'-home.png')});report.push({theme,view:'home',outer:await page.locator('.owl-desktop-shell').evaluate(el=>({w:el.scrollWidth,cw:el.clientWidth,h:el.scrollHeight,ch:el.clientHeight}))});
await page.getByRole('button',{name:'文件',exact:true}).click();await page.getByRole('menuitem',{name:'打开项目…',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();
await page.getByRole('button',{name:'视图',exact:true}).click();await page.getByRole('menuitem',{name:'隐藏会话列表',exact:true}).click();if(await page.locator('.owl-sidebar:visible').count())throw new Error('Sidebar did not collapse');await page.getByRole('button',{name:'显示会话列表',exact:true}).click();
await page.locator('.owl-activity-rail').getByRole('button',{name:'设置',exact:true}).click();await page.locator('.owl-settings-page').waitFor();const nav=page.locator('nav[aria-label="设置分类"]');const labels=await nav.getByRole('button').allTextContents();for(let i=0;i<labels.length;i++){await nav.getByRole('button',{name:labels[i].trim(),exact:true}).click();await page.waitForTimeout(35);await page.screenshot({path:path.join(shots,theme+'-settings-'+i+'.png')});report.push({theme,view:labels[i].trim(),titlebarVisible:await page.locator('.owl-desktop-titlebar').isVisible(),outer:await page.locator('.owl-desktop-shell').evaluate(el=>({w:el.scrollWidth,cw:el.clientWidth,h:el.scrollHeight,ch:el.clientHeight}))});}
await page.getByRole('button',{name:'帮助',exact:true}).click();await page.getByRole('menuitem',{name:'关于 OWL',exact:true}).click();await page.getByRole('button',{name:'返回工作区',exact:true}).click();
await page.getByRole('button',{name:'浏览项目文件',exact:false}).click();await page.locator('.owl-workbench-shell:visible').waitFor();await page.waitForTimeout(100);await page.screenshot({path:path.join(shots,theme+'-files.png')});
const quicks=await page.locator('.owl-workbench-shortcuts button').evaluateAll(bs=>bs.map(b=>b.getAttribute('title')));for(let i=0;i<quicks.length;i++){if(!quicks[i])continue;await page.locator('.owl-workbench-shortcuts').getByRole('button',{name:quicks[i],exact:true}).click();await page.waitForTimeout(80);await page.screenshot({path:path.join(shots,theme+'-workbench-'+i+'.png')});}
}
scenario='chat';await page.goto('http://127.0.0.1:18970');await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'protected-chat.png')});
await page.setViewportSize({width:936,height:672});scenario='home';await page.goto('http://127.0.0.1:18970');await page.locator('.owl-start-page').waitFor();await page.screenshot({path:path.join(shots,'light-home-small.png')});report.push({theme:'light',view:'home-small',outer:await page.locator('.owl-desktop-shell').evaluate(el=>({w:el.scrollWidth,cw:el.clientWidth,h:el.scrollHeight,ch:el.clientHeight}))});
const result={errors,report,requestTypes:Array.from(new Set(requests)),realBackendAccess:false,protectedComponentsNotReplaced:true};fs.writeFileSync(path.join(dir,'implementation-ui-review.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({errors,views:report.length,screenshots:fs.readdirSync(shots).length,requestTypes:result.requestTypes}));await browser.close();if(errors.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1)});
