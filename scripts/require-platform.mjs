#!/usr/bin/env node

/**
 * 平台闸门：某些 workspace 的测试只能在特定操作系统上跑，跨平台时显式跳过并说明原因。
 *
 * 为什么要它：根 `npm test` 是 `npm run test --workspaces --if-present`，它不区分平台，
 * 会把每个有 test script 的包都跑一遍。apps/desktop 是 Windows-only 产物（11 个测试
 * 硬编码 D:\ / C:\ 路径断言），在 Linux 上跑必然失败，只能由 CI 的 windows job 覆盖。
 *
 * 用法：
 *   node scripts/require-platform.mjs win32
 *
 * 平台不匹配时打印原因并以 0 退出——这是「此处不适用」，不是失败。
 * 需要无视平台强制跑（例如调试跨平台问题时）：直接跑 run-mixed-tests.mjs，
 * 或用 apps/desktop 的 `npm run test:all-platforms`。
 */

import process from "node:process";

const EXPECTED_PLATFORM = "win32";
const WORKSPACE = "@owl/desktop";

const expectedLabel = EXPECTED_PLATFORM === "win32" ? "Windows" : EXPECTED_PLATFORM;

if (process.platform === EXPECTED_PLATFORM) process.exit(0);

process.stdout.write(
	`[require-platform] 跳过 ${WORKSPACE} 的测试：它是 ${expectedLabel}-only 产物` +
		`（当前 ${process.platform}），由 CI 的 windows job 覆盖。\n`,
);
process.exit(0);