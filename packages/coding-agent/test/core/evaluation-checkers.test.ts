import { describe, expect, it } from "vitest";
import { checkEvaluationCode } from "../../src/core/evaluation/check-code.ts";
import {
	checkEvaluationSvgRequirement,
	evaluationPreviewPolicy,
	isEvaluationSvgWellFormed,
} from "../../src/core/evaluation/check-svg.ts";
import { checkEvaluationArtifact, extractEvaluationArtifact } from "../../src/core/evaluation/checkers.ts";
import { BUILTIN_EVALUATION_TASKS, EVALUATION_BICYCLE_SVG } from "../../src/core/evaluation/tasks.ts";
import type { EvaluationArtifact, EvaluationTask } from "../../src/core/evaluation/types.ts";

function task(id: string): EvaluationTask {
	const result = BUILTIN_EVALUATION_TASKS.find((entry) => entry.id === id);
	if (!result) throw new Error(id);
	return result;
}
const artifact = (content: string, type: EvaluationArtifact["type"] = "svg"): EvaluationArtifact => ({
	type,
	content,
	previewAllowed: false,
});

const correctCode: Record<string, string> = {
	C01: "function paginate(items,page,size){if(!Number.isInteger(page)||page<1||!Number.isInteger(size)||size<1)throw new RangeError();return items.slice((page-1)*size,page*size);}",
	C02: `function totalMoney(items){let units=0n;for(const {price,quantity} of items){if(typeof price!=='string'||!/^\\d+(?:\\.\\d{1,6})?$/.test(price)||!Number.isInteger(quantity)||quantity<0)throw new RangeError();const [whole,frac='']=price.split('.');units+=(BigInt(whole)*1000000n+BigInt(frac.padEnd(6,'0')))*BigInt(quantity);}const cents=(units+5000n)/10000n;return (cents/100n).toString()+'.'+(cents%100n).toString().padStart(2,'0');}`,
	C03: "function uniqueLatest(items){const byId=new Map();for(const item of items)byId.set(item.id,item);return [...byId.values()];}",
	C04: "function sortedCopy(items){if(typeof process!=='undefined'||typeof require!=='undefined'||typeof fetch!=='undefined')throw new Error('Host capability leaked');return [...items].sort((a,b)=>a-b);}",
	C05: "function applyPatch(original,patch){const next={...original};for(const key of Object.keys(patch))if(patch[key]!==undefined)next[key]=patch[key];return next;}",
	C06: "function mergeIntervals(items){const out=[];for(const interval of items.map(x=>[...x]).sort((a,b)=>a[0]-b[0])){const last=out.at(-1);if(last&&interval[0]<=last[1])last[1]=Math.max(last[1],interval[1]);else out.push(interval);}return out;}",
	C07: "function createSearchController(fetchResults,setResults){let latest=0;return async function search(query){const id=++latest;const result=await fetchResults(query);if(id===latest)setResults(result);};}",
	C08: "async function mapLimit(items,limit,mapper){if(!Number.isInteger(limit)||limit<1)throw new RangeError();let next=0;const out=new Array(items.length);await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;out[i]=await mapper(items[i],i);}}));return out;}",
};

describe("fixed evaluation tasks and real code probes", () => {
	it("provides 24 complete/versioned questions with fixed inputs and three rubrics", () => {
		expect(BUILTIN_EVALUATION_TASKS).toHaveLength(24);
		expect(new Set(BUILTIN_EVALUATION_TASKS.map((entry) => entry.id)).size).toBe(24);
		for (const entry of BUILTIN_EVALUATION_TASKS) {
			expect(entry.version).toBe(1);
			expect(entry.prompt.length).toBeGreaterThan(20);
			expect(entry.rubric).toHaveLength(3);
			expect(entry.checks.some((check) => check.kind === "format")).toBe(true);
		}
	});
	for (const [id, source] of Object.entries(correctCode)) {
		it(`${id}: accepts an implementation that satisfies the independent boundary probes`, async () => {
			const checks = await checkEvaluationCode(task(id), source);
			expect(checks).toHaveLength(1);
			expect(checks[0].status, checks[0].detail).toBe("passed");
		});
		it(`${id}: rejects the supplied defective baseline`, async () => {
			const checks = await checkEvaluationCode(task(id), task(id).input ?? "");
			expect(checks[0].status, checks[0].detail).toBe("failed");
		});
	}
	it("stops infinite candidate execution within the sandbox budget", async () => {
		const before = Date.now();
		const checks = await checkEvaluationCode(task("C01"), "function paginate(){while(true){}}");
		expect(checks[0].status).toBe("failed");
		expect(Date.now() - before).toBeLessThan(7000);
	}, 10_000);
	it("does not mark unconfigured custom Java code as passing behavior tests", async () => {
		const custom = {
			...task("C01"),
			id: "custom-java",
			builtin: false,
			checks: [{ id: "format", label: "格式", kind: "format" }],
		};
		const checks = await checkEvaluationCode(custom, "public class Example {}");
		expect(checks[0].status).toBe("unchecked");
	});
	it("honors cancellation before candidate execution", async () => {
		await expect(checkEvaluationCode(task("C01"), correctCode.C01, AbortSignal.abort())).rejects.toThrow();
	});
});

