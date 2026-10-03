#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const RUNTIME_VERSION = "0.3.6";
export const RUNTIME_GIT_HEAD = "c2caaefb43dc464f1477463c754f17a6be956193";
export const RUNTIME_INTEGRITY =
	"sha512-IaLbxGvKdPHS6hdb/K/Bl+j3C2WoEDN/LIKzAVi6n2VCwi6mPZhkmu1W4egvEo9kXJ+YIEikuvfc5B0ZzF9hEA==";
export const REGISTRY = "https://registry.npmjs.org/";
export const RUNTIME_DEPENDENCIES = Object.freeze({
	"dsh-univer-office": RUNTIME_VERSION,
	"@univer-cli/api-reference": "1.0.2",
	"@univer-cli/unit-screenshot": "1.0.2",
	"@univer-cli/unit-pdf-printer": "1.0.2",
	"@univer-cli/unit-layout-lint": "1.0.2",
	"@univer-cli/svg-facade": "1.0.2",
	"@univer-cli/resource-library": "1.0.2",
	"@univer-cli/univer-render-runtime": "1.0.2",
});
export const RUNTIME_ASSETS = Object.freeze({
	gateway: "artifacts/gateway.cjs",
	worker: "artifacts/unit-content-worker.mjs",
	viewer: "artifacts/viewer/index.html",
	render: "artifacts/render-machine/index.html",
});
const MANIFEST_NAME = "owl-univer-office-runtime";
const SNAPSHOT_FILE = "owl-univer-office-runtime.json";
const execFileAsync = promisify(execFile);

function directory(value, label, home, tilde = false) {
	if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f]/u.test(value)) {
		throw new Error(`${label} must be a non-empty directory path without surrounding whitespace or control characters.`);
	}
	if (tilde && (value === "~" || value.startsWith("~/") || value.startsWith("~\\"))) {
		value = join(home, value.slice(2));
	}
	if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
	const result = resolve(value);
	if (dirname(result) === result || result === resolve(home)) {
		throw new Error(`${label} must be a dedicated runtime directory, not a filesystem root or home directory.`);
	}
	return result;
}

export function resolveRuntimeTarget(options = {}) {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	if (options.target !== undefined) return directory(options.target, "--target", home);
	const agentDir = env.OWL_CODING_AGENT_DIR
		? directory(env.OWL_CODING_AGENT_DIR, "OWL_CODING_AGENT_DIR", home, true)
		: join(home, ".owl", "agent");
	return directory(join(agentDir, "cache", "univer-office", "runtime"), "Runtime cache", home);
}

export function runtimeAssetPaths(target) {
	const packageRoot = join(target, "node_modules", "dsh-univer-office");
	return {
		packageRoot,
		...Object.fromEntries(Object.entries(RUNTIME_ASSETS).map(([name, asset]) => [name, join(packageRoot, asset)])),
	};
}

async function json(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw new Error(`Cannot read JSON at ${path}: ${error.message}`, { cause: error });
	}
}

function matchesDependencies(dependencies) {
	return (
		dependencies !== null &&
		typeof dependencies === "object" &&
		Object.keys(dependencies).length === Object.keys(RUNTIME_DEPENDENCIES).length &&
		Object.entries(RUNTIME_DEPENDENCIES).every(([name, version]) => dependencies[name] === version)
	);
}

function validateManifest(manifest, target) {
	if (
		manifest.name !== MANIFEST_NAME ||
		manifest.private !== true ||
		!matchesDependencies(manifest.dependencies) ||
		manifest.scripts ||
		manifest.devDependencies ||
		manifest.workspaces
	) {
		throw new Error(`Refusing to modify an unmanaged or differently configured runtime package: ${target}`);
	}
}

export async function validateRuntime(target) {
	const paths = runtimeAssetPaths(target);
	for (const [name, version] of Object.entries(RUNTIME_DEPENDENCIES)) {
		const manifest = await json(join(target, "node_modules", ...name.split("/"), "package.json"));
		if (!manifest || manifest.name !== name || manifest.version !== version) {
			throw new Error(`Runtime package ${name}@${version} is missing or has the wrong version.`);
		}
	}
	const packageRoot = await realpath(paths.packageRoot);
	for (const [name, path] of Object.entries(paths)) {
		if (name === "packageRoot") continue;
		const actualPath = await realpath(path);
		const fromPackage = relative(packageRoot, actualPath);
		if (fromPackage === ".." || fromPackage.startsWith(`..${sep}`) || isAbsolute(fromPackage)) {
			throw new Error(`Runtime asset escapes its installed package: ${path}`);
		}
		if (!(await stat(actualPath)).isFile()) throw new Error(`Runtime asset is not a file: ${path}`);
	}
	const lock = await json(join(target, "package-lock.json"));
	const entry = lock?.packages?.["node_modules/dsh-univer-office"];
	if (
		!matchesDependencies(lock?.packages?.[""]?.dependencies) ||
		entry?.version !== RUNTIME_VERSION ||
		entry?.integrity !== RUNTIME_INTEGRITY ||
		entry?.resolved !== `${REGISTRY}dsh-univer-office/-/dsh-univer-office-${RUNTIME_VERSION}.tgz`
	) {
		throw new Error("Runtime package-lock.json does not match the pinned upstream snapshot.");
	}
	if (Object.keys(lock.packages).some((name) => name.startsWith("node_modules/@deepseek-ai/"))) {
		throw new Error("The runtime cache unexpectedly includes DSH host peer packages.");
	}
	return paths;
}

