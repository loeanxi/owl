#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = "6.4.0";
const integrity = "sha512-Vj1zWfSlna5bphGoaoI/TcVBuYvze9u+OyPC3Shz8YkBqaCTqB4COnnRoX7XDwMpwI24ZlFEel2yEj0k8LTWEQ==";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeName = "owl-research-rea-runtime";
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (!((nodeMajor === 22 && nodeMinor >= 19) || (nodeMajor === 24 && nodeMinor >= 11) || nodeMajor >= 26)) {
	throw new Error("REA 6.4.0 requires Node 22.19+, Node 24.11+, or Node 26+");
}
if (process.platform === "win32" && process.arch !== "x64")
	throw new Error("REA Windows Ghidra requires a Windows x64 Node runtime");
const options = {};
for (let index = 2; index < process.argv.length; index++) {
	const argument = process.argv[index];
	if (argument === "--check" || argument === "--doctor") {
		options[argument.slice(2)] = true;
	} else if (["--tool-dir", "--ghidra-home", "--java-home", "--registry", "--npm-cli"].includes(argument)) {
		const value = process.argv[++index];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
		options[argument.slice(2)] = value;
	} else if (argument === "--help") {
		console.log(
			"Usage: node scripts/setup-research-rea.mjs [--check] [--doctor] [--tool-dir PATH] [--ghidra-home PATH] [--java-home PATH] [--registry URL] [--npm-cli PATH]",
		);
		process.exit(0);
	} else {
		throw new Error(`Unknown argument: ${argument}`);
	}
}

const agentDir = resolve(process.env.OWL_CODING_AGENT_DIR || join(repoRoot, "..", "data", "owl"));
const toolDir = resolve(options["tool-dir"] || join(agentDir, "tools", "research-rea"));
const nativeConfigPath = join(agentDir, "tools", "research-decompilers", "native-toolchain.json");
const nativeConfig = existsSync(nativeConfigPath) ? JSON.parse(readFileSync(nativeConfigPath, "utf8")) : {};
const ghidraHome = options["ghidra-home"] || nativeConfig.ghidraHome;
const javaHome = options["java-home"] || nativeConfig.javaHome;
for (const [name, path] of [
	["Ghidra", ghidraHome],
	["JDK", javaHome],
]) {
	if (typeof path !== "string" || !isAbsolute(path))
		throw new Error(
			`${name} requires an existing absolute path; configure ${nativeConfigPath} or pass its path explicitly`,
		);
}
if (!existsSync(join(ghidraHome, "Ghidra", "application.properties")))
	throw new Error(`Ghidra installation missing: ${ghidraHome}`);
for (const command of ["java", "javac"]) {
	const file = join(javaHome, "bin", `${command}${process.platform === "win32" ? ".exe" : ""}`);
	if (!existsSync(file)) throw new Error(`Full JDK command missing: ${file}`);
}

const manifestPath = join(toolDir, "package.json");
const lockPath = join(toolDir, "package-lock.json");
function verifyLock() {
	if (!existsSync(lockPath)) throw new Error(`Lockfile missing: ${lockPath}`);
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	const entry = lock.packages?.["node_modules/rea-agents"];
	if (entry?.version !== version || entry.integrity !== integrity)
		throw new Error("REA lockfile does not match the reviewed 6.4.0 package integrity");
}

