import assert from "node:assert/strict";
import test from "node:test";
import { recordPlace, samePlace, stepBack, stepForward, type AppHistory, type AppPlace } from "./app-history.ts";

function place(patch: Partial<AppPlace> = {}): AppPlace {
	return {
		rail: "chat",
		settings: false,
		settingsTab: "general",
		workspace: "D:/owl",
		...patch,
	};
}

function history(current: AppPlace, back: AppPlace[] = [], forward: AppPlace[] = []): AppHistory {
	return { current, back, forward };
}

test("identical places, including slash differences, do not grow the stack", () => {
	const current = place({ workspace: "D:/owl" });
	const stack = history(current);
	const next = place({ workspace: "D:\\owl\\" });
	assert.equal(samePlace(current, next), true);
	assert.equal(recordPlace(stack, next), stack);
});

test("changing screen pushes the previous place and clears forward", () => {
	const chat = place();
	const news = place({ rail: "news" });
	const mail = place({ rail: "mail" });
	const afterNews = recordPlace(history(chat, [], [mail]), news);
	assert.deepEqual(afterNews.back, [chat]);
	assert.deepEqual(afterNews.forward, []);
	assert.equal(afterNews.current, news);
});

test("a blank session receiving its id is not a new step", () => {
	const blank = place();
	const created = place({ chatSession: "s1" });
	const updated = recordPlace(history(blank, [place({ rail: "news" })]), created);
	assert.deepEqual(updated.back, [place({ rail: "news" })]);
	assert.equal(updated.current.chatSession, "s1");
});

test("back then forward returns to the same places", () => {
	const chat = place({ chatSession: "a" });
	const settings = place({ chatSession: "a", settings: true, settingsTab: "models" });
	const recorded = recordPlace(history(chat), settings);
	const back = stepBack(recorded);
	assert.ok(back);
	assert.equal(back.place, chat);
	assert.deepEqual(back.history.forward, [settings]);
	const forward = stepForward(back.history);
	assert.ok(forward);
	assert.equal(forward.place, settings);
	assert.deepEqual(forward.history.back, [chat]);
});

test("a new step after back drops the forward stack", () => {
	const chat = place({ chatSession: "a" });
	const news = place({ rail: "news", chatSession: "a" });
	const back = stepBack(recordPlace(history(chat), news));
	assert.ok(back);
	const mail = place({ rail: "mail", chatSession: "a" });
	const next = recordPlace(back.history, mail);
	assert.deepEqual(next.forward, []);
	assert.deepEqual(next.back, [chat]);
});

test("history keeps at most 50 previous places", () => {
	let stack = history(place({ chatSession: "0" }));
	for (let index = 1; index <= 60; index += 1) stack = recordPlace(stack, place({ chatSession: String(index) }));
	assert.equal(stack.back.length, 50);
	assert.equal(stack.back[0]?.chatSession, "10");
	assert.equal(stack.current.chatSession, "60");
});
