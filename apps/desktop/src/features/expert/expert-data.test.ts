import assert from "node:assert/strict";
import test from "node:test";
import {
	appendMemoryEntries,
	expertGroupPrimer,
	expertPrimer,
	memoryContext,
	parseMemoryEntries,
	stripMemoryLines,
	type ExpertGroup,
	type ExpertPersona,
} from "./expert-data.ts";

const TEMPLATED = `# 长期记忆（与用户合作累积）

> 每条一行，格式 \`- [MM-DD] 内容\`，写在对应分区末尾；会话开场把本文件尾部带进上下文。

## 偏好

## 进行中

## 已定结论

## 纠偏记录
`;

test("parseMemoryEntries 识别「记忆+ 分类｜内容」，省略分类按结论收", () => {
	const text = [
		"先把方案定下来。",
		"记忆+ 偏好｜用户偏好无边框窗口模式",
		"记忆+ 进行中｜Tauri 白屏排查，卡在 WebView2 版本",
		"记忆+ 纠偏｜回答先给结论再展开",
		"记忆+ 结论｜发布走灰度 5% 起步",
		"记忆+ 默认分类这条也收",
		"普通正文里出现记忆+ 不该被收走",
		"- 记忆+ 偏好｜列表形式也收",
	].join("\n");
	const entries = parseMemoryEntries(text);
	assert.deepEqual(entries.map((entry) => entry.category), ["偏好", "进行中", "纠偏", "结论", "结论", "偏好"]);
	assert.equal(entries[0]!.text, "用户偏好无边框窗口模式");
	assert.equal(entries[4]!.text, "默认分类这条也收");
	assert.equal(entries[5]!.text, "列表形式也收");
});

test("parseMemoryEntries 对空内容与无记忆返回空", () => {
	assert.deepEqual(parseMemoryEntries("记忆+ 偏好｜"), []);
	assert.deepEqual(parseMemoryEntries("今天没有可记的"), []);
});

test("stripMemoryLines 剔除记忆行并压掉多余空行", () => {
	const text = "第一段。\n记忆+ 偏好｜不用边框\n\n\n第二段。\n- 记忆+ 结论｜收尾\n";
	assert.equal(stripMemoryLines(text), "第一段。\n\n第二段。");
	assert.equal(stripMemoryLines("记忆+ 偏好｜只有记忆"), "");
});

test("appendMemoryEntries 按分类写进对应分区，多条一次写入", () => {
	const out = appendMemoryEntries(
		TEMPLATED,
		[
			{ category: "偏好", text: "默认无边框窗口" },
			{ category: "结论", text: "雷达量程 300 米起步" },
		],
		"10-22",
	);
	assert.ok(out.includes("## 偏好\n\n- [10-22] 默认无边框窗口\n"));
	assert.ok(out.includes("## 已定结论\n\n- [10-22] 雷达量程 300 米起步\n"));
	assert.ok(!out.includes("进行中\n\n- ["));
});

test("appendMemoryEntries 追加到既有条目之后，不打散分区", () => {
	const seeded = appendMemoryEntries(TEMPLATED, [{ category: "偏好", text: "第一条" }], "10-21");
	const out = appendMemoryEntries(seeded, [{ category: "偏好", text: "第二条" }], "10-22");
	const pref = out.slice(out.indexOf("## 偏好"), out.indexOf("## 进行中"));
	assert.ok(pref.indexOf("10-21") < pref.indexOf("10-22"));
	assert.ok(pref.includes("- [10-21] 第一条") && pref.includes("- [10-22] 第二条"));
});

test("appendMemoryEntries 对旧版无分区文件补建分区", () => {
	const legacy = "# 长期记忆（与用户合作累积）\n\n> 旧说明。\n";
	const out = appendMemoryEntries(legacy, [{ category: "纠偏", text: "先看指标再开方" }], "10-22");
	assert.ok(out.includes("## 纠偏记录\n\n- [10-22] 先看指标再开方"));
});

test("memoryContext 短文件全带，长文件带尾部并标注省略", () => {
	assert.equal(memoryContext("  "), "");
	const short = "# 记忆\n\n## 偏好\n\n- [10-22] x\n";
	assert.equal(memoryContext(short), short.trim());
	const long = Array.from({ length: 60 }, (_, i) => `- 条目${i}`).join("\n");
	const ctx = memoryContext(long, 40);
	assert.ok(ctx.startsWith("（更早的条目略）"));
	assert.ok(ctx.includes("条目59"));
	assert.ok(!ctx.includes("条目0\n"));
});

const PERSONA: ExpertPersona = {
	slug: "laok", name: "老K", title: "DevOps 稳定性顾问", division: "eng", color: ["#000", "#111"],
	desc: "d", tags: [], mission: "m", rules: ["r"], deliv: ["dv"], flow: [["f", "fd"]], metrics: ["mt"],
};

test("expertPrimer 携带记忆协议与既有记忆", async () => {
	const client = {
		async request() {
			return { ok: true, result: { kind: "text", content: "## 偏好\n\n- [10-21] 用户在深夜工作" } };
		},
	} as unknown as Parameters<typeof expertPrimer>[0];
	const primer = await expertPrimer(client, PERSONA);
	assert.ok(primer.includes("记忆+ 分类｜一句话"));
	assert.ok(primer.includes("偏好（用户的习惯与喜好）"));
	assert.ok(primer.includes("不要为了记而记"));
	assert.ok(primer.includes("用户在深夜工作"));
});

test("expertGroupPrimer 仅共享记忆模式带记忆协议", () => {
	const group: ExpertGroup = { id: "g1", name: "增长会诊", memberSlugs: ["hexiao"], memory: "shared" };
	assert.ok(expertGroupPrimer(group, [PERSONA]).includes("记忆+ 结论｜"));
	const own: ExpertGroup = { ...group, memory: "own" };
	assert.ok(!expertGroupPrimer(own, [PERSONA]).includes("记忆+ 结论｜"));
});
