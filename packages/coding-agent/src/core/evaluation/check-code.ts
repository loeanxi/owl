import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { stripTypeScriptTypes } from "node:module";
import { JSException, QuickJS, type QuickJSOptions } from "quickjs-wasi";
import type { EvaluationCheck, EvaluationTask } from "./types.ts";

/** All probes execute inside QuickJS/WASM, without host functions, filesystem or network access. */
const probes: Record<string, string> = {
	C01: `
await test('正常、末页、超出末页',()=>{equal(paginate([1,2,3,4,5],1,2),[1,2]);equal(paginate([1,2,3,4,5],3,2),[5]);equal(paginate([1,2,3],4,2),[]);});
await test('正整数参数校验',()=>{for(const [p,s] of [[0,2],[-1,2],[1,0],[1,1.5]]){throwsRange(()=>paginate([],p,s));}});
await test('不修改输入',()=>{const a=[3,1,2];paginate(a,1,2);equal(a,[3,1,2]);equal(paginate([],1,2),[]);});`,
	C02: `
await test('十进制与最终舍入',()=>{equal(totalMoney([{price:'0.10',quantity:3},{price:'0.20',quantity:1}]),'0.50');equal(totalMoney([{price:'0.105',quantity:3}]),'0.32');equal(totalMoney([{price:'0.004',quantity:1},{price:'0.004',quantity:1}]),'0.01');});
await test('零、空输入和大整数',()=>{equal(totalMoney([]),'0.00');equal(totalMoney([{price:'5.000001',quantity:0}]),'0.00');equal(totalMoney([{price:'9007199254740993.01',quantity:1}]),'9007199254740993.01');});
await test('非法价格与数量',()=>{for(const item of [{price:'-1',quantity:1},{price:'1',quantity:-1},{price:'1',quantity:1.2},{price:'x',quantity:1},{price:'0.0000001',quantity:1}])throwsRange(()=>totalMoney([item]));});`,
	C03: `
await test('最后内容与首次顺序',()=>{equal(uniqueLatest([{id:'A',value:'old'},{id:'B',value:'b'},{id:'A',value:'new'}]),[{id:'A',value:'new'},{id:'B',value:'b'}]);});
await test('特殊ID与空数组',()=>{equal(uniqueLatest([]),[]);equal(uniqueLatest([{id:'__proto__',value:'x'},{id:'constructor',value:'y'}]),[{id:'__proto__',value:'x'},{id:'constructor',value:'y'}]);});
await test('不修改输入',()=>{const a=[{id:'A',value:'old'},{id:'A',value:'new'}];const before=json(a);uniqueLatest(a);equal(json(a),before);});`,
	C04: `
await test('数值而非字符串排序',()=>{equal(sortedCopy([10,2,1]),[1,2,10]);equal(sortedCopy([-1,4,-3,4]),[-3,-1,4,4]);});
await test('空输入与单元素',()=>{equal(sortedCopy([]),[]);equal(sortedCopy([1]),[1]);});
await test('输入与输出不同引用',()=>{const a=[3,1,2];const b=sortedCopy(a);equal(a,[3,1,2]);equal(b,[1,2,3]);assert(a!==b,'返回了原数组');});`,
	C05: `
await test('0、false、空字符串与null',()=>{equal(applyPatch({count:8,enabled:true,note:'a'}, {count:0,enabled:false,note:null,label:''}),{count:0,enabled:false,note:null,label:''});});
await test('undefined忽略与自身属性',()=>{const patch=Object.create({inherited:3});patch.value=undefined;patch.own=2;equal(applyPatch({value:1},patch),{value:1,own:2});});
await test('返回新对象且不修改原值',()=>{const a={n:1};const b=applyPatch(a,{n:2});equal(a,{n:1});equal(b,{n:2});assert(a!==b,'返回了原对象');});`,
	C06: `
await test('相接、重叠和乱序',()=>{equal(mergeIntervals([[8,10],[3,5],[1,3]]),[[1,5],[8,10]]);equal(mergeIntervals([[1,10],[2,3],[4,5]]),[[1,10]]);});
await test('零长度与空输入',()=>{equal(mergeIntervals([]),[]);equal(mergeIntervals([[2,2],[1,2]]),[[1,2]]);});
await test('不修改数组及子数组',()=>{const a=[[3,4],[1,2],[2,6]];const before=json(a);mergeIntervals(a);equal(json(a),before);});`,
	C07: `
await test('旧请求不覆盖新请求',async()=>{const pending={};const shown=[];const search=createSearchController(q=>new Promise(r=>pending[q]=r),r=>shown.push(r));const a=search('A');const b=search('B');pending.B('B');await b;equal(shown,['B']);pending.A('A');await a;equal(shown,['B']);});
await test('最新请求正常显示',async()=>{const shown=[];const search=createSearchController(q=>Promise.resolve(q+'!'),r=>shown.push(r));await search('C');equal(shown,['C!']);});
await test('失败不更新显示且向调用者抛出',async()=>{let updated=false;const search=createSearchController(()=>Promise.reject(new Error('expected')),()=>updated=true);let caught=false;try{await search('X');}catch{caught=true;}assert(caught,'异常被吞掉');assert(!updated,'失败时仍更新了结果');});`,
	C08: `
await test('限制并发且保留输入顺序',async()=>{let active=0,peak=0;const release={};const p=mapLimit([0,1,2],2,v=>{active++;peak=Math.max(peak,active);return new Promise(r=>release[v]=()=>{active--;r(v*2);});});await Promise.resolve();assert(peak<=2,'同时启动超过2个任务');assert(typeof release[0]==='function'&&typeof release[1]==='function','未启动两个任务');release[1]();for(let i=0;i<6;i++)await Promise.resolve();assert(typeof release[2]==='function','空闲槽没有继续执行');release[2]();release[0]();equal(await p,[0,2,4]);assert(peak<=2,'执行中超过并发上限');});
await test('空输入与不同并发数',async()=>{equal(await mapLimit([],2,x=>x),[]);equal(await mapLimit([3,1,2],1,x=>x+1),[4,2,3]);});
await test('非法limit及异常拒绝',async()=>{for(const limit of [0,-1,1.5]){let bad=false;try{await mapLimit([1],limit,x=>x);}catch(e){bad=e instanceof RangeError;}assert(bad,'未拒绝非法limit');}let caught=false;try{await mapLimit([1,2],2,()=>Promise.reject(new Error('expected')));}catch{caught=true;}assert(caught,'吞掉mapper异常');});`,
};

