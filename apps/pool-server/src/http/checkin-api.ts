/**
 * 签到 REST —— 移植自 manager `CheckInController`（阶段 1 子集）。
 */

import { BusinessError, type CheckInService } from "owl-pool";
import type { Router } from "./router.ts";

export interface CheckInRoutesDeps {
	checkin: CheckInService;
}

export function registerCheckInRoutes(router: Router, deps: CheckInRoutesDeps): void {
	router.post("/api/checkin/all", async (ctx) => {
		const body = await ctx.readBody<unknown>();
		if (body === null || typeof body !== "object" || Array.isArray(body)) {
			throw BusinessError.of("checkin.badAccountIds", "签到请求必须是 JSON 对象");
		}
		const accountIds = (body as Record<string, unknown>).accountIds;
		if (accountIds !== undefined) {
			if (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== "string" || id.trim().length === 0)) {
				throw BusinessError.of("checkin.badAccountIds", "accountIds 必须是非空账号 ID 的数组");
			}
			return deps.checkin.checkInSelected(accountIds);
		}
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
