import { describe, expect, it } from "vitest";
import { outputOf, readInput, responseObject, toChat } from "../src/gateway/responses.ts";

describe("responses protocol", () => {
	it("turns a text input into a chat completion and back into a response", () => {
		const chat = toChat({ model: "demo", input: "你好", instructions: "简短回答" }, []);
		expect(chat.messages).toEqual([
			{ role: "system", content: "简短回答" },
			{ role: "user", content: "你好" },
		]);
		const output = outputOf({
			choices: [{ message: { role: "assistant", content: "在的" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
		});
		const response = responseObject("resp_1", 1, "demo", output, { store: true }, "completed", [3, 1, 4]);
		expect(response.object).toBe("response");
		expect(response.output).toEqual([expect.objectContaining({ type: "message", role: "assistant" })]);
		expect(readInput(response.output)).toEqual([expect.objectContaining({ role: "assistant" })]);
	});

	it("rejects background jobs", () => {
		expect(() => toChat({ model: "demo", input: "hi", background: true }, [])).toThrow(/尚未支持/);
	});
});
