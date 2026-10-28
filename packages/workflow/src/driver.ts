import type { AskOutcome, AskRequest, WorkflowDriver } from "./types.js";

/**
 * Test/development driver: answers asks from a scripted table (exact match,
 * then substring, then fallback) and serves world reads from a fixed table.
 * World runs execute through a configurable command hook; the default runs
 * node with the args. A real driver backed by pi's agent sessions plugs into
 * the same WorkflowDriver interface.
 */
export interface ScriptedDriverOptions {
	/** Matched in order; first hit wins. Match is exact, or substring when `contains` is set. */
	answers: Array<{ contains?: string; equals?: string; result: unknown; worldToolCalls?: number; sessionId?: string }>;
	worldReads?: Record<string, unknown>;
	worldRun?: (cmd: string, args: string[]) => { exitCode: number; stdout: string; stderr: string };
	fallback?: (req: AskRequest) => unknown;
}

export class ScriptedDriver implements WorkflowDriver {
	private calls: AskRequest[] = [];
	private worldCalls: Array<{ op: string; args: unknown[] }> = [];

	private readonly options: ScriptedDriverOptions;

	constructor(options: ScriptedDriverOptions) {
		this.options = options;
	}

	get askCalls(): readonly AskRequest[] {
		return this.calls;
	}

	get worldReadCalls(): ReadonlyArray<{ op: string; args: unknown[] }> {
		return this.worldCalls;
	}

	async executeAsk(req: AskRequest): Promise<AskOutcome> {
		this.calls.push(req);
		for (const answer of this.options.answers) {
			if (answer.equals !== undefined && req.instructions === answer.equals) {
				return {
					result: answer.result,
					stats: { worldToolCalls: answer.worldToolCalls ?? 0, sessionId: answer.sessionId },
				};
			}
			if (answer.contains !== undefined && req.instructions.includes(answer.contains)) {
				return {
					result: answer.result,
					stats: { worldToolCalls: answer.worldToolCalls ?? 0, sessionId: answer.sessionId },
				};
			}
		}
		if (this.options.fallback) return { result: this.options.fallback(req), stats: { worldToolCalls: 0 } };
		throw new Error(`ScriptedDriver: no answer for ${JSON.stringify(req.instructions.slice(0, 120))}`);
	}

	async executeWorldRead(op: string, args: unknown[]): Promise<unknown> {
		this.worldCalls.push({ op, args });
		if (op === "world.run") {
			const [cmd, ...rest] = args as [string, string[]?];
			const run = this.options.worldRun ?? defaultWorldRun;
			return run(cmd, (rest[0] as string[]) ?? []);
		}
		const key = `${op}:${JSON.stringify(args)}`;
		if (key in (this.options.worldReads ?? {})) return this.options.worldReads![key];
		if (op in (this.options.worldReads ?? {})) return this.options.worldReads![op];
		throw new Error(`ScriptedDriver: no world read for ${op} ${JSON.stringify(args).slice(0, 120)}`);
	}
}

function defaultWorldRun(cmd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
	throw new Error(`ScriptedDriver: no worldRun hook for ${cmd} ${args.join(" ")}`);
}
