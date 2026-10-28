import { describe, expect, it, vi } from "vitest";
import { PendingResponses } from "./pending-responses.ts";

describe("acknowledged pending responses", () => {
	it("retains business failures, blocks same-tick duplicates and retries the exact action", async () => {
		const controller = new PendingResponses();
		const first = Promise.withResolvers<{ ok: boolean; error?: string }>();
		const respond = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ok: true });
		const confirmed = vi.fn();
		const action = { requestId: "request", sessionId: "session", respond, confirmed };
		const submitting = controller.submit(action);
		expect(await controller.submit(action)).toBe(false);
		expect(respond).toHaveBeenCalledOnce();
		expect(controller.getSnapshot().get("request")?.phase).toBe("pending");
		first.resolve({ ok: false, error: "business rejected" });
		expect(await submitting).toBe(false);
		expect(confirmed).not.toHaveBeenCalled();
		expect(controller.getSnapshot().get("request")).toEqual({ phase: "error", error: "business rejected" });
		controller.retry("request");
		await vi.waitFor(() => expect(confirmed).toHaveBeenCalledOnce());
		expect(respond).toHaveBeenCalledTimes(2);
		expect(controller.getSnapshot().size).toBe(0);
	});

	it.each(["request", "session"] as const)(
		"discards a late transport failure after a terminal %s event",
		async (scope) => {
			const controller = new PendingResponses();
			const response = Promise.withResolvers<{ ok: boolean }>();
			const confirmed = vi.fn();
			const request = controller.submit({
				requestId: "one",
				sessionId: "session",
				respond: () => response.promise,
				confirmed,
			});
			if (scope === "request") controller.retire("one");
			else controller.retireSession("session", ["one"]);
			response.reject(new Error("late offline"));
			await request;
			expect(controller.getSnapshot().size).toBe(0);
			expect(confirmed).not.toHaveBeenCalled();
			controller.retry("one");
			expect(controller.getSnapshot().size).toBe(0);
		},
	);

	it("does not clear another request when one of several requests is resolved", async () => {
		const controller = new PendingResponses();
		await controller.submit({
			requestId: "other",
			sessionId: "b",
			respond: async () => ({ ok: false, error: "keep me" }),
			confirmed: vi.fn(),
		});
		controller.retireSession("a", ["one"]);
		expect(controller.getSnapshot().get("other")?.error).toBe("keep me");
	});

	it("cannot publish old failures after invalidating a profile and erases its question drafts", async () => {
		const controller = new PendingResponses();
		controller.saveQuestionDraft("one", { states: [], current: 1, missing: new Set(), collapsed: false });
		const response = Promise.withResolvers<{ ok: boolean }>();
		const request = controller.submit({
			requestId: "one",
			sessionId: "a",
			respond: () => response.promise,
			confirmed: vi.fn(),
		});
		controller.invalidate();
		response.reject(new Error("old account"));
		await request;
		expect(controller.questionDrafts.size).toBe(0);
		expect(controller.getSnapshot().size).toBe(0);
	});

	it("an old attempt's finally cannot unlock a new attempt after scope activation", async () => {
		const controller = new PendingResponses();
		const old = Promise.withResolvers<{ ok: boolean }>();
		const next = Promise.withResolvers<{ ok: boolean }>();
		const oldRequest = controller.submit({
			requestId: "same",
			sessionId: "a",
			respond: () => old.promise,
			confirmed: vi.fn(),
		});
		controller.invalidate();
		controller.activate();
		const respond = vi.fn(() => next.promise);
		const action = { requestId: "same", sessionId: "b", respond, confirmed: vi.fn() };
		const newRequest = controller.submit(action);
		old.resolve({ ok: true });
		await oldRequest;
		expect(await controller.submit(action)).toBe(false);
		expect(respond).toHaveBeenCalledOnce();
		next.resolve({ ok: true });
		await newRequest;
	});
});
