import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DesktopSubagentActivity, DesktopSubagentDetail, DesktopSubagentSummary } from "./protocol.ts";

type JsonRecord = Record<string, unknown>;

export interface DesktopSubagentSource {
	parentSessionId: string;
	parentFile: string;
	parentRunning: boolean;
	/** In-flight tool details, observed by the existing parent runtime subscription. */
	liveToolResults?: ReadonlyArray<{ toolCallId: string; details: unknown }>;
}

interface ChildSource {
	runId: string;
	childIndex: number;
	sessionFile?: string;
	transcriptPath?: string;
	metadataPath?: string;
	toolCallId?: string;
	result?: JsonRecord;
}

interface Launch {
	toolCallId: string;
	timestamp: string;
	args: JsonRecord;
	settled: boolean;
}

function record(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function iso(value: unknown): string | undefined {
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => string(record(item)?.text) ?? "")
		.filter(Boolean)
		.join("\n");
}

function validRunId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

/** Keep the beginning and latest complete records without loading an unbounded child log. */
async function readJsonl(
	path: string | undefined,
	maxBytes: number,
): Promise<{ rows: JsonRecord[]; truncated: boolean; modified?: string }> {
	if (!path) return { rows: [], truncated: false };
	try {
		const handle = await open(path, "r");
		try {
			const info = await handle.stat();
			const truncated = info.size > maxBytes;
			const headSize = truncated ? Math.min(64 * 1024, Math.floor(maxBytes / 2)) : info.size;
			const head = Buffer.alloc(headSize);
			const headRead = await handle.read(head, 0, head.length, 0);
			let content = head.subarray(0, headRead.bytesRead).toString("utf8");
			if (truncated) {
				const tail = Buffer.alloc(maxBytes - headSize);
				const tailRead = await handle.read(tail, 0, tail.length, info.size - tail.length);
				const tailContent = tail.subarray(0, tailRead.bytesRead).toString("utf8");
				content = `${content.slice(0, content.lastIndexOf("\n") + 1)}${tailContent.slice(tailContent.indexOf("\n") + 1)}`;
			}
			const rows: JsonRecord[] = [];
			for (const line of content.split(/\r?\n/)) {
				try {
					const parsed = record(JSON.parse(line));
					if (parsed) rows.push(parsed);
				} catch {
					/* A live writer may have an incomplete final JSONL record. */
				}
			}
			return { rows, truncated, modified: info.mtime.toISOString() };
		} finally {
			await handle.close();
		}
	} catch {
		return { rows: [], truncated: false };
	}
}

async function readMetadata(path: string | undefined): Promise<JsonRecord | undefined> {
	if (!path) return undefined;
	try {
		if ((await stat(path)).size > 512 * 1024) return undefined;
		return record(JSON.parse(await readFile(path, "utf8")));
	} catch {
		return undefined;
	}
}

function tasksForLaunch(launch: Launch): JsonRecord[] {
	const grouped = launch.args.tasks ?? launch.args.chain;
	return Array.isArray(grouped)
		? grouped.map(record).filter((item): item is JsonRecord => Boolean(item))
		: [launch.args];
}

