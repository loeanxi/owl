import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const playChime = vi.fn();

// 只替换 playChime，其余导出（isNotificationSound 等）保留真实实现供 notification-prefs 使用。
vi.mock("./sound.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sound.ts")>();
	return { ...actual, playChime: (...args: unknown[]) => playChime(...args) };
});

beforeEach(() => {
	// 冷却判断走 Date.now，显式连同 Date 一起伪时钟；冷却表是模块级状态，重置模块拿到干净一份
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	playChime.mockClear();
	vi.resetModules();
});

afterEach(() => {
	vi.useRealTimers();
});

async function load(): Promise<typeof import("./notification.ts")> {
	const prefs = await import("./notification-prefs.ts");
	prefs.setNotificationPrefs({ ...prefs.DEFAULT_NOTIFICATION_PREFS });
	return await import("./notification.ts");
}

describe("notifyAgentStatus chime cooldown", () => {
	it("plays one chime per category within the cooldown window", async () => {
		const { notifyAgentStatus } = await load();
		await notifyAgentStatus({ title: "a", category: "permission", critical: true });
		await notifyAgentStatus({ title: "b", category: "permission", critical: true });
		expect(playChime).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1600);
		await notifyAgentStatus({ title: "c", category: "permission", critical: true });
		expect(playChime).toHaveBeenCalledTimes(2);
	});

	it("keeps separate cooldowns per category and respects the sound switch", async () => {
		const { notifyAgentStatus } = await load();
		await notifyAgentStatus({ title: "a", category: "permission", critical: true });
		await notifyAgentStatus({ title: "b", category: "done", critical: false });
		expect(playChime).toHaveBeenCalledTimes(2);
		const prefs = await import("./notification-prefs.ts");
		prefs.setNotificationPrefs({ ...prefs.DEFAULT_NOTIFICATION_PREFS, sound: false });
		await notifyAgentStatus({ title: "c", category: "question", critical: true });
		expect(playChime).toHaveBeenCalledTimes(2);
	});
});