export function resolveNpmCli(env = process.env, nodeExecutable = process.execPath) {
	const candidates = [
		env.npm_execpath,
		join(dirname(nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js"),
		join(dirname(nodeExecutable), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		"/usr/share/nodejs/npm/bin/npm-cli.js",
		"/usr/lib/node_modules/npm/bin/npm-cli.js",
	];
	for (const pathDirectory of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
		candidates.push(join(pathDirectory, "node_modules", "npm", "bin", "npm-cli.js"));
		const npmExecutable = join(pathDirectory, "npm");
		if (existsSync(npmExecutable)) candidates.push(realpathSync(npmExecutable));
	}
	for (const candidate of candidates) {
		if (candidate && isAbsolute(candidate) && basename(candidate) === "npm-cli.js" && existsSync(candidate)) {
			return realpathSync(candidate);
		}
	}
	throw new Error("Cannot locate npm-cli.js beside Node.js or on PATH. Install Node.js with npm first.");
}

export function npmInstallArguments(npmCli) {
	return [
		npmCli,
		"install",
		"--ignore-scripts",
		"--legacy-peer-deps",
		"--omit=dev",
		"--workspaces=false",
		`--registry=${REGISTRY}`,
		"--no-audit",
		"--no-fund",
	];
}

async function upstreamMetadata() {
	const response = await fetch(`${REGISTRY}dsh-univer-office/${RUNTIME_VERSION}`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`npm registry metadata returned HTTP ${response.status}.`);
	return response.json();
}

export function validateUpstreamMetadata(metadata) {
	if (
		metadata.name !== "dsh-univer-office" ||
		metadata.version !== RUNTIME_VERSION ||
		metadata.gitHead !== RUNTIME_GIT_HEAD ||
		metadata.dist?.integrity !== RUNTIME_INTEGRITY ||
		metadata.dist?.tarball !== `${REGISTRY}dsh-univer-office/-/dsh-univer-office-${RUNTIME_VERSION}.tgz`
	) {
		throw new Error("npm registry metadata does not match the reviewed dsh-univer-office@0.3.6 snapshot.");
	}
}

async function runNpm(target, env) {
	const npmCli = resolveNpmCli(env);
	const result = await execFileAsync(process.execPath, npmInstallArguments(npmCli), {
		cwd: target,
		env: { ...env, npm_config_ignore_scripts: "true", npm_config_legacy_peer_deps: "true" },
		shell: false,
		windowsHide: true,
		timeout: 15 * 60_000,
		maxBuffer: 10 * 1024 * 1024,
	});
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
}

export async function installRuntime(options = {}) {
	const nodeVersion = (options.nodeVersion ?? process.versions.node).split(".").map(Number);
	if (nodeVersion[0] < 22 || (nodeVersion[0] === 22 && nodeVersion[1] < 19)) {
		throw new Error("The Univer runtime requires Node.js >=22.19.0.");
	}
	const env = options.env ?? process.env;
	const target = resolveRuntimeTarget(options);
	try {
		if ((await lstat(target)).isSymbolicLink()) throw new Error("The runtime target must not be a symbolic link.");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const manifestPath = join(target, "package.json");
	const manifest = await json(manifestPath);
	if (manifest) {
		validateManifest(manifest, target);
		try {
			const assets = await validateRuntime(target);
			return { target, assets, reused: true };
		} catch (error) {
			if (options.log) options.log(`The managed runtime needs hydration: ${error.message}`);
		}
	} else if (existsSync(target)) {
		// A user-provided directory must be empty before this installer owns it.
		if ((await readdir(target)).length) throw new Error(`Refusing to initialize a non-empty runtime target: ${target}`);
	}
	validateUpstreamMetadata(await (options.fetchMetadata ?? upstreamMetadata)());
	await mkdir(target, { recursive: true });
	const lockPath = join(target, ".install.lock");
	let lock;
	try {
		lock = await open(lockPath, "wx");
	} catch (error) {
		if (error.code === "EEXIST") throw new Error(`Another installation owns ${lockPath}; wait for it to finish.`);
		throw error;
	}
	try {
		if (!manifest) {
			await writeFile(
				manifestPath,
				`${JSON.stringify({ name: MANIFEST_NAME, private: true, type: "module", dependencies: RUNTIME_DEPENDENCIES }, null, 2)}\n`,
				{ flag: "wx" },
			);
		}
		await (options.runNpm ?? runNpm)(target, env);
		const assets = await validateRuntime(target);
		const snapshotPath = join(target, SNAPSHOT_FILE);
		if (!existsSync(snapshotPath)) {
			await writeFile(
				snapshotPath,
				`${JSON.stringify({ package: "dsh-univer-office", version: RUNTIME_VERSION, gitHead: RUNTIME_GIT_HEAD, integrity: RUNTIME_INTEGRITY, installedAt: new Date().toISOString() }, null, 2)}\n`,
				{ flag: "wx" },
			);
		}
		return { target, assets, reused: false };
	} finally {
		await lock.close();
		await unlink(lockPath);
	}
}

export function parseArguments(args) {
	if (args.length === 0) return {};
	if (args.length === 2 && args[0] === "--target") return { target: args[1] };
	throw new Error("Usage: node scripts/install-runtime.mjs [--target <absolute-directory>]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = await installRuntime({ ...parseArguments(process.argv.slice(2)), log: console.log });
		console.log(`Univer ${RUNTIME_VERSION} runtime ${result.reused ? "reused" : "installed"}: ${result.target}`);
	} catch (error) {
		console.error(error.message);
		if (error.stderr) process.stderr.write(error.stderr);
		process.exitCode = 1;
	}
}
