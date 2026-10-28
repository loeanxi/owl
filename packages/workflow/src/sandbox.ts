import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * The vm-sandbox bootstrap: the script context's ONLY globals are what this
 * adds. Every facade call becomes one NDJSON line on stdout; responses arrive
 * on stdin. Determinism bans (Date.now / argless Date / Math.random) are
 * runtime-enforced here on top of the compile-time facade.
 */
const SANDBOX_BOOTSTRAP = String.raw`
"use strict";

var __nextReq = 0;
var __nextLocal = 0;
var __pending = new Map();
var __settled = false;
// Bodies filled this world, by site id: a loop re-reach evaluates in place, no round trip.
var __fills = new Map();

function __send(obj) { __out.write(JSON.stringify(obj) + "\n"); }

function __createActor(siteId, name, persona) {
	// Process-unique handle; the parent maps it to (siteId, ordinal) per stdio FIFO before the ask lands.
	var localId = "a" + (++__nextLocal);
	__send({ kind: "create-actor", localId: localId, siteId: siteId, name: name, persona: persona });
	return localId;
}

function __ask(siteId, actor, instructions) {
	var id = "r" + (++__nextReq);
	return new Promise(function (resolve, reject) {
		__pending.set(id, { resolve: resolve, reject: reject });
		__send({ kind: "request", id: id, type: "ask", siteId: siteId, actor: String(actor), instructions: instructions });
	});
}

function __worldRead(siteId, op, args) {
	var id = "r" + (++__nextReq);
	return new Promise(function (resolve, reject) {
		__pending.set(id, { resolve: resolve, reject: reject });
		__send({ kind: "request", id: id, type: "world-read", siteId: siteId, op: op, args: args });
	});
}

function __publishArtifact(siteId, artifactOp, args) {
	var id = "r" + (++__nextReq);
	return new Promise(function (resolve, reject) {
		__pending.set(id, { resolve: resolve, reject: reject });
		__send({ kind: "request", id: id, type: "publish-artifact", siteId: siteId, artifactOp: artifactOp, args: args });
	});
}

function __declareArtifact(siteId, artifactOp, args) {
	// Same FIFO as report: a tagged report must arrive after its declaration.
	__send({ kind: "event", type: "declare-artifact", siteId: siteId, artifactOp: artifactOp, args: args });
}

function __report(siteId, item, artifactId) {
	// Arrival order is load-bearing (stdio FIFO); the parent journals by site x ordinal.
	__send({ kind: "event", type: "report", siteId: siteId, item: item, artifactId: artifactId });
}

function __log(message) {
	__send({ kind: "event", type: "log", message: String(message) });
}

function __enterPhase(name) {
	__send({ kind: "event", type: "phase-entered", name: String(name) });
}

function __evaluateFill(evaluate, code) {
	return Promise.resolve().then(function () {
		return evaluate(code)();
	});
}

var __FILL_WRAP_HEAD = "(async () => {\n";
var __FILL_WRAP_TAIL = "\n})";

function __hole(siteId, name, prompt, evaluate, body) {
	if (body !== undefined) {
		try { return Promise.resolve(body()); } catch (e) { return Promise.reject(e); }
	}
	var remembered = __fills.get(siteId);
	if (remembered !== undefined) return __evaluateFill(evaluate, __FILL_WRAP_HEAD + remembered + __FILL_WRAP_TAIL);
	var id = "r" + (++__nextReq);
	return new Promise(function (resolve, reject) {
		__pending.set(id, { resolve: resolve, reject: reject });
		__send({ kind: "request", id: id, type: "hole", siteId: siteId, name: name, prompt: prompt });
	}).then(function (answer) {
		// answer.code is the author's statements only; wrap here so eval, compiled at the
		// hole site, closes over every binding in scope and yields the body function.
		__fills.set(siteId, answer.code);
		return __evaluateFill(evaluate, __FILL_WRAP_HEAD + answer.code + __FILL_WRAP_TAIL);
	});
}

globalThis.__deliver = function (line) {
	var msg = JSON.parse(line);
	if (msg.kind !== "response") return;
	var waiter = __pending.get(msg.id);
	if (!waiter) return;
	__pending.delete(msg.id);
	if (msg.ok) { waiter.resolve(msg.value); return; }
	var e = msg.error || {};
	var err = new Error(e.message || "workflow host error");
	if (e.code !== undefined) err.code = e.code;
	waiter.reject(err);
};

globalThis.__complete = function (ok, payload) {
	if (__settled) return;
	__settled = true;
	if (ok) { __send({ kind: "complete", ok: true, value: payload }); return; }
	var wire = payload instanceof Error
		? { name: payload.name, message: payload.message, stack: payload.stack, code: payload.code }
		: { name: "Error", message: String(payload) };
	__send({ kind: "complete", ok: false, error: wire });
};

globalThis.__execute = function (runFn) {
	return Promise.resolve().then(runFn).then(
		function (value) { __complete(true, value); },
		function (e) { __complete(false, e); }
	);
};

globalThis.__checkStalled = function () {
	if (__settled || __pending.size > 0) return false;
	var waiting = [];
	for (var i = 0; i < __channels.length; i++) {
		var ch = __channels[i];
		var count = ch.waiters.length - ch.waitHead;
		if (count > 0) waiting.push(count + " on \"" + ch.label + "\"");
	}
	var err;
	if (waiting.length > 0) {
		err = new Error("Deadlock: " + __parkedReceivers + " receiver(s) waiting (" + waiting.join(", ") + ") with no request in flight. Close each channel from the stage that produces into it (ch.close() in a finally).");
		err.name = "ChannelDeadlock";
		err.code = "ChannelDeadlock";
	} else {
		err = new Error("Stalled: the script is suspended with no request in flight and no channel receiver waiting, so nothing can ever resolve what it awaits.");
		err.name = "ScriptStalled";
		err.code = "ScriptStalled";
	}
	__complete(false, err);
	return true;
};

// Determinism bans: the journal can only replay a script with no wall clock and no RNG.
var __NativeDate = Date;
class __WorkflowDate extends __NativeDate {
	constructor() {
		if (arguments.length === 0) throw new Error("argless new Date() is disabled in workflows");
		super(...arguments);
	}
	static now() { throw new Error("Date.now() is disabled in workflows"); }
	static parse(value) { return __NativeDate.parse(value); }
	static UTC() { return __NativeDate.UTC.apply(__NativeDate, arguments); }
}
globalThis.Date = __WorkflowDate;
Math.random = function () { throw new Error("Math.random() is disabled in workflows"); };

globalThis.__host = {
	args: Object.freeze(JSON.parse(__argsJson)),
	createActor: __createActor,
	ask: __ask,
	worldRead: __worldRead,
	publishArtifact: __publishArtifact,
	declareArtifact: __declareArtifact,
	report: __report,
	log: __log,
	enterPhase: __enterPhase,
	hole: __hole,
};
`;