describe("SVG syntax, source policy and fixed semantics", () => {
	it("preserves complete nested SVG and HTML with closing-tag literals in script", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><svg><circle r="2"/></svg></svg>';
		expect(extractEvaluationArtifact(task("G01"), svg)?.content).toBe(svg);
		expect(isEvaluationSvgWellFormed(svg)).toBe(true);
		const html = '<html><body><script>const text="</html>";</script><p>ok</p></body></html>';
		expect(extractEvaluationArtifact(task("W01"), `HTML:\n\`\`\`html\n${html}\n\`\`\``)?.content).toBe(html);
	});
	it("detects missing/mismatched XML tags that a forgiving parser can repair", async () => {
		expect(isEvaluationSvgWellFormed(task("G05").input ?? "")).toBe(false);
		const result = await checkEvaluationArtifact(task("G01"), '<svg><g><circle r="2"/></svg>');
		expect(result.checks.find((check) => check.id === "format")?.status).toBe("failed");
	});
	it("allows local gradient references but rejects relative links, unquoted external attributes, scripts and bitmap shortcuts", () => {
		expect(
			evaluationPreviewPolicy(
				'<svg><defs><linearGradient id="g"/></defs><rect style="fill:url(\'#g\')"/></svg>',
				"svg",
			),
		).toBe(true);
		for (const source of [
			'<svg><image href="a.png"/></svg>',
			'<svg onload="alert(1)"></svg>',
			"<svg><script>alert(1)</script></svg>",
			"<svg><foreignObject/></svg>",
			'<svg><image href="data:image/png;base64,AAAA"/></svg>',
		])
			expect(evaluationPreviewPolicy(source, "svg")).toBe(false);
		expect(evaluationPreviewPolicy("<html><body><img src=https://example.org/a.png></body></html>", "html")).toBe(
			false,
		);
	});
	it("validates exact geometry and rejects a moved/incorrect-colored circle", () => {
		const source =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><circle id="red-circle" cx="120" cy="130" r="40" fill="red"/><circle id="blue-circle" cx="300" cy="130" r="40" fill="blue"/><circle id="green-circle" cx="480" cy="130" r="40" fill="green"/><text id="title" x="300" y="300" text-anchor="middle">几何之美</text></svg>';
		expect(checkEvaluationSvgRequirement(task("G03"), artifact(source))?.status).toBe("passed");
		expect(checkEvaluationSvgRequirement(task("G03"), artifact(source.replace('cx="120"', 'cx="125"')))?.status).toBe(
			"failed",
		);
	});
	it("validates the fixed repair and checks parent-child relationships", () => {
		expect(checkEvaluationSvgRequirement(task("G05"), artifact(EVALUATION_BICYCLE_SVG))?.status).toBe("passed");
		const nested = EVALUATION_BICYCLE_SVG.replace(
			'stroke-width="3"/><path id="seat"',
			'stroke-width="3"><path id="seat"',
		).replace("</svg>", "</circle></svg>");
		expect(isEvaluationSvgWellFormed(nested)).toBe(true);
		expect(checkEvaluationSvgRequirement(task("G05"), artifact(nested))?.status).toBe("failed");
	});
	it("requires only the declared local edit while retaining other attributes", () => {
		const edited = EVALUATION_BICYCLE_SVG.replace('id="front-wheel" cx="190"', 'id="front-wheel" cx="202"').replace(
			'id="front-wheel" cx="202" cy="110" r="30" fill="none" stroke="#394c40"',
			'id="front-wheel" cx="202" cy="110" r="30" fill="none" stroke="red"',
		);
		expect(checkEvaluationSvgRequirement(task("G06"), artifact(edited))?.status).toBe("passed");
		expect(
			checkEvaluationSvgRequirement(
				task("G06"),
				artifact(edited.replace('id="rear-wheel" cx="50"', 'id="rear-wheel" cx="51"')),
			)?.status,
		).toBe("failed");
	});
	it("checks actual fixed JSON answers and invalid JSON independently", async () => {
		const good = await checkEvaluationArtifact(
			task("G07"),
			'{"visible_count":3,"top_color":"green","leftmost_id":"left"}',
		);
		expect(good.checks.every((check) => check.status === "passed")).toBe(true);
		const wrong = await checkEvaluationArtifact(
			task("G07"),
			'{"visible_count":4,"top_color":"blue","leftmost_id":"template"}',
		);
		expect(wrong.checks.find((check) => check.id === "requirements")?.status).toBe("failed");
		const invalid = await checkEvaluationArtifact(task("G07"), "not json");
		expect(invalid.checks.find((check) => check.id === "format")?.status).toBe("failed");
	});
	it("requires 4-second indefinite animation declarations without claiming kinematic quality", () => {
		const source =
			'<svg><circle r="10"><animate attributeName="cx" values="0;10;0" dur="4s" repeatCount="indefinite"/></circle></svg>';
		expect(checkEvaluationSvgRequirement(task("G08"), artifact(source))?.status).toBe("passed");
		expect(checkEvaluationSvgRequirement(task("G08"), artifact(source.replace('dur="4s"', 'dur="8s"')))?.status).toBe(
			"failed",
		);
	});
});
