import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 任务清单摘要条（TodoPin 的 summary 形态）的定位契约。
 *
 * 背景（2026-10-28）：摘要条挂在 AgentConversation 的 header 插槽里，而
 * .owl-agent-conversation 是 flex-direction: column 的容器。摘要条此前写的是
 * position: relative + flex: 1 —— 纵向 flex 里 flex:1 会把它撑满剩余高度，
 * 于是它独占一整行（实测 311px），把真正的聊天区挤到下半屏：
 * 用户看到的是会话顶部一大片空白，正文被压到下面。
 *
 * 修复：摘要条改绝对定位（浮层，与同层的悬浮顶栏一致），不参与纵向布局；
 * 同时滚动区在摘要条在场时多让出它的高度，首条消息不被盖住。
 *
 * 这里锁的是 CSS 契约：摘要条必须是 absolute、不得带 flex: 1；
 * 且必须有一条 :has() 规则为聊天区让位。
 */

const summaryCss = readFileSync(fileURLToPath(new URL("./todo-pin-summary.css", import.meta.url)), "utf8");
const responsiveCss = readFileSync(fileURLToPath(new URL("./conversation-responsive.css", import.meta.url)), "utf8");

/** 取某选择器的规则体。 */
function ruleOf(css: string, selector: string): string {
	const start = css.indexOf(selector);
	assert.notEqual(start, -1, `样式表里找不到规则：${selector}`);
	const open = css.indexOf("{", start);
	const close = css.indexOf("}", open);
	return css.slice(open + 1, close);
}

test("the task summary is an overlay, so it never takes a layout row", () => {
	const rule = ruleOf(summaryCss, '.owl-todo-anchor[data-presentation="summary"]');
	assert.match(rule, /position:\s*absolute/, "摘要条必须是绝对定位的浮层");
	assert.doesNotMatch(rule, /flex:\s*1\b/, "摘要条不得带 flex: 1：在纵向 flex 容器里它会撑满剩余高度");
	assert.doesNotMatch(rule, /flex-grow:\s*1\b/, "摘要条不得纵向生长");
});

test("the task summary is anchored below the floating header", () => {
	const rule = ruleOf(summaryCss, '.owl-todo-anchor[data-presentation="summary"]');
	assert.match(rule, /top:\s*calc\(var\(--owl-chat-header-h/, "摘要条应锚在悬浮顶栏下沿");
});

test("the task summary shares the reading column's width rule", () => {
	const rule = ruleOf(summaryCss, '.owl-todo-anchor[data-presentation="summary"]');
	assert.match(rule, /max-width:\s*min\(var\(--owl-chat-width/, "摘要条与 .owl-chat-column 用同一个取宽上限");
});

test("the chat area makes room for the task summary when it is present", () => {
	// 摘要条浮在聊天区上方，不让位就会盖住首条消息。
	assert.match(
		responsiveCss,
		/:has\(>\s*\.owl-todo-anchor\[data-presentation="summary"\]\)/,
		"需要一条 :has() 规则判摘要条是否在场",
	);
	assert.match(
		responsiveCss,
		/\.owl-agent-conversation:has\(> \.owl-todo-anchor\[data-presentation="summary"\]\) \.owl-chat-scroll/,
		"让位规则要作用在会话容器下的聊天滚动区",
	);
});