async function inventory(
	source: DesktopSubagentSource,
): Promise<{ children: ChildSource[]; launches: Launch[]; cwd: string }> {
	const parent = await readJsonl(source.parentFile, 24 * 1024 * 1024);
	if (parent.rows[0]?.type !== "session" || parent.rows[0].id !== source.parentSessionId) {
		throw new Error("父会话记录不存在或会话标识不一致");
	}
	const launches: Launch[] = [];
	const children = new Map<string, ChildSource>();
	const asyncStatuses: Array<{ path: string; runId: string; toolCallId?: string }> = [];
	const put = (child: ChildSource) => {
		const id = `${child.runId}:${child.childIndex}`;
		const previous = children.get(id);
		children.set(id, { ...previous, ...child, toolCallId: previous?.toolCallId ?? child.toolCallId });
	};
	const persistedToolCalls = new Set(
		parent.rows
			.map((entry) => record(entry.message))
			.filter((message) => message?.role === "toolResult" && message.toolName === "subagent")
			.map((message) => string(message?.toolCallId)),
	);
	const rows: JsonRecord[] = [
		...parent.rows,
		...(source.liveToolResults ?? [])
			.filter((live) => !persistedToolCalls.has(live.toolCallId))
			.map((live) => ({
				message: { role: "toolResult", toolName: "subagent", toolCallId: live.toolCallId, details: live.details },
			})),
	];
	for (const entry of rows) {
		const message = record(entry.message);
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const item of message.content) {
				const call = record(item);
				const args = record(call?.arguments);
				if (call?.type !== "toolCall" || call.name !== "subagent" || !args || !string(call.id)) continue;
				if (!args.agent && !Array.isArray(args.tasks) && !Array.isArray(args.chain) && !args.workflow) continue;
				launches.push({ toolCallId: String(call.id), timestamp: iso(entry.timestamp) ?? "", args, settled: false });
			}
		}
		if (message?.role !== "toolResult" || message.toolName !== "subagent") continue;
		const toolCallId = string(message.toolCallId);
		const launch = launches.find((item) => item.toolCallId === toolCallId);
		if (launch && parent.rows.includes(entry)) launch.settled = true;
		const details = record(message.details);
		const runId = details?.runId ?? details?.asyncId;
		if (!validRunId(runId)) continue;
		const workflowChildren = record(details?.workflowChildren);
		const workflowRows = Array.isArray(workflowChildren?.children)
			? workflowChildren.children.map(record).filter((item): item is JsonRecord => Boolean(item))
			: [];
		const ownerToolCallId = string(workflowChildren?.parentToolCallId) ?? toolCallId;
		for (const workflowChild of workflowRows) {
			if (!validRunId(workflowChild.runId)) continue;
			put({
				runId: workflowChild.runId,
				childIndex: 0,
				toolCallId: ownerToolCallId,
				result: { ...workflowChild, status: workflowChild.state, progress: workflowChild.activity },
			});
		}
		const asyncDir = string(details?.asyncDir);
		if (asyncDir) asyncStatuses.push({ path: join(asyncDir, "status.json"), runId, toolCallId: ownerToolCallId });
		const results = Array.isArray(details?.results) ? details.results : [];
		for (const [index, raw] of results.entries()) {
			const result = record(raw);
			if (!result) continue;
			const workflowChild = workflowRows.find((item) => item.childId === result.workflowKey);
			const childRunId = validRunId(result.runId)
				? result.runId
				: validRunId(workflowChild?.runId)
					? workflowChild.runId
					: runId;
			const childIndex =
				typeof result.index === "number" && Number.isInteger(result.index)
					? result.index
					: workflowChild
						? 0
						: index;
			const paths = record(result.artifactPaths);
			put({
				runId: childRunId,
				childIndex,
				toolCallId: ownerToolCallId,
				result: { ...children.get(`${childRunId}:${childIndex}`)?.result, ...result },
				sessionFile: string(result.sessionFile),
				transcriptPath: string(result.transcriptPath) ?? string(paths?.transcriptPath),
				metadataPath: string(paths?.metadataPath),
			});
		}
	}
	const root = join(dirname(source.parentFile), basename(source.parentFile, ".jsonl"));
	for (const pending of asyncStatuses) {
		const status = await readMetadata(pending.path);
		if (!status || (status.runId !== undefined && status.runId !== pending.runId)) continue;
		const steps = Array.isArray(status.steps) ? status.steps : [];
		for (const [index, raw] of steps.entries()) {
			const step = record(raw);
			if (!step) continue;
			const runId = validRunId(step.runId) ? step.runId : pending.runId;
			const childIndex = runId === pending.runId ? index : 0;
			const previous = children.get(`${runId}:${childIndex}`);
			put({
				...previous,
				runId,
				childIndex,
				toolCallId: pending.toolCallId,
				result: { ...previous?.result, ...step },
				sessionFile: string(step.sessionFile) ?? previous?.sessionFile,
				transcriptPath: string(step.transcriptPath) ?? previous?.transcriptPath,
			});
		}
	}
	try {
		const runs = await readdir(root, { withFileTypes: true });
		await Promise.all(
			runs
				.filter((run) => run.isDirectory() && validRunId(run.name))
				.slice(0, 200)
				.map(async (run) => {
					const runDir = join(root, run.name);
					const entries = await readdir(runDir, { withFileTypes: true }).catch(() => []);
					for (const entry of entries) {
						const match = /^run-(\d+)$/.exec(entry.name);
						if (!entry.isDirectory() || !match) continue;
						const childIndex = Number(match[1]);
						const sessionFile = join(runDir, entry.name, "session.jsonl");
						// Detached runs can have a public run ID different from their storage directory ID.
						// Keep the launch/status identity for a session already associated with a result.
						if (
							[...children.values()].some(
								(child) =>
									child.sessionFile &&
									resolve(child.sessionFile).toLowerCase() === resolve(sessionFile).toLowerCase(),
							)
						)
							continue;
						const id = `${run.name}:${childIndex}`;
						put({
							...children.get(id),
							runId: run.name,
							childIndex,
							sessionFile,
						});
					}
				}),
		);
	} catch {
		/* Sessions without delegated children have no child directory. */
	}
	const artifacts = join(dirname(source.parentFile), "subagent-artifacts");
	const files = await readdir(artifacts).catch(() => []);
	for (const child of children.values()) {
		child.sessionFile ??= join(root, child.runId, `run-${child.childIndex}`, "session.jsonl");
		const suffix = `_${child.childIndex}_transcript.jsonl`;
		const transcript = files.find((name) => name.startsWith(`${child.runId}_`) && name.endsWith(suffix));
		if (transcript && !child.transcriptPath) child.transcriptPath = join(artifacts, transcript);
		if (!child.metadataPath && child.transcriptPath?.endsWith("_transcript.jsonl")) {
			child.metadataPath = child.transcriptPath.replace(/_transcript\.jsonl$/, "_meta.json");
		}
	}
	return { children: [...children.values()], launches, cwd: string(parent.rows[0]?.cwd) ?? "" };
}

