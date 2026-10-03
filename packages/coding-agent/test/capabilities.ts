/**
 * Capability probes for tests that need host features a runner may not have:
 * symlink privileges, POSIX mode bits, or a search binary that would otherwise
 * have to be downloaded.
 *
 * `vitest.config.ts` sets PI_OFFLINE=1 for every test file, so a missing rg/fd
 * is a host limitation rather than a product failure. Guard such tests with
 * `describe.skipIf(!CAPABILITY)` or `it.skipIf(!CAPABILITY)`.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getToolPath } from "../src/utils/tools-manager.ts";

function probe(check: (dir: string) => boolean): boolean {
	const dir = mkdtempSync(join(tmpdir(), "pi-capability-"));
	try {
		return check(dir);
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Windows grants symlink creation only to elevated processes or Developer Mode. */
export const SYMLINKS_SUPPORTED: boolean = probe((dir) => {
	const target = join(dir, "target.txt");
	const link = join(dir, "link.txt");
	writeFileSync(target, "probe");
	symlinkSync(target, link);
	return readFileSync(link, "utf-8") === "probe";
});

/** Windows ignores POSIX mode bits, so chmod 0 does not make a file unreadable. */
export const UNREADABLE_FILES_SUPPORTED: boolean = probe((dir) => {
	const file = join(dir, "unreadable.txt");
	writeFileSync(file, "probe");
	chmodSync(file, 0o000);
	try {
		readFileSync(file, "utf-8");
		return false;
	} catch {
		return true;
	} finally {
		chmodSync(file, 0o600);
	}
});

/** Windows ignores POSIX mode bits, so chmod 0o500 does not make a directory read-only. */
export const READONLY_DIRS_SUPPORTED: boolean = probe((dir) => {
	const locked = join(dir, "locked");
	mkdirSync(locked, { recursive: true });
	chmodSync(locked, 0o500);
	try {
		writeFileSync(join(locked, "probe.txt"), "probe");
		return false;
	} catch {
		return true;
	} finally {
		chmodSync(locked, 0o700);
	}
});

/** npm's global root for a custom prefix is `<prefix>/lib/node_modules` only on POSIX. */
export const POSIX_NPM_PREFIX_LAYOUT: boolean = process.platform !== "win32";

/** ripgrep resolved from the tools dir or PATH without downloading. */
export const RG_AVAILABLE: boolean = getToolPath("rg") !== null;

/** fd resolved from the tools dir or PATH without downloading. */
export const FD_AVAILABLE: boolean = getToolPath("fd") !== null;
