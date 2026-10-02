import { describe, expect, test } from "vitest";
import { createTodoToolDefinition } from "../src/core/tools/todo.ts";

function makeDefinition() {
	return createTodoToolDefinition("/workspace");
}

async function run(definition: ReturnType<typeof makeDefinition>, input: unknown) {
	return definition.execute("test-call", input as never, undefined, undefined, {} as never);
}

describe("todo tool", () => {
	test("omitting todos reads the current list without changing it", async () => {
		const definition = makeDefinition();
		await run(definition, {
			todos: [{ content: "first task", status: "completed" }, { content: "second task" }],
		});

		const result = await run(definition, {});
		expect(result.details.updated).toBe(false);
		expect(result.details.todos).toHaveLength(2);
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0] && "text" in result.content[0] ? result.content[0].text : "").toContain("first task");
	});

	test("replaces the whole list on write and applies defaults", async () => {
		const definition = makeDefinition();
		const result = await run(definition, { todos: [{ content: "a" }, { content: "b", priority: "high" }] });

		expect(result.details.updated).toBe(true);
		expect(result.details.todos).toEqual([
			{ content: "a", status: "pending", priority: "medium" },
			{ content: "b", status: "pending", priority: "high" },
		]);
	});

	test("demotes extra in_progress tasks and reports a note", async () => {
		const definition = makeDefinition();
		const result = await run(definition, {
			todos: [
				{ content: "a", status: "in_progress" },
				{ content: "b", status: "in_progress" },
			],
		});

		expect(result.details.todos.map((t) => t.status)).toEqual(["in_progress", "pending"]);
		expect(result.details.notes.some((note) => note.includes("in_progress"))).toBe(true);
	});

	test("drops empty-content items and truncates oversized lists", async () => {
		const definition = makeDefinition();
		const many = Array.from({ length: 60 }, (_, i) => ({ content: `task ${i}` }));
		many[0] = { content: "   " };
		const result = await run(definition, { todos: many });

		expect(result.details.todos).toHaveLength(50);
		expect(result.details.todos.every((t) => t.content.length > 0)).toBe(true);
	});

	test("initialTodos seed the session list", async () => {
		const definition = createTodoToolDefinition("/workspace", {
			initialTodos: [{ content: "seeded", status: "in_progress", priority: "low" }],
		});
		const result = await run(definition, {});
		expect(result.details.todos).toEqual([{ content: "seeded", status: "in_progress", priority: "low" }]);
	});
});