if (!options.check) {
	mkdirSync(toolDir, { recursive: true });
	if (existsSync(manifestPath)) {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (manifest.name !== runtimeName || manifest.dependencies?.["rea-agents"] !== version)
			throw new Error(`Refusing to overwrite another runtime manifest: ${manifestPath}`);
	} else {
		writeFileSync(
			manifestPath,
			`${JSON.stringify({ name: runtimeName, private: true, version: "1.0.0", dependencies: { "rea-agents": version } }, null, "\t")}\n`,
		);
	}
	const npmCli = [
		options["npm-cli"],
		process.env.npm_execpath,
		join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
		join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
	].find((path) => typeof path === "string" && existsSync(path));
	if (!npmCli) throw new Error("npm CLI not found beside Node; pass --npm-cli /absolute/path/npm-cli.js");
	const registry = options.registry || "https://registry.npmjs.org";
	const installArgs = existsSync(lockPath) ? ["ci"] : ["install", "--save-exact", `rea-agents@${version}`];
	if (existsSync(lockPath)) verifyLock();
	console.log(`Installing rea-agents@${version} in ${toolDir} with lifecycle scripts disabled`);
	const result = spawnSync(
		process.execPath,
		[
			npmCli,
			...installArgs,
			"--prefix",
			toolDir,
			"--ignore-scripts",
			"--omit=dev",
			"--no-audit",
			"--no-fund",
			`--registry=${registry}`,
		],
		{ cwd: toolDir, stdio: "inherit", timeout: 300_000, windowsHide: true },
	);
	if (result.status !== 0)
		throw new Error(`Isolated npm installation failed: ${result.error?.message || result.status}`);
}

verifyLock();
const packageRoot = join(toolDir, "node_modules", "rea-agents");
const installed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (installed.version !== version) throw new Error(`Unexpected installed REA version: ${installed.version}`);
for (const file of [
	"scripts/rea.mjs",
	"dist/main.js",
	"bridge/ghidra/ReaGhidraBridge.java",
	...(process.platform === "win32"
		? ["native/windows/build/manifest.json", "native/windows/build/rea-windows-x64.node"]
		: []),
]) {
	if (!existsSync(join(packageRoot, file))) throw new Error(`Published runtime artifact missing: ${file}`);
}
const config = { version, packageRoot, nodePath: process.execPath, ghidraHome, javaHome };
const configPath = join(toolDir, "rea-toolchain.json");
if (!options.check) {
	const temporaryPath = `${configPath}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, "\t")}\n`);
	renameSync(temporaryPath, configPath);
} else {
	const recorded = JSON.parse(readFileSync(configPath, "utf8"));
	for (const key of Object.keys(config)) {
		if (recorded[key] !== config[key])
			throw new Error(`Recorded runtime configuration differs at ${key}: ${configPath}`);
	}
}

if (options.doctor) {
	const diagnosticsDir = join(toolDir, "diagnostics");
	const isolatedHome = join(diagnosticsDir, "doctor-home");
	mkdirSync(isolatedHome, { recursive: true });
	const environment = {
		PATH: process.env.PATH,
		GHIDRA_INSTALL_DIR: ghidraHome,
		JAVA_HOME: javaHome,
		REA_ANALYSIS_PROVIDER: "ghidra",
		HOME: isolatedHome,
		USERPROFILE: isolatedHome,
		APPDATA: isolatedHome,
		LOCALAPPDATA: isolatedHome,
		XDG_CONFIG_HOME: isolatedHome,
		XDG_CACHE_HOME: isolatedHome,
		TMP: isolatedHome,
		TEMP: isolatedHome,
	};
	for (const key of [
		"SystemRoot",
		"SYSTEMROOT",
		"WINDIR",
		"COMSPEC",
		"PATHEXT",
		"ProgramFiles",
		"ProgramFiles(x86)",
	]) {
		if (process.env[key]) environment[key] = process.env[key];
	}
	const result = spawnSync(
		process.execPath,
		[join(packageRoot, "scripts", "rea.mjs"), "doctor", "--provider", "ghidra", "--json"],
		{
			cwd: toolDir,
			env: environment,
			encoding: "utf8",
			timeout: 60_000,
			maxBuffer: 8 * 1024 * 1024,
			windowsHide: true,
		},
	);
	writeFileSync(join(diagnosticsDir, "doctor-ghidra.json"), result.stdout || "");
	writeFileSync(join(diagnosticsDir, "doctor-ghidra.stderr.log"), result.stderr || "");
	if (result.status !== 0)
		throw new Error(`Ghidra doctor failed (${result.error?.message || result.status}); inspect ${diagnosticsDir}`);
	console.log(`Ghidra doctor passed; diagnostics: ${diagnosticsDir}`);
}
console.log(`REA runtime configured: ${configPath}`);