const STREAMS_BOOTSTRAP = String.raw`
"use strict";
var __channels = [];
var __parkedReceivers = 0;
var __END = Object.freeze({ value: undefined, done: true });

function __channel(name) {
	var label = name === undefined || name === null ? "channel #" + (__channels.length + 1) : String(name);
	var state = { label: label, items: [], head: 0, waiters: [], waitHead: 0, closed: false };
	__channels.push(state);
	function compact() {
		if (state.head >= 1024 && state.head * 2 >= state.items.length) { state.items = state.items.slice(state.head); state.head = 0; }
		if (state.waitHead >= 1024 && state.waitHead * 2 >= state.waiters.length) { state.waiters = state.waiters.slice(state.waitHead); state.waitHead = 0; }
	}
	function takeWaiter() {
		if (state.waitHead >= state.waiters.length) return undefined;
		var waiter = state.waiters[state.waitHead];
		state.waiters[state.waitHead] = undefined;
		state.waitHead += 1;
		__parkedReceivers -= 1;
		compact();
		return waiter;
	}
	function next() {
		if (state.head < state.items.length) {
			var item = state.items[state.head];
			state.items[state.head] = undefined;
			state.head += 1;
			compact();
			return Promise.resolve({ value: item, done: false });
		}
		if (state.closed) return Promise.resolve(__END);
		return new Promise(function (resolve) { state.waiters.push(resolve); __parkedReceivers += 1; });
	}
	var channel = {
		send: function (item) {
			if (state.closed) {
				var err = new Error("Channel \"" + state.label + "\" is closed: send() after close(). The producing stage owns the close; close it in a finally.");
				err.name = "ChannelClosed";
				err.code = "ChannelClosed";
				throw err;
			}
			var waiter = takeWaiter();
			if (waiter !== undefined) waiter({ value: item, done: false });
			else state.items.push(item);
		},
		close: function () {
			if (state.closed) return;
			state.closed = true;
			for (var waiter = takeWaiter(); waiter !== undefined; waiter = takeWaiter()) waiter(__END);
		},
	};
	channel[Symbol.asyncIterator] = function () {
		var iterator = { next: next, return: function () { return Promise.resolve(__END); } };
		iterator[Symbol.asyncIterator] = function () { return iterator; };
		return iterator;
	};
	return channel;
}

function __future(body) {
	try {
		var result = body();
		return result instanceof Promise ? result : Promise.resolve(result);
	} catch (e) {
		return Promise.reject(e);
	}
}

globalThis.__host.channel = __channel;
globalThis.__host.future = __future;
`;