interface ProbeOutcome { label: string; passed: boolean; detail: string }

export async function checkEvaluationCode(task: EvaluationTask, source: string, signal?: AbortSignal): Promise<EvaluationCheck[]> {
	const spec = task.checks.find((check) => check.kind.startsWith("code-"));
	const probe = task.builtin ? probes[task.id] : undefined;
	if (!probe || !spec) return [{ id: "code-tests", label: "代码行为检查", status: "unchecked", detail: "自定义代码未配置隔离测试用例；Java、Python等语言需对应检查环境，未按通过计分。" }];
	signal?.throwIfAborted();
	let wasm: QuickJSOptions["wasm"];
	try { wasm = (await loadQuickJSWasm()) as QuickJSOptions["wasm"]; }
	catch { return [{ id: spec.id, label: spec.label, status: "unchecked", detail: "JavaScript隔离检查环境不可用。" }]; }
	const start = Date.now();
	const vm = await QuickJS.create({ wasm, memoryLimit: 32 * 1024 * 1024, interruptHandler: () => Boolean(signal?.aborted) || Date.now() - start > 2000 });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		let code = source.trim();
		if (/\b(?:interface|type)\s+\w+\s*[={]|:\s*(?:number|string|boolean|unknown)(?:\[\])?\b/.test(code)) code = stripTypeScriptTypes(code, { mode: "strip" });
		code = code.replace(/^\s*export\s+(?:default\s+)?(?=(?:async\s+)?function|const |let |class )/gm, "");
		const program = `(async function(){'use strict';
const json=JSON.stringify.bind(JSON);const assert=(ok,msg)=>{if(!ok)throw new Error(msg||'与预期不符');};
const equal=(actual,expected)=>assert(json(actual)===json(expected),'实际 '+json(actual)+'，预期 '+json(expected));
const throwsRange=fn=>{let caught=false;try{fn();}catch(e){caught=e instanceof RangeError;}assert(caught,'预期抛出RangeError');};
const outcomes=[];const test=async(label,fn)=>{try{await fn();outcomes.push({label,passed:true,detail:'符合预期'});}catch(e){outcomes.push({label,passed:false,detail:String(e.message||e).slice(0,300)});}};
${code}
${probe}
return json(outcomes);})()`;
		const value = vm.evalCode(program);
		try {
			const settled = vm.resolvePromise(value);
			vm.executePendingJobs();
			const result = await Promise.race([settled, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("隔离执行超时或Promise未完成")), 2500); })]);
			if ("error" in result) {
				const detail = result.error.consume((handle) => handle.toString());
				return [{ id: spec.id, label: spec.label, status: "failed", detail: detail.slice(0,500) }];
			}
			const serialized = result.value.consume((handle) => handle.toString());
			const outcomes = JSON.parse(serialized) as ProbeOutcome[];
			const passed = outcomes.length === 3 && outcomes.every((outcome) => outcome.passed === true);
			return [{ id: spec.id, label: spec.label, status: passed ? "passed" : "failed", detail: outcomes.map((outcome) => `${outcome.passed ? "通过" : "失败"}：${outcome.label}${outcome.passed ? "" : `（${outcome.detail}）`}`).join("；") }];
		} finally { value.dispose(); }
	} catch (error) {
		signal?.throwIfAborted();
		const detail = error instanceof Error ? error.message : String(error);
		if (error instanceof JSException) error.dispose();
		return [{ id: spec.id, label: spec.label, status: "failed", detail: `隔离代码检查未完成：${detail.slice(0,500)}` }];
	} finally { if (timeout) clearTimeout(timeout); vm.dispose(); }
}
