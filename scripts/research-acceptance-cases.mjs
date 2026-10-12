import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const ACCEPTANCE_LIMITS = Object.freeze({ models: 2, cases: 2, rounds: 3, calls: 12, outputTokens: 1536 });

export function requestBudget(limits = ACCEPTANCE_LIMITS) {
	let attempts = 0;
	const perCase = new Map();
	return {
		get attempts() { return attempts; },
		claim(caseId) {
			const count = perCase.get(caseId) ?? 0;
			if (attempts >= limits.calls || count >= limits.rounds) throw new Error("Acceptance request budget exhausted");
			attempts += 1;
			perCase.set(caseId, count + 1);
			return { attempt: attempts, caseAttempt: count + 1 };
		},
	};
}

export function inside(root, path) {
	const local = relative(resolve(root), resolve(path));
	return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
}

export function allowedAcceptanceTool(cwd, kind, event) {
	if (["research_checkpoint"].includes(event.toolName)) return true;
	const input = event.input;
	if (!input || typeof input !== "object") return false;
	if (event.toolName === "read") return typeof input.path === "string" && inside(cwd, resolve(cwd, input.path));
	if (event.toolName === "write") return resolve(cwd, input.path ?? "") === join(cwd, "analysis.json");
	if (event.toolName !== "research_rea") return false;
	if (input.action === "inventory" || input.action === "close") return true;
	if (input.action === "view") return typeof input.evidenceId === "string";
	if (!inside(cwd, resolve(cwd, input.path ?? ""))) return false;
	return kind === "js" ? input.action === "javascript" : ["native_overview", "native_functions", "native_function", "native_references"].includes(input.action);
}

/** Source-owned x64 PE. Its entry is mov eax,42; ret. Never executed by the suite. */
export function syntheticPe() {
	const data = Buffer.alloc(1024);
	data.write("MZ");
	data.writeUInt32LE(0x80, 0x3c);
	data.write("PE\0\0", 0x80);
	data.writeUInt16LE(0x8664, 0x84);
	data.writeUInt16LE(1, 0x86);
	data.writeUInt16LE(240, 0x94);
	data.writeUInt16LE(0x22, 0x96);
	const optional = 0x98;
	data.writeUInt16LE(0x20b, optional);
	data.writeUInt32LE(0x200, optional + 4);
	data.writeUInt32LE(0x1000, optional + 16);
	data.writeUInt32LE(0x1000, optional + 20);
	data.writeBigUInt64LE(0x140000000n, optional + 24);
	data.writeUInt32LE(0x1000, optional + 32);
	data.writeUInt32LE(0x200, optional + 36);
	data.writeUInt16LE(6, optional + 40);
	data.writeUInt16LE(6, optional + 48);
	data.writeUInt32LE(0x2000, optional + 56);
	data.writeUInt32LE(0x200, optional + 60);
	data.writeUInt16LE(3, optional + 68);
	data.writeBigUInt64LE(0x100000n, optional + 72);
	data.writeBigUInt64LE(0x1000n, optional + 80);
	data.writeBigUInt64LE(0x100000n, optional + 88);
	data.writeBigUInt64LE(0x1000n, optional + 96);
	data.writeUInt32LE(16, optional + 108);
	const section = optional + 240;
	data.write(".text", section);
	data.writeUInt32LE(6, section + 8);
	data.writeUInt32LE(0x1000, section + 12);
	data.writeUInt32LE(0x200, section + 16);
	data.writeUInt32LE(0x200, section + 20);
	data.writeUInt32LE(0x60000020, section + 36);
	Buffer.from([0xb8, 42, 0, 0, 0, 0xc3]).copy(data, 0x200);
	return data;
}

export const hash = (data) => createHash("sha256").update(data).digest("hex");

