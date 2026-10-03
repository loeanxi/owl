import { DOMParser } from "linkedom";
import { EVALUATION_BICYCLE_SVG } from "./tasks.ts";
import type { EvaluationArtifact, EvaluationCheck, EvaluationOutputType, EvaluationTask } from "./types.ts";

/** Linkedom repairs some XML errors; explicit nesting checks precede native browser parsing. */
export function isEvaluationSvgWellFormed(content: string): boolean {
	const stack: string[] = [];
	let roots = 0;
	const tokens = content.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:"[^"]*"|'[^']*'|[^'">])*>/g) ?? [];
	for (const token of tokens) {
		if (token.startsWith("<!--") || token.startsWith("<![CDATA[") || token.startsWith("<?")) continue;
		if (token.startsWith("<!")) return false;
		const name = /^<\/?([A-Za-z_][\w:.-]*)/.exec(token)?.[1];
		if (!name) return false;
		if (token.startsWith("</")) { if (stack.pop() !== name) return false; }
		else {
			if (stack.length === 0) roots++;
			if (!/\/\s*>$/.test(token)) stack.push(name);
		}
	}
	return roots === 1 && stack.length === 0;
}

export function evaluationPreviewPolicy(content: string, type: EvaluationOutputType): boolean {
	if (/<!ENTITY|<!DOCTYPE\s+(?!html\b)|@import/i.test(content)) return false;
	try {
		const document = new DOMParser().parseFromString(content, type === "svg" ? "image/svg+xml" : "text/html");
		for (const node of document.querySelectorAll("*")) {
			const tag = node.localName.toLowerCase();
			if (["iframe", "object", "embed", "base"].includes(tag)) return false;
			if (type === "svg" && ["script", "foreignobject", "image"].includes(tag)) return false;
			if (tag === "meta" && node.getAttribute("http-equiv")?.toLowerCase() === "refresh") return false;
			for (const attr of node.attributes) {
				const key = attr.name.toLowerCase();
				const value = attr.value.trim();
				if (type === "svg" && key.startsWith("on")) return false;
				if (["src", "href", "xlink:href", "action", "formaction", "poster", "srcset"].includes(key) && value && !value.startsWith("#")) {
					if (!(type === "html" && tag === "img" && key === "src" && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i.test(value))) return false;
				}
			}
		}
		for (const match of content.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) if (match[2].trim() && !match[2].trim().startsWith("#")) return false;
		return true;
	} catch { return false; }
}

function canonicalSvg(content: string): string {
	const document = new DOMParser().parseFromString(content, "image/svg+xml");
	const elements = [...document.querySelectorAll("*")];
	return JSON.stringify(elements.map((node) => ({
		name: node.localName,
		parent: elements.findIndex((candidate) => candidate === node.parentElement),
		attrs: [...node.attributes].map((attr) => [attr.name, attr.value]).sort(([a], [b]) => a.localeCompare(b)),
		text: node.children.length === 0 ? node.textContent?.trim() : "",
	})));
}

export function checkEvaluationSvgRequirement(task: EvaluationTask, artifact: EvaluationArtifact): EvaluationCheck | undefined {
	const spec = task.checks.find((check) => ["geometry", "bars", "svg-repair", "svg-edit", "relations", "animation"].includes(check.kind));
	if (!spec) return undefined;
	let passed = false;
	let detail = "固定要求不符合预期。";
	try {
		if (spec.kind === "relations") {
			const answer = JSON.parse(artifact.content) as Record<string, unknown>;
			passed = answer.visible_count === 3 && ["green", "#008000"].includes(String(answer.top_color).toLowerCase()) && answer.leftmost_id === "left";
			detail = passed ? "三个可见对象、green覆盖、left最靠左均符合固定答案。" : "预期 visible_count=3、top_color=green、leftmost_id=left。";
		} else {
			const document = new DOMParser().parseFromString(artifact.content, "image/svg+xml");
			const numeric = (id: string, name: string, expected: number): boolean => document.getElementById(id)?.hasAttribute(name) === true && Number(document.getElementById(id)?.getAttribute(name)) === expected;
			if (spec.kind === "geometry") {
				passed = document.documentElement.getAttribute("viewBox")?.trim().split(/[ ,]+/).join(" ") === "0 0 600 400" && !document.querySelector("[transform]") && ["red", "blue", "green"].every((color, index) => {
					const id = `${color}-circle`;
					return document.getElementById(id)?.localName === "circle" && numeric(id, "cx", [120,300,480][index]) && numeric(id,"cy",130) && numeric(id,"r",40) && document.getElementById(id)?.getAttribute("fill")?.toLowerCase() === color;
				}) && numeric("title","x",300) && numeric("title","y",300) && document.getElementById("title")?.getAttribute("text-anchor") === "middle" && document.getElementById("title")?.textContent === "几何之美";
				detail = "检查固定坐标、半径、颜色和居中标题；构图质量另行人工评价。";
			} else if (spec.kind === "bars") {
				passed = document.documentElement.getAttribute("viewBox")?.trim().split(/[ ,]+/).join(" ") === "0 0 600 400" && [40,80,60,100].every((value,index) => {
					const id = `bar-${"ABCD"[index]}`;
					let node = document.getElementById(id);
					while (node) { if (node.hasAttribute("transform") || /transform\s*:/i.test(node.getAttribute("style") ?? "")) return false; node = node.parentElement; }
					return document.getElementById(id)?.localName === "rect" && numeric(id,"x",100+index*100) && numeric(id,"width",50) && numeric(id,"height",value*2) && numeric(id,"y",320-value*2) && [...document.querySelectorAll("text")].some((text) => text.textContent?.trim() === String(value));
				});
				detail = "检查固定柱高、零基线和数值标签；图表可读性另行人工评价。";
			} else if (spec.kind === "svg-repair" || spec.kind === "svg-edit") {
				const expected = spec.kind === "svg-repair" ? EVALUATION_BICYCLE_SVG : EVALUATION_BICYCLE_SVG.replace('id="front-wheel" cx="190"', 'id="front-wheel" cx="202"').replace('id="front-wheel" cx="202" cy="110" r="30" fill="none" stroke="#394c40"', 'id="front-wheel" cx="202" cy="110" r="30" fill="none" stroke="red"');
				passed = canonicalSvg(artifact.content) === canonicalSvg(expected);
				detail = "比较元素、层级、属性与文字，忽略属性排列和排版空白；保留未指定部分。";
			} else if (spec.kind === "animation") {
				passed = [...document.querySelectorAll("animate, animateTransform")].some((node) => ["4s", "4000ms"].includes(node.getAttribute("dur") ?? "") && node.getAttribute("repeatCount") === "indefinite");
				detail = "仅验证4秒循环动画声明；脚、踏板与关节协调由人工评价。";
			}
		}
	} catch (error) { detail = error instanceof Error ? error.message : String(error); }
	return { id: spec.id, label: spec.label, status: passed ? "passed" : "failed", detail };
}
