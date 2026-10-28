import assert from "node:assert/strict";
import test from "node:test";
import { CHANGES_FOCUS_EVENT, consumeChangesFocus, focusChangesFile, peekChangesFocus } from "./changes-focus.ts";
import {
	consumeEditorLineFocus,
	EDITOR_LINE_FOCUS_EVENT,
	focusEditorLine,
	peekEditorLineFocus,
} from "./editor-line-focus.ts";

// 两条总线都在浏览器里派发 window 事件；node --test 没有 window，补一个够用的。
const listeners = new Map<string, (event: unknown) => void>();
(globalThis as { window?: unknown }).window = {
	dispatchEvent: (event: { type: string }) => {
		listeners.get(event.type)?.(event);
		return true;
	},
	addEventListener: (type: string, handler: (event: unknown) => void) => {
		listeners.set(type, handler);
	},
	removeEventListener: (type: string) => {
		listeners.delete(type);
	},
};

test("the line request is peeked first and only the matching instance takes it", () => {
	focusEditorLine("src/app.ts", 42, 48);
	const peeked = peekEditorLineFocus();
	assert.equal(peeked?.path, "src/app.ts");
	assert.equal(peeked?.line, 42);
	assert.equal(peeked?.endLine, 48);
	// peek 不取走：工作台里挂着的多个编辑器实例要自己判断路径是否匹配。
	assert.equal(peekEditorLineFocus()?.path, "src/app.ts");
	assert.equal(consumeEditorLineFocus()?.path, "src/app.ts");
	assert.equal(peekEditorLineFocus(), undefined);
});

test("the line request carries a timestamp so stale requests can be dropped", () => {
	focusEditorLine("src/app.ts", 7);
	const at = peekEditorLineFocus()?.at;
	assert.equal(typeof at, "number");
	assert.ok(at !== undefined && at > 0);
	consumeEditorLineFocus();
});

test("a request without a line number still targets the file", () => {
	focusEditorLine("src/app.ts");
	const focus = consumeEditorLineFocus();
	assert.equal(focus?.path, "src/app.ts");
	assert.equal(focus?.line, undefined);
});

test("the line request notifies subscribers so a mounted editor reacts immediately", () => {
	let seen = 0;
	const handler = (): void => {
		seen += 1;
	};
	(
		globalThis as { window?: { addEventListener: (type: string, handler: () => void) => void } }
	).window!.addEventListener(EDITOR_LINE_FOCUS_EVENT, handler);
	focusEditorLine("src/app.ts", 3);
	assert.equal(seen, 1);
	consumeEditorLineFocus();
});

test("the change card request is taken over once", () => {
	focusChangesFile("src/app.ts");
	assert.deepEqual(peekChangesFocus(), { path: "src/app.ts" });
	assert.deepEqual(consumeChangesFocus(), { path: "src/app.ts" });
	assert.equal(peekChangesFocus(), undefined);
});

test("the change card request has its own event channel", () => {
	let seen = 0;
	const handler = (): void => {
		seen += 1;
	};
	(
		globalThis as { window?: { addEventListener: (type: string, handler: () => void) => void } }
	).window!.addEventListener(CHANGES_FOCUS_EVENT, handler);
	focusChangesFile("src/app.ts");
	assert.equal(seen, 1);
	consumeChangesFocus();
});