export async function prepareCase(cwd, kind) {
	await mkdir(cwd, { recursive: true });
	const files = kind === "js" ? {
		"index.js": 'import { decodeBadge } from "./codec.js";\nexport function lookupBadge(hex) { return decodeBadge(hex).trim().toUpperCase(); }\n',
		"codec.js": 'export function decodeBadge(hex) { return hex.match(/../g).map(pair => String.fromCharCode(parseInt(pair, 16) ^ 43)).join(""); }\n',
	} : { "return42.exe": syntheticPe() };
	const inputs = [];
	for (const [name, data] of Object.entries(files)) {
		const path = join(cwd, name);
		await writeFile(path, data, { flag: "wx" });
		inputs.push({ path, sha256: hash(data) });
	}
	const manifest = { kind, owner: "Owl synthetic acceptance fixture", targetExecuted: false, inputs };
	await writeFile(join(cwd, "fixture.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
	return manifest;
}

export function casePrompt(kind) {
	const goal = kind === "js"
		? '静态分析自建 index.js 与 codec.js，追踪 lookupBadge 到 decodeBadge 的调用链，推导输入 "6a69" 的返回值。用 research_rea action=javascript、path="."、sourcePaths=["index.js","codec.js"] 获取真实证据，并读取两份源文件核对。'
		: '静态分析自建 return42.exe 的入口 0x140001000。这个地址来自 fixture 的生成布局。使用 research_rea action=native_function、path="return42.exe"、procedure="0x140001000" 取得实际伪代码和汇编证据，解释返回值。';
	return [goal,
		"这是本次测试生成的自有微型样本；只处理当前目录。禁止运行目标或源码、网络访问、安装软件及调用其他模型。",
		"最多3次模型请求。第一轮可批量调用必要工具，随后尽快保存结论。不要先列计划或等待用户选研究方向。",
		'使用 write 把成果保存为 analysis.json。格式：{"kind":"js或native","result":实际返回值,"callChain":[JS函数名或入口地址],"evidencePaths":[工具实际返回的绝对产物路径],"explanation":"依据与局限"}。JS 引用真实 session-evidence.json 完整证据，原生函数引用真实 analysis.json。result 的类型与真实返回值一致。工具不存在或失败时如实说明，不编造产物。',
	].join("\n");
}

/** Independent fixture/evidence checks; an assistant's final stop or success claim is insufficient. */
export async function verifyCase(cwd, manifest, messages) {
	const checks = [];
	for (const input of manifest.inputs) checks.push({ name: `unchanged:${relative(cwd, input.path)}`, passed: hash(await readFile(input.path)) === input.sha256 });
	const results = messages.filter(message => message.role === "toolResult" && message.toolName === "research_rea" && !message.isError);
	const operation = manifest.kind === "js" ? "analyze_javascript_application" : "analyze_function";
	const reports = results.map(message => message.details?.researchRea).filter(report => report?.operation === operation && report.targetExecuted === false);
	checks.push({ name: "actual_static_tool_result", passed: reports.length > 0 });
	checks.push({ name: "tool_target_identity", passed: reports.some(report => manifest.kind === "js" ? report.target?.path === cwd : report.target?.path === manifest.inputs[0].path && report.target?.sha256 === manifest.inputs[0].sha256) });
	const actualPaths = new Set(reports.flatMap(report => report.artifacts.map(artifact => artifact.path)));
	let analysis;
	try { analysis = JSON.parse(await readFile(join(cwd, "analysis.json"), "utf8")); } catch { /* Missing/malformed is a failed delivery. */ }
	checks.push({ name: "saved_analysis", passed: analysis?.kind === manifest.kind });
	checks.push({ name: "correct_result", passed: analysis?.result === (manifest.kind === "js" ? "AB" : 42) });
	checks.push({ name: "correct_chain", passed: Array.isArray(analysis?.callChain) && (manifest.kind === "js" ? ["lookupBadge", "decodeBadge"].every(name => analysis.callChain.includes(name)) : analysis.callChain.includes("0x140001000")) });
	let evidenceValid = Array.isArray(analysis?.evidencePaths) && analysis.evidencePaths.length > 0;
	let observed = "";
	for (const path of analysis?.evidencePaths ?? []) {
		if (typeof path !== "string" || !actualPaths.has(path) || !inside(cwd, path)) { evidenceValid = false; continue; }
		try {
			const stat = await lstat(path);
			const artifact = reports.flatMap(report => report.artifacts).find(item => item.path === path);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) { evidenceValid = false; continue; }
			const bytes = await readFile(path);
			if (hash(bytes) !== artifact?.sha256) evidenceValid = false;
			// Report/manifest paths alone cannot prove code semantics.
			if (["analysis.json", "response.json", "session-evidence.json"].some(name => path.endsWith(`${sep}${name}`))) observed += bytes.toString("utf8");
		} catch { evidenceValid = false; }
	}
	checks.push({ name: "existing_hashed_evidence", passed: evidenceValid });
	checks.push({ name: "evidence_contains_semantics", passed: manifest.kind === "js" ? ["lookupBadge", "decodeBadge"].every(name => observed.includes(name)) : /(?:return\s+(?:42|0x2a)|MOV[^\n]*0x2a|mov[^\n]*42)/i.test(observed) });
	return { passed: checks.every(check => check.passed), checks };
}
