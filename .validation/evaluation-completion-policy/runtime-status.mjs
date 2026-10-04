import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";

const socket = new WebSocket("ws://127.0.0.1:18901/ws");
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
async function request(payload) {
	const id = randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { socket.off("message", receive); reject(new Error("Read-only status request timed out")); }, 10000);
		const receive = (data) => {
			const message = JSON.parse(String(data));
			if (message.id !== id) return;
			clearTimeout(timer); socket.off("message", receive);
			if (!message.ok) reject(new Error(message.error)); else resolve(message.result);
		};
		socket.on("message", receive); socket.send(JSON.stringify({ ...payload, id }));
	});
}
try {
	const sessions = await request({ type: "session.running" });
	const runs = await request({ type: "evaluation.request", request: { action: "run.list" } });
	const report = { runningSessions: sessions.running.length, pendingEvaluations: runs.reduce((sum, run) => sum + run.pending, 0), pendingFollowups: 0, runningNewsJobs: 0, pendingNewsReceipts: 0, completionPolicyLoaded: false, safeToReload: false, exampleErrors: [] };
	for (const summary of runs) {
		const run = await request({ type: "evaluation.request", request: { action: "run.get", runId: summary.id } });
		for (const result of run.results) {
			report.pendingFollowups += result.followups.filter((turn) => ["queued", "running"].includes(turn.status)).length;
			if (summary.name === "测试1") report.exampleErrors.push({ label: result.anonymousLabel, error: result.error });
			if (result.error?.includes("新尝试将使用当前完成优先规则")) report.completionPolicyLoaded = true;
		}
	}
	const newsPath = "D:/owl/owl-re-v1/data/owl/news/news.sqlite";
	if (existsSync(newsPath)) {
		const db = new DatabaseSync(newsPath, { readOnly: true });
		try {
			report.runningNewsJobs = Number(db.prepare("SELECT count(*) AS n FROM news_jobs WHERE status='running'").get().n);
			report.pendingNewsReceipts = Number(db.prepare("SELECT count(*) AS n FROM news_receipts WHERE status='pending'").get().n);
		} finally { db.close(); }
	}
	report.safeToReload = [report.runningSessions, report.pendingEvaluations, report.pendingFollowups, report.runningNewsJobs, report.pendingNewsReceipts].every((count) => count === 0);
	await writeFile(new URL("runtime-status.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
} finally { socket.close(); }