function statusOf(value: unknown): DesktopSubagentSummary["status"] | undefined {
	if (value === "running" || value === "completed" || value === "failed" || value === "paused" || value === "stopped")
		return value;
	if (value === "complete" || value === "done") return "completed";
	if (value === "rejected" || value === "partial") return "failed";
	if (value === "pending" || value === "starting" || value === "queued") return "running";
	return undefined;
}

async function describeChild(
	source: DesktopSubagentSource,
	child: ChildSource,
	launches: Launch[],
	cwd: string,
	detail: boolean,
): Promise<DesktopSubagentDetail> {
	const [session, transcript, metadata] = await Promise.all([
		readJsonl(child.sessionFile, detail ? 2 * 1024 * 1024 : 256 * 1024),
		readJsonl(child.transcriptPath, detail ? 2 * 1024 * 1024 : 256 * 1024),
		readMetadata(child.metadataPath),
	]);
	const header = session.rows.find((row) => row.type === "session");
	const sessionName = session.rows.find((row) => row.type === "session_info")?.name;
	const nameMatch =
		typeof sessionName === "string" ? new RegExp(`^subagent-(.+)-${child.runId}-\\d+$`).exec(sessionName) : null;
	const agent =
		string(child.result?.agent) ??
		string(metadata?.agent) ??
		string(transcript.rows[0]?.agent) ??
		nameMatch?.[1] ??
		"subagent";
	const sessionMessages = session.rows
		.map((row) => record(row.message))
		.filter((message): message is JsonRecord => Boolean(message));
	const firstUser = sessionMessages.find((message) => message.role === "user");
	const prompt = textContent(firstUser?.content).replace(/^Task:\s*/, "");
	const startedAt = iso(header?.timestamp) ?? iso(transcript.rows[0]?.timestamp);
	let launch = launches.find((item) => item.toolCallId === child.toolCallId);
	if (!launch && startedAt) {
		// During execution the parent has no toolResult yet. Task + launch time prevent
		// one reviewer's card from opening a different reviewer from an earlier turn.
		launch = launches
			.filter(
				(item) =>
					!item.settled &&
					item.timestamp <= startedAt &&
					tasksForLaunch(item).some(
						(task) =>
							(string(task.agent) ?? "subagent") === agent &&
							Boolean(string(task.task)) &&
							prompt.includes(String(task.task)),
					),
			)
			.sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
	}
	const launchTasks = launch ? tasksForLaunch(launch) : [];
	const launchTask =
		launchTasks.find(
			(task) => string(task.agent) === agent && string(task.task) && prompt.includes(String(task.task)),
		) ?? launchTasks[child.childIndex];
	const task =
		string(launchTask?.task) ?? string(prompt) ?? string(child.result?.task) ?? string(metadata?.task) ?? "";
	const result = child.result ?? {};
	let status =
		result.stopped === true
			? ("stopped" as const)
			: result.interrupted === true || result.detached === true
				? ("paused" as const)
				: (statusOf(record(result.progress)?.status) ??
					statusOf(result.status) ??
					statusOf(result.state) ??
					statusOf(metadata?.status));
	// Live snapshots initialize exitCode to zero before the child has finished.
	// Only the terminal metadata may replace an explicit running progress state.
	if (typeof metadata?.exitCode === "number" && (status === undefined || status === "running")) {
		status = metadata.exitCode === 0 ? "completed" : "failed";
	} else if (!status && typeof result.exitCode === "number") {
		status = result.exitCode === 0 ? "completed" : "failed";
	}
	if (!status) status = source.parentRunning && launch && !launch.settled ? "running" : "unknown";
	const activity: DesktopSubagentActivity[] = [];
	const messages: unknown[] = [];
	for (const [index, row] of transcript.rows.entries()) {
		const type = row.recordType;
		if (type !== "message" && type !== "tool_start" && type !== "tool_end" && type !== "stdout" && type !== "stderr")
			continue;
		let args: JsonRecord | undefined;
		if (typeof row.argsPayload === "string") {
			try {
				args = record(JSON.parse(row.argsPayload));
			} catch {
				/* Truncated tool payload. */
			}
		}
		activity.push({
			id: `${child.runId}:${child.childIndex}:${String(row.ts ?? index)}:${index}`,
			type,
			timestamp: iso(row.timestamp) ?? iso(row.ts) ?? startedAt ?? new Date(0).toISOString(),
			...(string(row.text) ? { text: String(row.text) } : {}),
			...(string(row.toolName) ? { toolName: String(row.toolName) } : {}),
			...(args ? { args } : {}),
			...(typeof row.isError === "boolean" ? { isError: row.isError } : {}),
		});
		if (type === "message" && record(row.message)) messages.push(row.message);
	}
	const usedSessionMessages = !messages.length;
	if (usedSessionMessages) messages.push(...sessionMessages);
	// Session logs preserve unredacted task input while artifact logs may omit it.
	if (task && messages.length && record(messages[0])?.role === "user") {
		messages[0] = { ...record(messages[0]), content: [{ type: "text", text: task }] };
	}
	let currentTool: string | undefined;
	const activeTools = new Map<string, string>();
	for (const row of transcript.rows) {
		if (row.recordType === "tool_start" && string(row.toolName))
			activeTools.set(String(row.toolCallId ?? row.toolName), String(row.toolName));
		if (row.recordType === "tool_end") activeTools.delete(String(row.toolCallId ?? row.toolName));
	}
	if (status === "running")
		currentTool = [...activeTools.values()].at(-1) ?? string(record(result.progress)?.currentTool);
	const modelChange = session.rows.findLast((row) => row.type === "model_change");
	const error =
		string(metadata?.error) ??
		string(result.error) ??
		string(sessionMessages.findLast((message) => message.stopReason === "error")?.errorMessage);
	const updatedAt =
		[iso(metadata?.timestamp), session.modified, transcript.modified, iso(result.updatedAt), startedAt]
			.filter((value): value is string => Boolean(value))
			.sort()
			.at(-1) ?? new Date(0).toISOString();
	return {
		id: `${child.runId}:${child.childIndex}`,
		runId: child.runId,
		childIndex: child.childIndex,
		parentSessionId: source.parentSessionId,
		...((child.toolCallId ?? launch?.toolCallId) ? { toolCallId: child.toolCallId ?? launch?.toolCallId } : {}),
		agent,
		task,
		cwd: string(header?.cwd) ?? cwd,
		status,
		...(startedAt ? { startedAt } : {}),
		updatedAt,
		...(currentTool ? { currentTool } : {}),
		...((string(result.model) ?? string(metadata?.model) ?? string(modelChange?.modelId))
			? { model: string(result.model) ?? string(metadata?.model) ?? string(modelChange?.modelId) }
			: {}),
		...(string(header?.id) ? { sessionId: String(header?.id) } : {}),
		messages,
		activity,
		...(error ? { error } : {}),
		truncated:
			(usedSessionMessages && session.truncated) ||
			transcript.truncated ||
			transcript.rows.some((row) => row.recordType === "truncated"),
	};
}

export async function listDesktopSubagents(
	source: DesktopSubagentSource,
	filter?: { toolCallId?: string; cwd?: string },
): Promise<DesktopSubagentSummary[]> {
	const found = await inventory(source);
	if (filter?.cwd && resolve(filter.cwd).toLowerCase() !== resolve(found.cwd).toLowerCase()) return [];
	const summaries = await Promise.all(
		found.children.map(async (child) => {
			const {
				messages: _messages,
				activity: _activity,
				error: _error,
				truncated: _truncated,
				...summary
			} = await describeChild(source, child, found.launches, found.cwd, false);
			return summary;
		}),
	);
	return summaries
		.filter((child) => !filter?.toolCallId || child.toolCallId === filter.toolCallId)
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getDesktopSubagent(
	source: DesktopSubagentSource,
	runId: string,
	childIndex = 0,
): Promise<DesktopSubagentDetail> {
	if (!validRunId(runId) || !Number.isInteger(childIndex) || childIndex < 0) throw new Error("无效的子智能体标识");
	const found = await inventory(source);
	const child = found.children.find((item) => item.runId === runId && item.childIndex === childIndex);
	if (!child) throw new Error("此父会话下没有该子智能体记录");
	return describeChild(source, child, found.launches, found.cwd, true);
}
