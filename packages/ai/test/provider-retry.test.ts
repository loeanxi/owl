import { afterEach, describe, expect, it, vi } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries retryable provider errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it.each([429, 500])("does not retry a %s gateway quota error with an opaque SDK message", async (status) => {
		const error = Object.assign(providerError(status), {
			error: { code: "insufficient_quota", message: "account limit reached" },
		});
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("does not replay a controlled unknown-billing HTTP504", async () => {
		const error = Object.assign(providerError(504), {
			error: { code: "upstream_stream_interrupted", billing_state: "unknown", message: "terminated" },
		});
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);
		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("preserves an explicit provider retry header override", async () => {
		const error = Object.assign(providerError(504, { "x-should-retry": "true", "retry-after-ms": "0" }), {
			error: { code: "upstream_stream_interrupted", billing_state: "unknown", message: "terminated" },
		});
		const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValue("explicit retry");
		await expect(retryProviderRequest(request, { maxRetries: 1 })).resolves.toBe("explicit retry");
		expect(request).toHaveBeenCalledTimes(2);
	});
	it("a non-allowlisted code with metadata remains an ordinary transient failure", async () => {
		const error = Object.assign(providerError(503, { "retry-after-ms": "0" }), {
			error: { code: "service_unavailable", billing_state: "unknown", message: "server busy" },
		});
		const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValue("recovered");
		await expect(retryProviderRequest(request, { maxRetries: 1 })).resolves.toBe("recovered");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