/** The child sandbox main: function body evaluated with `deps` in scope via new Function. */
const CHILD_MAIN_BODY = String.raw`
var sandbox = { __argsJson: deps.argsJson, __out: deps.stdout };
deps.vm.createContext(sandbox, { name: "workflow-sandbox" });
deps.vm.runInContext(deps.bootstrap, sandbox, { filename: "workflow-bootstrap.js" });
deps.vm.runInContext(deps.streams, sandbox, { filename: "workflow-streams.js" });
var runFn;
try {
	runFn = deps.vm.runInContext("(async (__host) => {\n" + deps.lowered + "\n})", sandbox, { filename: "workflow-script.js" });
} catch (e) {
	deps.stdout.write(JSON.stringify({ kind: "complete", ok: false, error: { name: (e && e.name) || "SyntaxError", message: String(e), stack: e && e.stack } }) + "\n");
	return Promise.resolve();
}
var reader = deps.createInterface({ input: deps.stdin });
reader.on("line", function (line) {
	if (!line.trim()) return;
	sandbox.__deliver(line);
	setImmediate(function () {
		if (sandbox.__checkStalled()) reader.close();
	});
});
var settled = sandbox.__execute(function () { return runFn(sandbox.__host); });
settled.then(function () { reader.close(); }, function () { reader.close(); });
// Stall check fires once after the script starts, and again after every response delivery:
// a vm cell has no timers or I/O, so "nothing in flight, microtasks drained, not settled" is terminal.
setImmediate(function () {
	if (sandbox.__checkStalled()) reader.close();
});
`;

export interface SandboxPayload {
	runId: string;
	lowered: string;
	args: Record<string, unknown>;
}

export interface ChildMessage {
	kind: "create-actor" | "request" | "event" | "complete";
	[key: string]: unknown;
}

export interface SandboxHandle {
	stdin: { write(chunk: string): void };
	child: ReturnType<typeof spawn>;
}

/** Render the child entry file (gitignored runs dir), spawn it, and wire NDJSON lines. */
export function spawnSandbox(
	payload: SandboxPayload,
	runsDir: string,
	onMessage: (msg: ChildMessage) => void,
	onStderr?: (text: string) => void,
): SandboxHandle {
	const entryDir = join(runsDir, ".entries");
	mkdirSync(entryDir, { recursive: true });
	try {
		writeFileSync(join(entryDir, ".gitignore"), "*\n", { flag: "wx" });
	} catch (e: any) {
		if (e?.code !== "EEXIST") throw e;
	}
	const safeRunId = payload.runId.replace(/[^A-Za-z0-9._-]/g, "_");
	const entryPath = join(entryDir, `${safeRunId}.mjs`);

	const entry = `// owl workflow sandbox entry for run ${safeRunId}; regenerated before every launch, safe to delete.
import vm from "node:vm";
import { createInterface } from "node:readline";

const bootstrap = ${JSON.stringify(SANDBOX_BOOTSTRAP)};
const streams = ${JSON.stringify(STREAMS_BOOTSTRAP)};
const payload = ${JSON.stringify({ lowered: payload.lowered, argsJson: JSON.stringify(payload.args ?? {}) })};

new Function("deps", ${JSON.stringify(CHILD_MAIN_BODY)})({
	vm,
	createInterface,
	stdin: process.stdin,
	stdout: process.stdout,
	bootstrap,
	streams,
	lowered: payload.lowered,
	argsJson: payload.argsJson,
});
`;
	writeFileSync(entryPath, entry, "utf8");

	const child = spawn(process.execPath, [entryPath], { cwd: runsDir, stdio: ["pipe", "pipe", "pipe"] });
	const handle: SandboxHandle = { stdin: child.stdin!, child };

	createInterface({ input: child.stdout! }).on("line", (line) => {
		if (!line.trim()) return;
		try {
			onMessage(JSON.parse(line) as ChildMessage);
		} catch {
			onStderr?.(`unparsable sandbox line: ${line}`);
		}
	});
	child.stderr?.on("data", (chunk) => onStderr?.(chunk.toString("utf8")));
	return handle;
}

export function writeResponse(
	handle: SandboxHandle,
	id: string,
	ok: boolean,
	value?: unknown,
	error?: { code?: string; message: string },
): void {
	handle.stdin.write(`${JSON.stringify({ kind: "response", id, ok, ...(ok ? { value } : { error }) })}\n`);
}
