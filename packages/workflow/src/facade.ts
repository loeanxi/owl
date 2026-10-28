/**
 * The ambient facade every workflow script is typechecked against.
 * Trimmed from ZCode's §16.2 to the v1 surface: ask/agent/phase/hole/log/report/
 * files/git/world/channel/future/artifact. JSDoc on ask<T> result interfaces
 * becomes the field description the subagent reads.
 */
export const FACADE_DTS = `
declare interface Node<T> extends PromiseLike<T> {}

declare interface AgentPersona {
	/** System prompt describing the actor's role. */
	system?: string;
}

declare interface Agent {
	ask<T = string>(instructions: string): Node<T>;
}

declare function agent(name?: string, persona?: string | AgentPersona): Agent;

declare const args: Readonly<Record<string, unknown>>;

declare function log(message: string): void;

declare function report(item: unknown, artifactId?: string): void;

declare function phase(name: string): void;

declare function hole<T>(name: string, prompt?: string): Promise<T>;
declare function hole<T>(name: string, body: () => Promise<T>): Promise<T>;
declare function hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;

declare interface GrepMatch {
	path: string;
	line: number;
	text: string;
}

declare const files: {
	glob(pattern: string): Promise<string[]>;
	read(path: string): Promise<string>;
	grep(pattern: string, glob?: string): Promise<GrepMatch[]>;
};

declare interface GitStatus {
	branch?: string;
	clean: boolean;
	staged: string[];
	unstaged: string[];
	untracked: string[];
}

declare interface GitCommit {
	hash: string;
	subject: string;
	author: string;
	date: string;
}

declare const git: {
	changedFiles(base?: string): Promise<string[]>;
	diff(base?: string, path?: string): Promise<string>;
	status(): Promise<GitStatus>;
	log(count?: number): Promise<GitCommit[]>;
};

declare interface WorldRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

declare const world: {
	run(cmd: string, args?: string[], opts?: { timeoutMs?: number }): Promise<WorldRunResult>;
};

declare interface Channel<T> extends AsyncIterable<T> {
	send(item: T): void;
	close(): void;
}

declare function channel<T>(name?: string): Channel<T>;

declare function future<T>(body: () => Promise<T>): Promise<T>;
`;
