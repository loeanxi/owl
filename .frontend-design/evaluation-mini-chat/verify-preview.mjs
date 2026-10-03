import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire('D:/owl/owl-re-v1/owl-mono/package.json');
const pw = require('playwright-core');
const server = JSON.parse(await readFile(join(root, 'preview-server.json'), 'utf8'));
const browser = await pw.chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const report = { success: false, errors: [], cases: [], screenshots: [], paidCalls: 0 };
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(8000);
page.on('pageerror', error => report.errors.push(error.stack ?? error.message));
await page.route('**/*', route => route.request().url().startsWith(server.url) || route.request().url().startsWith('file:') || route.request().url().startsWith('http://127.0.0.1:5190/') ? route.continue() : route.abort());
async function check(name, action) { await action(); report.cases.push(name); console.log(`PASS ${name}`); }
async function screenshot(name, selector='.mc-app') { await page.locator(selector).screenshot({ path: join(root, name) }); report.screenshots.push(name); }
try {
 await page.goto(server.url + 'mini-chat-surface.html');
 await check('two independent mini conversations with visible input, original question and artifacts', async()=>{
  assert.equal(await page.locator('.mc-window').count(), 2);
  assert.equal(await page.locator('.first-answer .mc-art').count(), 2);
  for(const box of await page.locator('.mc-composer').all()){const area=await box.boundingBox();assert.ok(area.y+area.height<=961);}
  await screenshot('01-mini-conversations.png');
 });
 await check('thinking expansion and per-model follow-up leave the other model untouched', async()=>{
  const a=page.locator('.mc-window[data-model="A"]'),b=page.locator('.mc-window[data-model="B"]');
  await a.locator('.mc-thinking summary').click();assert.equal(await a.locator('.mc-thinking').getAttribute('open'),'');
  await a.getByRole('textbox',{name:'追问结果 A'}).fill('请把脚和踏板的连接再画清楚一些');
  await a.getByRole('button',{name:'发送给结果 A'}).click();
  assert.equal(await a.locator('.mc-followups .mc-user').count(),1);assert.equal(await b.locator('.mc-followups .mc-user').count(),0);
  assert.match(await a.locator('.mc-followup-divider').innerText(),/不计入本轮测评/);
  await screenshot('02-independent-followup.png');
 });
 await check('artifact source and first-answer rating drawers work', async()=>{
  const a=page.locator('.mc-window[data-model="A"]');
  await a.locator('.mc-art .mc-source').click();assert.match(await page.getByRole('dialog').locator('pre').innerText(),/<svg/);await page.getByRole('button',{name:'关闭抽屉'}).click();
  await a.locator('.mc-score').click();const dialog=page.getByRole('dialog');assert.match(await dialog.innerText(),/首次测评回答/);
  for(const row of await dialog.locator('.mc-rating-values').all()) await row.getByRole('button',{name:'4',exact:true}).click();
  await dialog.getByRole('button',{name:'保存评分'}).click();assert.match(await a.locator('.mc-score').innerText(),/已评价首次回答/);
 });
 await page.locator('.mc-scenario').selectOption('running');
 await check('streaming-thinking state is visible within conversation messages',async()=>{
  await page.locator('.mc-thought-body').first().filter({hasText:'先确定'}).waitFor();
  assert.equal(await page.locator('.mc-status[data-state="running"]').count(),2);
  await screenshot('03-thinking-conversations.png');
 });
 await page.locator('.mc-scenario').selectOption('complete');await page.setViewportSize({width:1280,height:860});
 await check('1280px desktop keeps both conversations and composers on screen',async()=>{
  for(const card of await page.locator('.mc-window').all()){const area=await card.boundingBox();assert.ok(area.x>=0&&area.x+area.width<=1281);}
  for(const box of await page.locator('.mc-composer').all()){const area=await box.boundingBox();assert.ok(area.y+area.height<=861);}
  await screenshot('04-compact-desktop.png');
 });
 await page.setViewportSize({width:1600,height:1020});
 await page.goto(server.url+'2026-10-04-evaluation-mini-chat.html?pane=dark');
 await check('theme token controls, direct edits, comments and export are usable',async()=>{
  const row=page.locator('[data-var-key="--color-owl-accent"]');await row.locator('.dd-trigger').click();await row.locator('.dd-option').filter({hasText:'custom-green'}).click();
  const title=page.locator('#preview-dark [data-fd-id="evaluation-task-title"]');await title.fill('鹈鹕骑自行车 · 会话原型');
  assert.equal(await page.locator('#preview-light [data-fd-id="evaluation-task-title"]').innerText(),'鹈鹕骑自行车 · 会话原型');
  await page.locator('#comment-mode-btn').click();await page.locator('#preview-dark [data-fd-id="evaluation-composer-a"]').click();
  await page.locator('#pop-textarea').fill('输入框可以再高一点，让追问更容易填写。');await page.locator('#pop-save').click();await page.locator('#comment-mode-btn').click();
  await page.locator('#export-btn').click();const markdown=await page.locator('#export-pre').innerText();
  assert.match(markdown,/Frontend design round-trip/);assert.match(markdown,/Decisions/);assert.match(markdown,/Direct edits/);assert.match(markdown,/Element comments/);assert.match(markdown,/输入框可以再高一点/);
  await writeFile(join(root,'example-feedback.md'),markdown);
 });
 await page.goto(pathToFileURL(join(root,'mini-chat-surface.html')).href);
 await check('the prototype works directly from a local HTML file',async()=>{assert.equal(await page.locator('.mc-window').count(),2)});
 try {
  await page.goto('http://127.0.0.1:5190/?view=evaluation',{timeout:8000});
  await page.locator('.owl-desktop-titlebar').waitFor();
  report.liveRouteCompared=true;
  await page.screenshot({path:join(root,'current-app-reference.png')});
 } catch(error) { report.liveRouteNote=error.message; }
 assert.equal(report.errors.length,0,report.errors.join('\n'));report.success=true;
} catch(error){report.failure=error.stack??error.message;process.exitCode=1;await page.screenshot({path:join(root,'verification-failure.png')}).catch(()=>{});}
finally {await browser.close();await writeFile(join(root,'verification.json'),JSON.stringify(report,null,2));}
