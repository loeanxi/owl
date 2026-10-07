/**
 * 原版管理台首屏会打的读接口。成员、发现目录、备份状态走已经迁过来的存储。
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type AccountStore, BusinessError } from "owl-pool";
import {
	backfillDiscoveredDrafts,
	batchPublish,
	discoveryStatus,
	type LiveDiscoveryOptions,
	listDiscovered,
	syncDiscovered,
	verifyDiscovered,
} from "../catalog/discovery.ts";
import { listSnapshots } from "../store/backup.ts";
import type { SqliteCallLogStore, SqliteCatalogStore } from "../store/gateway-stores.ts";
import type { Router } from "./router.ts";

export interface ManagerUiRoutesDeps {
	accounts: AccountStore;
	callLogs?: SqliteCallLogStore;
	maxRotate: number;
	/** 成员登录已由 member-api 接管时，不再用「永远未登录」占位。 */
	memberPortal?: boolean;
	listMembers?: () => unknown[];
	db?: DatabaseSync;
	catalog?: SqliteCatalogStore;
	backupDir?: string;
	liveDiscovery?: LiveDiscoveryOptions;
}

export function registerManagerUiRoutes(router: Router, deps: ManagerUiRoutesDeps): void {
	if (deps.memberPortal !== true) {
		router.get("/api/member/session", async () => ({ authenticated: false }));
	}
	router.get("/api/members", async () => deps.listMembers?.() ?? []);
	router.get("/api/models/discovered", async () => (deps.db === undefined ? [] : listDiscovered(deps.db)));
	router.get("/api/models/discovery-status", async () => discoveryStatus());
	router.post("/api/models/sync", async () => {
		if (deps.db === undefined) {
			throw BusinessError.of("catalog.discoveryUnavailable", "模型发现存储未启用");
		}
		return syncDiscovered(deps.db, deps.accounts.list(), deps.liveDiscovery);
	});
	router.post("/api/models/drafts/from-discovered", async () => {
		if (deps.db === undefined || deps.catalog === undefined) {
			throw BusinessError.of("catalog.draftBackfillFailed", "模型草稿服务不可用");
		}
		return backfillDiscoveredDrafts(deps.db, deps.catalog, deps.accounts.list());
	});
	router.post("/api/models/batch-publish", async (ctx) => {
		if (deps.catalog === undefined) {
			throw BusinessError.of("catalog.publishUnavailable", "模型目录未启用");
		}
		const body = await ctx.readBody<Record<string, unknown>>();
		const modelIds = Array.isArray(body.modelIds) ? body.modelIds.map((id) => String(id)) : [];
		return batchPublish(deps.catalog, modelIds);
	});
	router.patch("/api/models/discovered/:id", async (ctx) => {
		if (deps.db === undefined) {
			throw BusinessError.of("catalog.discoveryUnavailable", "模型发现存储未启用");
		}
		return verifyDiscovered(deps.db, ctx.params.id ?? "", (await ctx.readBody<Record<string, unknown>>()) ?? {});
	});
	router.get("/api/model-diagnostics/latest", async () => []);
	router.get("/api/model-diagnostics/runs", async () => []);
	router.get("/api/backups/status", async () => backupStatus(deps.backupDir));
	router.get("/api/gateway/usage/stream", async (ctx) => {
		ctx.response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		ctx.response.write("event: hello\ndata: {}\n\n");
		const timer = setInterval(() => {
			if (!ctx.response.writableEnded) {
				ctx.response.write(": keepalive\n\n");
			}
		}, 15000);
		ctx.request.on("close", () => clearInterval(timer));
	});

	router.get("/api/gateway/status", async () => {
		const now = Date.now();
		const accounts = deps.accounts.list().map((account) => ({
			id: account.id,
			enabled: account.enabled,
			cooling: (account.cooldownUntil ?? 0) > now,
		}));
		return { enabled: true, maxRotate: deps.maxRotate, pool: { accounts } };
	});

	router.get("/api/gateway/usage", async (ctx) => {
		const limit = clampLimit(ctx.query.get("limit"));
		const logs = deps.callLogs?.recent(limit) ?? [];
		let promptTokens = 0;
		let completionTokens = 0;
		let fails = 0;
		for (const log of logs) {
			promptTokens += log.promptTokens ?? 0;
			completionTokens += log.completionTokens ?? 0;
			const status = log.status.toUpperCase();
			if (status !== "OK" && status !== "SUCCESS") {
				fails++;
			}
		}
		const day = shanghaiToday();
		return {
			summary: {
				calls: logs.length,
				fails,
				promptTokens,
				completionTokens,
				totalTokens: promptTokens + completionTokens,
				knownCalls: logs.length,
				estimatedCalls: 0,
				unknownCalls: 0,
				creditCost: 0,
				creditUnknown: 0,
			},
			items: logs,
			range: { date: day, zoneId: "Asia/Shanghai", from: `${day}T00:00:00+08:00`, to: `${day}T23:59:59+08:00` },
			live: true,
		};
	});

	router.get("/api/gateway/usage/lifetime", async () => {
		const logs = deps.callLogs?.recent(500) ?? [];
		let promptTokens = 0;
		let completionTokens = 0;
		let fails = 0;
		for (const log of logs) {
			promptTokens += log.promptTokens ?? 0;
			completionTokens += log.completionTokens ?? 0;
			const status = log.status.toUpperCase();
			if (status !== "OK" && status !== "SUCCESS") {
				fails++;
			}
		}
		return {
			summary: {
				calls: logs.length,
				fails,
				promptTokens,
				completionTokens,
				totalTokens: promptTokens + completionTokens,
			},
			span: { firstOccurredAt: "", lastOccurredAt: "" },
			zoneId: "Asia/Shanghai",
		};
	});
}

function backupStatus(backupDir: string | undefined): Record<string, unknown> {
	const empty = {
		enabled: true,
		state: "NEVER_RUN",
		startedAt: null,
		finishedAt: null,
		lastSuccessfulAt: null,
		databaseComplete: false,
		databaseArchive: null,
		credentials: [],
		issues: [],
	};
	if (backupDir === undefined) {
		return empty;
	}
	const files = listSnapshots(backupDir);
	const latest = files[0];
	if (latest === undefined) {
		return empty;
	}
	const full = join(backupDir, latest);
	const modified = statSync(full).mtime.toISOString();
	return {
		...empty,
		state: "SUCCESS",
		startedAt: modified,
		finishedAt: modified,
		lastSuccessfulAt: modified,
		databaseComplete: true,
		databaseArchive: full,
	};
}

function clampLimit(raw: string | null): number {
	const parsed = Number.parseInt(raw ?? "50", 10);
	if (Number.isNaN(parsed)) {
		return 50;
	}
	return Math.max(1, Math.min(parsed, 200));
}

function shanghaiToday(): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
}
