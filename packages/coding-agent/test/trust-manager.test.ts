import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";

/**
 * True when a directory above `dir` (up to the filesystem root) already contains
 * `.agents/skills`. `hasTrustRequiringProjectResources` walks from cwd to the root
 * and treats every `.agents/skills` other than `$HOME/.agents/skills` as a project
 * resource (src/core/trust-manager.ts), so a fixture that fakes HOME as a temp dir
 * is only isolated while no ancestor of that temp dir has one.
 */
function hasAncestorAgentsSkillsDir(dir: string): boolean {
	let currentDir = dirname(dir);
	while (true) {
		if (existsSync(join(currentDir, ".agents", "skills"))) return true;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return false;
		currentDir = parentDir;
	}
}

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions and inherits from parent directories", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		expect(store.get(childDir)).toBeNull();
		store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		store.set(childDir, false);
		expect(store.get(childDir)).toBe(false);
		store.set(childDir, null);
		expect(store.get(childDir)).toBe(true);
	});

	it("detects trust-requiring project resources", () => {
		const originalHome = process.env.HOME;
		// The product derives the user-level skills dir from HOME. Point HOME at the
		// real user home: os.tmpdir() lives under it on Windows, so faking HOME as
		// the temp dir would leave the real ~/.agents/skills (the shared desktop-app
		// skills dir) in the fixture's ancestor chain, where the product correctly
		// counts it as a project resource. See the HOME-is-the-project case below.
		process.env.HOME = homedir();
		try {
			mkdirSync(join(tempDir, ".owl", "agent"), { recursive: true });
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			writeFileSync(join(tempDir, ".owl", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(true);
			rmSync(join(tempDir, ".owl", "settings.json"), { force: true });

			mkdirSync(join(cwd, ".owl"), { recursive: true });
			writeFileSync(join(cwd, ".owl", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);

			rmSync(join(cwd, ".owl"), { recursive: true, force: true });
			mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});

	it("ignores a user-level ~/.agents/skills directory that is HOME itself", (ctx) => {
		ctx.skip(
			hasAncestorAgentsSkillsDir(tempDir),
			`an ancestor of ${tempDir} already contains .agents/skills, so faking HOME as the temp dir cannot isolate this fixture`,
		);
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			mkdirSync(join(tempDir, ".owl", "agent"), { recursive: true });
			mkdirSync(join(tempDir, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});
});
