import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkEvaluationBrowser, findEvaluationBrowserPath } from "../../src/core/evaluation/check-browser.ts";
import {
	BUILTIN_EVALUATION_TASKS,
	EVALUATION_BOARD,
	EVALUATION_ORDERS,
	EVALUATION_PRODUCTS,
	EVALUATION_RECORDS,
} from "../../src/core/evaluation/tasks.ts";
import type { EvaluationTask } from "../../src/core/evaluation/types.ts";

function builtin(id: string): EvaluationTask {
	const task = BUILTIN_EVALUATION_TASKS.find((entry) => entry.id === id);
	if (!task) throw new Error(`Missing fixture task ${id}`);
	return structuredClone(task);
}

const QUOTATION = `<!doctype html><html><body>
<label>设备<input id="qty-device" type="number" value="2"></label><label>耗材<input id="qty-consumable" type="number" value="3"></label><label>折扣<input id="discount" type="number" value="0"></label>
<div id="total"></div><div id="error" hidden></div><script>
const inputs=['qty-device','qty-consumable','discount'].map(id=>document.getElementById(id));
function update(){const [device,consumable,discount]=inputs.map(el=>Number(el.value));const invalid=!Number.isInteger(device)||device<0||!Number.isInteger(consumable)||consumable<0||discount<0||discount>100;
document.getElementById('error').hidden=!invalid;document.getElementById('error').textContent=invalid?'输入必须为有效的非负整数数量与0到100折扣':'';
if(!invalid)document.getElementById('total').textContent=((device*150+consumable*20)*(1-discount/100)).toFixed(2);}
inputs.forEach(input=>input.addEventListener('input',update));update();
</script></body></html>`;

function repair(clearSelection: boolean): string {
	return `<!doctype html><html><body><form id="repair-form" novalidate>
<select id="workshop"><option value="A">A</option><option value="B">B</option></select><select id="device"></select><textarea id="fault"></textarea><button id="submit" type="submit">提交</button></form><div id="form-error" hidden></div><div id="submitted-data"></div>
<script>const workshop=document.getElementById('workshop'), device=document.getElementById('device'), fault=document.getElementById('fault');
function update(){const prior=device.value;device.innerHTML='<option value="">请选择</option>'+({A:['E01','E02'],B:['E03']}[workshop.value]).map(id=>'<option value="'+id+'">'+id+'</option>').join('');${clearSelection ? "device.value='';" : "if(prior){const old=document.createElement('option');old.value=prior;old.textContent=prior;device.append(old);device.value=prior;}"}}
workshop.addEventListener('change',update);update();document.getElementById('repair-form').addEventListener('submit',event=>{event.preventDefault();const invalid=!device.value||!fault.value.trim();document.getElementById('form-error').hidden=!invalid;document.getElementById('form-error').textContent=invalid?'设备和故障描述为必填':'';if(!invalid)document.getElementById('submitted-data').textContent=device.value+' '+fault.value;});</script></body></html>`;
}

