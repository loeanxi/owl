import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { BridgeClient } from "../../../apps/desktop/src/bridge/client.ts";
import {
	cancelAllPendingQuestions,
	getAllPendingQuestionRequests,
	getQuestionChannel,
	type QuestionOutcome,
	registerPendingQuestion,
	setQuestionChannel,
} from "../src/core/question-channel.ts";
import { handleDialogRequest } from "../src/modes/desktop/handlers/workbench.ts";
import { DesktopPermissionQueue } from "../src/modes/desktop/permission-queue.ts";
import type {
	DesktopClientRequest,
	DesktopServerMessage,
	QuestionRequestMessage,
} from "../src/modes/desktop/protocol.ts";

afterEach(() => {
	cancelAllPendingQuestions();
	setQuestionChannel(undefined);
	vi.unstubAllGlobals();
});

it("retires a questionnaire on both real clients before acknowledging its answer, while other sessions remain pending", async () => {
	vi.stubGlobal("WebSocket", WebSocket);
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise<void>((done) => server.once("listening", done));
	const broadcast = (message: DesktopServerMessage): void => {
		for (const socket of server.clients) if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
	};
	const context = {
		reply: (socket: WebSocket, id: string, value: { ok: boolean; result?: unknown; error?: string }): void => {
			socket.send(JSON.stringify({ type: "response", id, ...value }));
		},
		pendingPermissions: new DesktopPermissionQueue(broadcast),
	};
	setQuestionChannel({ broadcast, hasConnectedClients: () => server.clients.size > 0 });
	server.on("connection", (socket) =>
		socket.on("message", (raw) => {
			const request = JSON.parse(String(raw)) as DesktopClientRequest;
			if (request.type === "question.response" || request.type === "permission.response")
				void handleDialogRequest(socket, request, context);
			else context.reply(socket, request.id, { ok: true });
		}),
	);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing isolated bridge port");
	const clients = [
		new BridgeClient(`ws://127.0.0.1:${address.port}/ws`),
		new BridgeClient(`ws://127.0.0.1:${address.port}/ws`),
	];
	const queues: QuestionRequestMessage[][] = [[], []];
	const terminal: string[][] = [[], []];
	const outcomes: QuestionOutcome[] = [];
	try {
		await Promise.all(
			clients.map(
				(client, index) =>
					new Promise<void>((done) => {
						client.onQuestionRequest((request) => queues[index].push(request));
						client.onSessionEvent((message) => {
							const event = message.event as { type?: string; requestId?: string };
							if (event.type !== "question_resolved") return;
							terminal[index].push(event.requestId!);
							queues[index] = queues[index].filter(
								(request) => request.sessionId !== message.sessionId || request.requestId !== event.requestId,
							);
						});
						client.onStatus((connected) => {
							if (connected) done();
						});
						client.connect();
					}),
			),
		);
		for (const [requestId, sessionId] of [
			["selected", "research"],
			["unrelated", "chat"],
		]) {
			const request: QuestionRequestMessage = {
				type: "question_request",
				requestId,
				sessionId,
				toolCallId: `tool-${requestId}`,
				questions: [
					{
						question: "Choose a retained answer",
						header: "Choice",
						multiSelect: false,
						options: [{ label: "A" }, { label: "B" }],
					},
				],
			};
			registerPendingQuestion(requestId, {
				sessionId,
				toolCallId: request.toolCallId,
				resolve: (outcome) => outcomes.push(outcome),
			});
			getQuestionChannel()?.broadcast(request);
		}
		await vi.waitFor(() => expect(queues.map((queue) => queue.length)).toEqual([2, 2]));
		await expect(
			clients[0].respondQuestion("selected", [{ index: 0, selectedLabels: ["B"], note: "keep this note" }]),
		).resolves.toMatchObject({ ok: true });
		await vi.waitFor(() => expect(terminal).toEqual([["selected"], ["selected"]]));
		expect(queues.map((queue) => queue.map((request) => request.requestId))).toEqual([["unrelated"], ["unrelated"]]);
		expect(outcomes).toEqual([
			{ cancelled: false, answers: [{ index: 0, selectedLabels: ["B"], note: "keep this note" }] },
		]);
		expect(getAllPendingQuestionRequests().map((request) => request.requestId)).toEqual(["unrelated"]);
		await expect(clients[1].respondQuestion("missing", [])).resolves.toMatchObject({
			ok: false,
			error: "Unknown question request: missing",
		});
		expect(getAllPendingQuestionRequests().map((request) => request.requestId)).toEqual(["unrelated"]);
		cancelAllPendingQuestions();
		await vi.waitFor(() => expect(queues).toEqual([[], []]));
	} finally {
		for (const client of clients) client.disconnect();
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((done) => server.close(() => done()));
	}
});
