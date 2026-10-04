// 测试全局隔离：把 agent 目录指向本测试文件专属的临时目录。
//
// 背景：SessionManager.create(cwd) 这类不传 sessionDir 的调用会把缺省会话目录
// 解析到 <getDefaultAgentDir()>/Owl-history/<编码cwd>/。当测试进程继承了
// OWL_CODING_AGENT_DIR（例如从 Owl 桌面端会话里跑测试）时，测试会话就会写进
// 真实数据目录的 Owl-history，并在桌面端侧边栏里显示成一堆 pi-runtime-* 项目
// （2026-10-04 曾在 D:\owl\owl-re-v1\data\owl\Owl-history 下积压 66 个垃圾目录）。
//
// setupFiles 在每个测试文件的模块加载前运行，getAgentDir() 每次调用都会重读
// 环境变量，因此这里赋值即可全局生效。测试文件自己的 afterAll 先于本文件的
// afterAll 执行（后注册先执行），清理顺序安全。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const tempAgentDir = mkdtempSync(join(tmpdir(), "owl-test-agent-"));

// ENV_AGENT_DIR（即 OWL_CODING_AGENT_DIR）覆盖本项目；
// PI_CODING_AGENT_DIR 兜底上游 pi 血统代码里对 PI_ 前缀变量的引用。
process.env[ENV_AGENT_DIR] = tempAgentDir;
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

afterAll(() => {
	try {
		rmSync(tempAgentDir, { recursive: true, force: true });
	} catch {
		// 清理失败不影响测试结果；临时目录在系统 temp 下可被系统回收
	}
});
