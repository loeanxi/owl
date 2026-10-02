// ZCode Stop hook：每轮工作结束（即写完一个新功能/一次改造）后自动 git 提交。
// 约定：绝不向 stdout 输出（钩子 stdout 会被按严格 JSON 解析），永远 exit 0，
// 诊断信息写入同目录 auto-commit.log（已被仓库 .gitignore 的 *.log 覆盖）。
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));

function log(msg) {
	try {
		appendFileSync(join(HOOK_DIR, "auto-commit.log"), `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// 日志失败不影响主流程
	}
}

function git(repo, args) {
	const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
	if (r.error) throw r.error;
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} 失败(exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
	}
	return (r.stdout ?? "").trim();
}

function readStdinPayload() {
	if (process.stdin.isTTY) return {};
	try {
		const raw = readFileSync(0, "utf8").trim();
		if (!raw) return {};
		return JSON.parse(raw);
	} catch {
		return {}; // payload 解析失败只影响提交信息来源，不应中断
	}
}

// 从会话 transcript(JSONL) 末尾找最后一条 assistant 文本，作为提交主题
function extractLastAssistantText(transcriptPath) {
	if (!transcriptPath) return "";
	let raw;
	try {
		raw = readFileSync(transcriptPath, "utf8");
	} catch {
		return "";
	}
	const lines = raw.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (obj?.type && obj.type !== "assistant") continue;
		const msg = obj?.message ?? obj;
		if (msg?.role && msg.role !== "assistant") continue;
		const content = msg?.content;
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.filter((b) => b?.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join(" ");
		}
		text = text.trim();
		if (text) return text;
	}
	return "";
}

function toSubject(text) {
	let line =
		text
			.split("\n")
			.map((s) => s.trim())
			.find(Boolean) ?? "";
	line = line
		.replace(/^[#>*\-\s`]+/, "")
		.replace(/[`*]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const cps = Array.from(line);
	if (cps.length > 72) return cps.slice(0, 71).join("") + "…";
	return line;
}

function main() {
	const payload = readStdinPayload();

	// 定位仓库：优先 ${ZCODE_PROJECT_DIR}（作为 argv[2] 传入），其次 cwd 向上找
	const candidates = [process.argv[2], payload.cwd, process.cwd()].filter(Boolean);
	let repo = null;
	for (const dir of candidates) {
		try {
			repo = git(dir, ["rev-parse", "--show-toplevel"]);
			break;
		} catch {
			// 该目录不在 git 仓库内，尝试下一个
		}
	}
	if (!repo) {
		log("skip: 未找到 git 仓库");
		return;
	}

	// 处于合并/变基等中间状态时不提交
	const gitDirOut = git(repo, ["rev-parse", "--git-dir"]);
	const gitDir = isAbsolute(gitDirOut) ? gitDirOut : resolve(repo, gitDirOut);
	for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
		if (existsSync(join(gitDir, marker))) {
			log(`skip: 处于中间状态 ${marker}，不自动提交`);
			return;
		}
	}

	// detached HEAD 下的提交会悬空，跳过
	const branch = spawnSync("git", ["-C", repo, "symbolic-ref", "--short", "-q", "HEAD"], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (branch.status !== 0 || !(branch.stdout ?? "").trim()) {
		log("skip: detached HEAD，不自动提交");
		return;
	}

	const status = git(repo, ["status", "--porcelain"]);
	if (!status) {
		log("skip: 工作区干净，无需提交");
		return;
	}
	const fileCount = status.split("\n").filter(Boolean).length;

	git(repo, ["add", "-A"]);

	// 全部被 .gitignore 吸收等极端情况下不产生空提交
	const staged = spawnSync("git", ["-C", repo, "diff", "--cached", "--quiet"], {
		windowsHide: true,
	});
	if (staged.status === 0) {
		log("skip: 暂存区为空，无需提交");
		return;
	}

	const subject =
		toSubject(extractLastAssistantText(payload.transcript_path)) ||
		`owl: 完成新功能后自动提交（${fileCount} 个文件）`;

	const statLines = git(repo, ["diff", "--cached", "--stat"]).split("\n");
	const stat = statLines.slice(0, 15).join("\n") + (statLines.length > 15 ? "\n…" : "");
	const body = `${stat}\n\n🤖 由 ZCode Stop 钩子自动提交（完成一个功能即提交）`;

	git(repo, ["commit", "--no-verify", "-m", subject, "-m", body]);
	log(`committed [${(branch.stdout ?? "").trim()}]: ${subject}`);
}

try {
	main();
} catch (e) {
	log(`error: ${e?.message ?? e}`);
}
process.exit(0);