const OTHER_WEB_FIXTURES: [string, string][] = [
	[
		"W01",
		`<html><body><select id="status-filter"><option value="all">全部</option><option value="pending">待办</option><option value="completed">完成</option><option value="cancelled">取消</option></select><select id="amount-sort"><option value="asc">升序</option><option value="desc">降序</option></select><input id="order-search"><table><tbody id="orders-body"></tbody></table><button id="previous-page">上页</button><span id="page-info"></span><button id="next-page">下页</button><button id="reset-filters">重置</button><div id="empty-state" hidden>无结果</div><script>
const data=${JSON.stringify(EVALUATION_ORDERS)},status=document.getElementById('status-filter'),sort=document.getElementById('amount-sort'),search=document.getElementById('order-search');let page=1;
function render(){const rows=data.filter(row=>(status.value==='all'||row.status===status.value)&&row.id.includes(search.value)).sort((a,b)=>sort.value==='asc'?a.amount-b.amount:b.amount-a.amount);document.getElementById('orders-body').innerHTML=rows.slice((page-1)*5,page*5).map(row=>'<tr data-order-id="'+row.id+'"><td>'+row.id+'</td><td>'+row.amount+'</td></tr>').join('');document.getElementById('page-info').textContent=page;document.getElementById('empty-state').hidden=rows.length>0;document.getElementById('next-page').disabled=page*5>=rows.length;document.getElementById('previous-page').disabled=page===1;}
for(const input of [status,sort,search])input.addEventListener('input',()=>{page=1;render()});document.getElementById('next-page').onclick=()=>{page++;render()};document.getElementById('previous-page').onclick=()=>{page--;render()};document.getElementById('reset-filters').onclick=()=>{status.value='all';sort.value='asc';search.value='';page=1;render()};render();</script></body></html>`,
	],
	[
		"W04",
		`<html><body><button id="add-A">A</button><button id="add-B">B</button><button id="add-C" disabled>C</button><div id="cart-rows"></div><div id="cart-total">0</div><div id="cart-empty">空购物车</div><script>
const products=${JSON.stringify(EVALUATION_PRODUCTS)},cart={};function render(){document.getElementById('cart-rows').innerHTML=Object.keys(cart).filter(id=>cart[id]>0).map(id=>'<div id="cart-'+id+'">'+id+' <span id="qty-'+id+'">'+cart[id]+'</span><button id="remove-'+id+'">删除</button></div>').join('');for(const id of Object.keys(cart)){const remove=document.getElementById('remove-'+id);if(remove)remove.onclick=()=>{delete cart[id];render()}}document.getElementById('cart-total').textContent=products.reduce((sum,p)=>sum+(cart[p.id]||0)*p.price,0).toFixed(2);document.getElementById('cart-empty').hidden=Object.keys(cart).length>0;}for(const product of products)document.getElementById('add-'+product.id).onclick=()=>{cart[product.id]=Math.min(product.stock,(cart[product.id]||0)+1);render()};render();</script></body></html>`,
	],
	[
		"W05",
		`<html><body><div id="todo-count"></div><div id="todo-list"></div><div id="doing-count"></div><div id="doing-list"></div><div id="done-count"></div><div id="done-list"></div><input id="task-title"><select id="new-task-status"><option value="todo">待办</option><option value="doing">进行</option><option value="done">完成</option></select><button id="add-task">新增</button><div id="task-error" hidden></div><script>
const tasks=${JSON.stringify(EVALUATION_BOARD)};function render(){for(const status of ['todo','doing','done']){const rows=tasks.filter(task=>task.status===status);document.getElementById(status+'-count').textContent=rows.length;document.getElementById(status+'-list').innerHTML=rows.map(task=>'<div data-task-id="'+task.id+'">'+task.title+'<select id="status-'+task.id+'">'+['todo','doing','done'].map(s=>'<option value="'+s+'" '+(s===task.status?'selected':'')+'>'+s+'</option>').join('')+'</select></div>').join('');}for(const task of tasks)document.getElementById('status-'+task.id).onchange=event=>{task.status=event.target.value;render()}}document.getElementById('add-task').onclick=()=>{const title=document.getElementById('task-title').value.trim();document.getElementById('task-error').hidden=!!title;document.getElementById('task-error').textContent=title?'':'标题不能为空';if(title){tasks.push({id:'T'+(tasks.length+1),title,status:document.getElementById('new-task-status').value});render()}};render();</script></body></html>`,
	],
	[
		"W06",
		`<html><body><select id="category-filter"><option value="all">全部</option><option>A</option><option>B</option><option>C</option></select><input id="sales-search"><div id="total-sale"></div><table><tbody id="sales-body"></tbody></table><div id="chart"></div><div id="no-data" hidden>无数据</div><script>
const data={A:100,B:200,C:300},filter=document.getElementById('category-filter'),search=document.getElementById('sales-search');function render(){const keys=Object.keys(data).filter(key=>(filter.value==='all'||filter.value===key)&&key.includes(search.value));document.getElementById('total-sale').textContent=keys.reduce((sum,key)=>sum+data[key],0);document.getElementById('sales-body').innerHTML=keys.map(key=>'<tr data-category="'+key+'"><td>'+key+'</td><td>'+data[key]+'</td></tr>').join('');document.getElementById('chart').innerHTML=keys.map(key=>'<div data-category="'+key+'" data-value="'+data[key]+'">'+key+' '+data[key]+'</div>').join('');document.getElementById('no-data').hidden=keys.length>0;}filter.onchange=render;search.oninput=render;render();</script></body></html>`,
	],
	[
		"W07",
		`<html><body><input id="record-search"><div id="record-list"></div><div id="empty-records" hidden>无结果</div><div id="detail-dialog" role="dialog" aria-modal="true" style="display:none"><div id="detail-content"></div><button id="first-control">查看</button><button id="close-detail">关闭</button></div><script>
const records=${JSON.stringify(EVALUATION_RECORDS)},dialog=document.getElementById('detail-dialog');let opener=null;function close(){dialog.style.display='none';opener.focus()}function render(){const rows=records.filter(record=>record.title.includes(document.getElementById('record-search').value));document.getElementById('record-list').innerHTML=rows.map(record=>'<button data-record-id="'+record.id+'">'+record.title+'</button>').join('');document.getElementById('empty-records').hidden=rows.length>0;for(const button of document.querySelectorAll('[data-record-id]'))button.onclick=()=>{opener=button;document.getElementById('detail-content').textContent=records.find(record=>record.id===button.dataset.recordId).detail;dialog.style.display='block';document.getElementById('first-control').focus()}}document.getElementById('record-search').oninput=render;document.getElementById('close-detail').onclick=close;document.addEventListener('keydown',event=>{if(dialog.style.display==='none')return;const first=document.getElementById('first-control'),last=document.getElementById('close-detail');if(event.key==='Escape'){event.preventDefault();close()}if(event.key==='Tab'&&event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(event.key==='Tab'&&!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}});render();</script></body></html>`,
	],
	[
		"W08",
		`<html><head><style>*{box-sizing:border-box}body{margin:0;padding:10px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.knowledge-card{padding:12px;border:1px solid #ddd;overflow-wrap:anywhere}h3{margin:0 0 15px}#mobile-nav{display:none}#nav-toggle{display:none}@media(max-width:500px){.cards{grid-template-columns:minmax(0,1fr)}#nav-toggle{display:block}}</style></head><body><button id="nav-toggle">导航</button><nav id="mobile-nav">所有知识</nav><div class="cards">${Array.from({ length: 9 }, (_, index) => `<article class="knowledge-card"><h3>知识卡片 ${index + 1}${index === 8 ? "：这里是一段很长的中文描述，用于检查手机尺寸下的文字与按钮是否正确排版" : ""}</h3><button>查看</button></article>`).join("")}</div><script>document.getElementById('nav-toggle').onclick=()=>{const nav=document.getElementById('mobile-nav');nav.style.display=nav.style.display==='block'?'none':'block'};</script></body></html>`,
	],
];

