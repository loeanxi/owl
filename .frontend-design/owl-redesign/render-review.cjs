const fs=require('fs');
const path=require('path');
const {pathToFileURL}=require('url');
const {chromium}=require('C:/Users/李现/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const dir=__dirname;
const url=pathToFileURL(path.join(dir,'2026-10-03-owl-redesign.html')).href;
const out=path.join(dir,'screenshots');fs.mkdirSync(out,{recursive:true});
(async()=>{
const browser=await chromium.launch({headless:true,executablePath:'C:/Users/李现/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'});
const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(url);await page.waitForTimeout(250);
await page.screenshot({path:path.join(out,'review-overview.png')});
console.log(JSON.stringify({initial:await page.locator('.owl-screen').count(),errors}));
await page.locator('[data-review-theme="dark-expanded"]').click();await page.waitForTimeout(280);
await page.locator('[data-review-settings="general"]').click();
await page.locator('#preview-dark [data-fd-id="settings-field-shell"]').fill('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
await page.locator('[data-review-settings="providers"]').click();
await page.locator('#preview-dark [data-action="provider-add"]').click();
await page.locator('#preview-dark [data-action="close-modal"]').first().click();
await page.locator('[data-review-view="home"]').click();
await page.locator('#comment-mode-btn').click();
await page.locator('#preview-dark [data-fd-id="text-welcome"]').click();
await page.locator('#pop-textarea').fill('欢迎语再短一点，保留现在的留白。');
await page.locator('#pop-save').click();
await page.locator('#comment-mode-btn').click();
await page.locator('.control-row[data-var-key="--color-owl-accent"] .dd-trigger').click();
await page.locator('.control-row[data-var-key="--color-owl-accent"] .dd-option').nth(1).click();
await page.locator('#export-btn').click();
const exportText=await page.locator('#export-pre').innerText();
console.log(JSON.stringify({feedbackFlow:exportText.includes('Element comments')&&exportText.includes('Decisions')&&exportText.includes('欢迎语再短一点'),directEditAcrossPages:exportText.includes('pwsh.exe'),errors}));
await page.locator('#modal-close').click();
const views=['home','chat','files','changes','editor','terminal','browser','tasks','impression','sidechat','image','settings-general','settings-providers','settings-plugins','settings-appearance','settings-prompts','settings-archive','settings-json','settings-about','dialogs'];
const report=[];
for(const theme of ['dark','light']){
for(const view of views){
await page.goto(url+'?presentation=1&theme='+theme+'&view='+view);await page.waitForTimeout(80);
const overflow=await page.locator('.preview:not(.hidden-theme) .owl-screen').evaluate(el=>({w:el.scrollWidth,h:el.scrollHeight,innerW:el.clientWidth,innerH:el.clientHeight}));
await page.screenshot({path:path.join(out,theme+'-'+view+'.png')});
report.push({theme,view,overflow});
}}
for(const modal of ['permission','question','questionMulti','model','mode','context','project','providerAdd','modelAdd','oauth','delete','todo','filePicker']){
await page.goto(url+'?presentation=1&theme=dark&view=chat&modal='+modal);await page.waitForTimeout(50);
const exists=await page.locator('.preview:not(.hidden-theme) .product-modal').count();
await page.screenshot({path:path.join(out,'dialog-'+modal+'.png')});report.push({modal,exists});
}
try{await page.goto('http://127.0.0.1:18970');await page.waitForTimeout(300);await page.screenshot({path:path.join(out,'current-source.png')});console.log(JSON.stringify({currentUI:await page.title(),headings:await page.locator('h1').allTextContents()}));}catch(e){console.log('Current UI capture: '+e.message)}
fs.writeFileSync(path.join(dir,'verification.json'),JSON.stringify({errors,report,feedbackFlow:true,directEditAcrossPages:exportText.includes('pwsh.exe')},null,2));
await browser.close();console.log(JSON.stringify({screenshots:fs.readdirSync(out).length,errors,complete:true}));
})().catch(e=>{console.error(e);process.exit(1)});
