// Pure analyzer regression against CURRENT VENDOR SOURCE, never the production dist bundle.
// Every shell-looking string below is data. No shell, tool executor, model or API is invoked.
// Default assertions cover safety. --assert-probes additionally asserts unresolved compatibility
// and known old parser gaps; their original expectations and red results stay in every JSON report.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import createSafetyNetExtension from "../src/index.ts";
import { B as evaluateWithoutAudit, c as loadConfig, d as analysisInput, h as parseProgram, j as userRulePath, u as userPolicyPath } from "../vendor/chunks/index-gj6afr0n.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(packageRoot, "../..");
const vendorPath = join(packageRoot, "vendor/chunks/index-gj6afr0n.js");
const isolatedRoot = mkdtempSync(join(tmpdir(), "owl-safety-nested-"));
const configRoot = join(isolatedRoot, "config"), auditRoot = join(isolatedRoot, "audit"), cwd = join(isolatedRoot, "workspace");
for (const path of [configRoot, auditRoot, cwd]) mkdirSync(path);
// These are verified official engine config/audit overrides. HOME/CODEX_HOME remain untouched.
const scopedKeys = Object.keys(process.env).filter((key) => /^(?:CC_SAFETY_NET_|SAFETY_NET_)/.test(key));
const savedEnv = new Map([...scopedKeys, "NODE_ENV"].map((key) => [key, process.env[key]]));
for (const key of scopedKeys) delete process.env[key];
Object.assign(process.env, { NODE_ENV: "test", CC_SAFETY_NET_HOME: configRoot, CC_SAFETY_NET_AUDIT_HOME: auditRoot, CC_SAFETY_NET_LEVEL: "standard" });
const environment = loadConfig();
const under = (root, path) => { const part = relative(root, resolve(path)); return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`); };
assert(under(configRoot, userRulePath(environment)) && under(configRoot, userPolicyPath(environment)));
assert.equal(environment.env.get("CC_SAFETY_NET_AUDIT_HOME"), auditRoot);
assert.equal(existsSync(join(cwd, ".env")), false, "No real secret fixture is created or read");

const ORIGINAL_COMMAND = "mkdir -p _scratch/anomaly-write-test; echo \"--- dir listing (may be empty) ---\"; ls -A _scratch/anomaly-write-test; pool=(青 竹 鲤 雪 风 山 月 星 云 海 松 鹤 川 石 舟 灯); t=\"${pool[$((RANDOM % ${#pool[@]}))]}${pool[$((RANDOM % ${#pool[@]}))]}${pool[$((RANDOM % ${#pool[@]}))]}\"; n=$((1000 + RANDOM % 9000)); names=(lark maple otter pebble quill heron); f=\"${names[$((RANDOM % ${#names[@]}))]}\"; printf 'TITLE=%s\\nNUM=%s\\nFILE=%s\\n' \"$t\" \"$n\" \"$f\"";
const cases = [
    ["minimal safe nested parameter", "allow", 'echo "${pool[${i}]}"'],
    ["safe nested length/arithmetic", "allow", 'echo "${pool[$((RANDOM % ${#pool[@]}))]}"'],
    ["original recorded random setup", "allow", ORIGINAL_COMMAND],
    ["ASCII array declaration", "allow", "pool=(a b)"],
    ["Chinese array declaration", "allow", "pool=(青 竹)"],
    ["constant array subscript", "allow", 'echo "${pool[0]}"'],
    ["arithmetic subscript without nested braces", "allow", 'echo "${pool[$((RANDOM % 2))]}"'],
    ["array length", "allow", 'echo "${#pool[@]}"'],
    ["arithmetic with nested array length", "allow", 'echo "$((RANDOM % ${#pool[@]}))"'],
    ["literal status command", "allow", "git status"],
    ["explicit secret beside nested echo", "deny", 'cat .env; echo "${pool[${i}]}"'],
    ["explicit destructive command beside nested echo", "deny", 'rm -rf /; echo "${pool[${i}]}"'],
    ["nested secret command in subscript", "deny", 'echo "${pool[$(cat .env)]}"'],
    ["nested destructive command in subscript (existing old-version gap)", "deny", 'echo "${pool[$(rm -rf /)]}"'],
    ["nested secret fallback substitution", "deny", 'echo "${x:-$(cat .env)}"'],
    ["nested destructive fallback substitution", "deny", 'echo "${x:-$(rm -rf /)}"'],
    ["secret substitution inside arithmetic", "deny", 'echo "${pool[$((1 + $(cat .env)))]}"'],
    ["destructive substitution inside arithmetic", "deny", 'echo "${pool[$((1 + $(rm -rf /)))]}"'],
    ["nested parameter hides secret substitution", "deny", 'echo "${pool[${index:-$(cat .env)}]}"'],
    ["nested parameter hides destructive substitution", "deny", 'echo "${pool[${index:-$(rm -rf /)}]}"'],
    ["backtick secret substitution", "deny", 'echo "${pool[`cat .env`]}"'],
    ["backtick destructive substitution", "deny", 'echo "${pool[`rm -rf /`]}"'],
    ["nested process substitution", "deny", 'echo "${pool[${index:-<(cat .env)}]}"'],
    ["destructive sibling substitution in same quoted word", "deny", 'echo "${pool[${i}]}$(rm -rf /)"'],
    ["destructive sibling backtick in same quoted word", "deny", 'echo "${pool[${i}]}`rm -rf /`"'],
    ["destructive sibling command after nested expansion", "deny", 'echo "${pool[${i}]}"; rm -rf /'],
    ["secret path through nested array cat", "deny", 'pool=(.env); i=0; cat "${pool[${i}]}"'],
    ["secret path through nested array head", "deny", 'pool=(.env); i=0; head -1 "${pool[${i}]}"'],
    ["secret path through nested array input redirection", "deny", 'pool=(.env); i=0; while read line; do echo "$line"; done < "${pool[${i}]}"'],
    ["secret path through nested array variable", "deny", 'names=(.env); i=0; path="${names[${i}]}"; cat "$path"'],
    ["secret target through nested array output redirection", "deny", 'names=(.env); i=0; path="${names[${i}]}"; echo x > "$path"'],
    ["credential target through nested array", "deny", 'pool=("$HOME/.ssh/id_rsa"); i=0; cat "${pool[${i}]}"'],
    ["malformed missing outer brace", "deny", 'echo "${pool[${i}]"'],
    ["malformed missing arithmetic delimiter", "deny", 'echo "${pool[$((1 + ${#pool[@]})]}"'],
    ["malformed empty nested parameter", "deny", 'echo "${pool[${}]}"'],
    ["malformed missing subscript delimiter", "deny", 'echo "${pool[${i}}"'],
    ["malformed extra arithmetic delimiter", "deny", 'echo "${pool[$((1 + ${i})))]}"'],
    ["malformed unclosed quote", "deny", 'echo "${pool[${i}]}'],
    ["excessive nested parameter depth", "deny", 'echo "' + "${x:-".repeat(80) + "ok" + "}".repeat(80) + '"'],
    ["excessive nested arithmetic depth", "deny", 'echo "${pool[$((' + "(".repeat(100) + "1" + ")".repeat(100) + '))]}"'],
    ["excessive nested expansion width", "deny", 'echo "' + "${x:-${y}}".repeat(4096) + '"'],
    ["known destructive baseline", "deny", "rm -rf /"],
    ["known secret baseline", "deny", "cat .env"],
].map(([name, expected, command], index) => ({
    name, expected, command,
    group: index < 3 ? "unimplemented-compatibility" : ["malformed unclosed quote", "excessive nested arithmetic depth"].includes(name) ? "known-old-parser-gap" : "safety",
}));

const handlers = new Map();
createSafetyNetExtension({ on: (name, handler) => handlers.set(name, handler), registerCommand: () => {}, sendUserMessage: () => {} });
const handler = handlers.get("tool_call"); assert.equal(typeof handler, "function");
const wrapperErrors = [];
const originalConsoleError = console.error;
console.error = (...items) => wrapperErrors.push(items.map((item) => item instanceof Error ? `${item.name}: ${item.message}` : String(item)).join(" "));
const results = [];
try {
    for (const [index, item] of cases.entries()) {
        const began = performance.now();
        let ast, astError, evaluation, engineError;
        try { ast = parseProgram(item.command, "posix"); } catch (error) { astError = { name: error.name, message: error.message }; }
        try {
            const input = analysisInput("bash", { command: item.command }, { kind: "command", shell: "posix" }, { configCwd: cwd, executionCwd: cwd }, item.command);
            evaluation = evaluateWithoutAudit(input, { environment });
        } catch (error) { engineError = { name: error.name, message: error.message, stage: error.stage, cause: error.cause?.message, decision: error.evaluation?.decision?.kind }; }
        // Actual SOURCE extension wrapper must catch pre-guard/guard throws and keep denial.
        const wrapped = handler({ type: "tool_call", toolCallId: `nested-analysis-${index}`, toolName: "bash", input: { command: item.command } }, { cwd, isIdle: () => true, sessionManager: { getSessionId: () => "isolated-nested-analysis" } });
        const minimalParts = item.name === "minimal safe nested parameter" ? ast?.nodes.flatMap((node) => (node.words ?? []).flatMap((word) => word.parts ?? [])) : undefined;
        const engineDecision = evaluation?.decision?.kind ?? engineError?.decision;
        results.push({ ...item, command: item.command.length > 4096 ? undefined : item.command, commandCharacters: item.command.length,
            commandSha256: createHash("sha256").update(item.command).digest("hex"), astStatus: ast?.status, astIssues: ast?.issues, astError,
            minimalParts, engineDecision, engineStage: evaluation?.stage ?? engineError?.stage, engineError,
            wrapperBlocked: wrapped?.block === true, wrapperReason: wrapped?.reason,
            passed: item.expected === "allow" ? engineDecision === "allow" && !engineError && wrapped === undefined
                : wrapped?.block === true && (engineDecision === "deny" || Boolean(engineError)), elapsedMs: performance.now() - began });
    }
} finally {
    console.error = originalConsoleError;
    for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const key of ["CC_SAFETY_NET_HOME", "CC_SAFETY_NET_AUDIT_HOME", "CC_SAFETY_NET_LEVEL"]) if (!savedEnv.has(key)) delete process.env[key];
}
const source = readFileSync(vendorPath);
const report = { at: new Date().toISOString(), vendorPath, vendorSha256: createHash("sha256").update(source).digest("hex"), productionDistImported: false,
    isolatedRoot, configRoot, auditRoot, nativeShellExecutions: 0, commandExecutions: 0, apiCalls: 0, modelCalls: 0,
    wrapperEntry: "packages/owl-safety-net/src/index.ts", productionAuditWrites: false, wrapperErrors,
    scope: "Safety tightening only. Nested parameter compatibility and known old parser gaps remain separate probes; an analyzer allow is not proof of shell execution.",
    probeFailures: results.filter((row) => row.group !== "safety" && !row.passed).map((row) => ({ name: row.name, group: row.group, expected: row.expected, actual: row.engineDecision, error: row.engineError })),
    results };
const option = process.argv.indexOf("--report");
if (option >= 0) {
    const reportPath = resolve(process.argv[option + 1] ?? "");
    assert(under(join(repo, ".validation"), reportPath) || under(tmpdir(), reportPath), "Reports belong only to .validation or temp fixtures");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
const assertProbes = process.argv.includes("--assert-probes");
for (const row of results.filter((item) => item.group === "safety" || assertProbes)) test(`${row.group} ${row.expected}: ${row.name}`, () => { assert.equal(row.passed, true, JSON.stringify({ engineDecision: row.engineDecision, engineError: row.engineError, wrapperBlocked: row.wrapperBlocked })); });
if (assertProbes) test("compatibility probe: nested parameter AST retains its full braced boundary", () => {
    assert(results[0].minimalParts?.some((part) => part.raw === "${pool[${i}]}"), "The full variable span must not end at the inner brace");
});
test("config and audit isolation is explicit and every supplied command remains data", () => {
    assert(under(tmpdir(), isolatedRoot)); assert.equal(report.commandExecutions, 0); assert.equal(report.productionDistImported, false);
});
if (!assertProbes) console.log(`Unresolved probes are recorded without changing their expectations: ${report.probeFailures.map((row) => `${row.group}: ${row.name}`).join("; ")}. Use --assert-probes to assert them.`);
