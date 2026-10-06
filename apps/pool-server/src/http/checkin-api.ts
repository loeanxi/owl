/**
 * 签到 REST —— 移植自 manager `CheckInController`（阶段 1 子集）。
 */

import type { CheckInService } from "owl-pool";
import type { Router } from "./router.ts";

export interface CheckInRoutesDeps {
	checkin: CheckInService;
}

export function registerCheckInRoutes(router: Router, deps: CheckInRoutesDeps): void {
	router.post("/api/checkin/all", async (ctx) => {
		const onlyEnabled = ctx.query.get("onlyEnabled") !== "false";
		return deps.checkin.checkInAll(onlyEnabled);
	});

	router.post("/api/checkin/accounts/:accountId", async (ctx) => deps.checkin.checkInOne(ctx.params.accountId!));

	router.get("/api/checkin/records", async (ctx) => {
		const limit = Number.parseInt(ctx.query.get("limit") ?? "50", 10);
		return deps.checkin.recentRecords(Number.isNaN(limit) ? 50 : limit);
	});

	router.delete("/api/checkin/records/:id", async (ctx) => {
		deps.checkin.deleteRecord(ctx.params.id!);
		return { deleted: true };
	});

	router.delete("/api/checkin/records", async () => {
		deps.checkin.clearRecords();
		return { deleted: true };
	});
}