afterEach(() => vi.unstubAllEnvs());

describe("browser availability is reported honestly", () => {
	it("returns unchecked render and behavior when the explicit browser path is absent", async () => {
		vi.stubEnv("OWL_EVALUATION_BROWSER_PATH", "Z:/owl-fixtures/browser-does-not-exist.exe");
		const checks = await checkEvaluationBrowser(builtin("W02"), {
			type: "html",
			content: QUOTATION,
			previewAllowed: true,
		});
		expect(checks.map((check) => check.id)).toEqual(["render", "requirements"]);
		expect(checks.every((check) => check.status === "unchecked")).toBe(true);
	});
});

describe.skipIf(!findEvaluationBrowserPath())("installed Chrome: offline artifact behavior", () => {
	it.each(OTHER_WEB_FIXTURES)("checks fixed controls and browser behavior for %s", async (id, content) => {
		const checks = await checkEvaluationBrowser(builtin(id), { type: "html", content, previewAllowed: true });
		expect(checks.find((check) => check.id === "requirements")?.status, JSON.stringify(checks)).toBe("passed");
	});
	it("checks W02 initial amount, discount, quantities and invalid values in a real browser", async () => {
		const checks = await checkEvaluationBrowser(builtin("W02"), {
			type: "html",
			content: QUOTATION,
			previewAllowed: true,
		});
		expect(checks).toEqual([
			expect.objectContaining({ id: "render", status: "passed" }),
			expect.objectContaining({ id: "requirements", status: "passed" }),
		]);
	});

	it("does not pass a static W02 page that displays 360 but ignores quantity and discount changes", async () => {
		const broken =
			'<!doctype html><html><body><input id="qty-device" value="2"><input id="qty-consumable" value="3"><input id="discount" value="0"><div id="total">360.00</div><div id="error" hidden></div></body></html>';
		const checks = await checkEvaluationBrowser(builtin("W02"), {
			type: "html",
			content: broken,
			previewAllowed: true,
		});
		expect(checks.find((check) => check.id === "render")?.status).toBe("passed");
		expect(checks.find((check) => check.id === "requirements")?.status).toBe("failed");
	});

	it("checks W03 clearing dependent devices, validation and submitted content", async () => {
		const checks = await checkEvaluationBrowser(builtin("W03"), {
			type: "html",
			content: repair(true),
			previewAllowed: true,
		});
		expect(checks.find((check) => check.id === "requirements")?.status, JSON.stringify(checks)).toBe("passed");
	});

	it("rejects W03 retaining an invalid device after the workshop changes", async () => {
		const checks = await checkEvaluationBrowser(builtin("W03"), {
			type: "html",
			content: repair(false),
			previewAllowed: true,
		});
		expect(checks.find((check) => check.id === "requirements")).toEqual(
			expect.objectContaining({ status: "failed", detail: expect.stringContaining("没有清除E01") }),
		);
	});

	it("blocks external fetch and navigation attempts while allowing inline calculator interaction", async () => {
		let hits = 0;
		const server = createServer((_request, response) => {
			hits++;
			response.writeHead(200);
			response.end("outside");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("No fixture port");
			const target = `http://127.0.0.1:${address.port}/forbidden`;
			const content = QUOTATION.replace(
				"</body>",
				`<script>fetch(${JSON.stringify(target)}).catch(()=>{});const image=new Image();image.src=${JSON.stringify(target)};document.body.append(image);window.open(${JSON.stringify(target)});setTimeout(()=>{const iframe=document.createElement('iframe');iframe.src=${JSON.stringify(target)};document.body.append(iframe)},0);</script></body>`,
			);
			const checks = await checkEvaluationBrowser(builtin("W02"), { type: "html", content, previewAllowed: true });
			expect(checks.find((check) => check.id === "requirements")?.status).toBe("passed");
			expect(hits).toBe(0);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("uses the browser native SVG parser and rejects a blank or malformed drawing", async () => {
		for (const content of [
			'<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>',
		]) {
			const checks = await checkEvaluationBrowser(builtin("G01"), { type: "svg", content, previewAllowed: true });
			expect(checks.find((check) => check.id === "render")?.status).toBe("failed");
		}
		const checks = await checkEvaluationBrowser(builtin("G01"), {
			type: "svg",
			content:
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red" /></svg>',
			previewAllowed: true,
		});
		expect(checks.find((check) => check.id === "render")?.status, JSON.stringify(checks)).toBe("passed");
	});

	it("cancellation closes the isolated browser rather than leaving a checker running", async () => {
		const controller = new AbortController();
		controller.abort(new Error("fixture cancelled"));
		await expect(
			checkEvaluationBrowser(
				builtin("W02"),
				{ type: "html", content: QUOTATION, previewAllowed: true },
				controller.signal,
			),
		).rejects.toThrow("fixture cancelled");
	});

	it("cancels a running renderer with an infinite generated script and closes its isolated context", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const timer = setTimeout(() => controller.abort(new Error("running fixture cancelled")), 1000);
		try {
			await expect(
				checkEvaluationBrowser(
					builtin("W02"),
					{
						type: "html",
						content: "<html><body><p>Running</p><script>while(true){}</script></body></html>",
						previewAllowed: true,
					},
					controller.signal,
				),
			).rejects.toThrow("running fixture cancelled");
			expect(Date.now() - started).toBeLessThan(6000);
		} finally {
			clearTimeout(timer);
		}
	});
});
