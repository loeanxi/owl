import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	backfillDiscoveredDrafts,
	batchPublish,
	listDiscovered,
	replacePlatformSnapshot,
	syncDiscovered,
	verifyDiscovered,
} from "../src/catalog/discovery.ts";
import { openDb } from "../src/store/db.ts";
import { SqliteCatalogStore } from "../src/store/gateway-stores.ts";

const dir = mkdtempSync(join(tmpdir(), "owl-discovery-"));
const db = openDb(join(dir, "pool.db"));
const catalog = new SqliteCatalogStore(db);

afterAll(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("discovered models", () => {
	it("stores a snapshot, creates an unpublished draft, then publishes and verifies it", () => {
		replacePlatformSnapshot(db, "CLAUDE", [
			{
				upstreamModel: "claude-sonnet-4-5",
				name: "Claude Sonnet",
				catalogSource: "claude_static",
				contextWindow: 200000,
				supportsImages: true,
				supportsTools: true,
			},
		]);
		const listed = listDiscovered(db);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.upstreamModel).toBe("claude-sonnet-4-5");
		expect(listed[0]?.available).toBe(true);

		const drafts = backfillDiscoveredDrafts(db, catalog, [
			{
				id: "acct",
				name: "claude",
				platform: "CLAUDE",
				credentials: {},
				enabled: true,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
		expect(drafts).toHaveLength(1);
		expect(drafts[0]?.published).toBe(false);
		expect(drafts[0]?.publicId).toBe("claude-sonnet-4-5");

		const published = batchPublish(catalog, [drafts[0]!.id]);
		expect(published[0]?.published).toBe(true);

		const verified = verifyDiscovered(db, String(listed[0]?.id), {
			verifiedModelVersion: "20250929",
			supportsImages: true,
			supportsTools: true,
			reasoningEfforts: ["high"],
			verificationSource: "manual",
		});
		expect(verified.verificationStatus).toBe("VERIFIED");
		expect(verified.modelVersion).toBe("20250929");
	});

	it("raises a published narrow window to a later full upstream and enables that route", () => {
		replacePlatformSnapshot(db, "TRAE", [
			{
				upstreamModel: "step-5-preview",
				name: "Step-5-Preview",
				catalogSource: "trae_live",
				contextWindow: 200_000,
				maxOutputTokens: 32_000,
				supportsImages: true,
				supportsTools: true,
				reasoningEfforts: ["high"],
			},
		]);
		const drafts = backfillDiscoveredDrafts(db, catalog, [account("TRAE")]);
		const published = batchPublish(catalog, [drafts[0]!.id]);
		expect(published[0]?.contextWindow).toBe(200_000);

		replacePlatformSnapshot(db, "WORKBUDDY", [
			{
				upstreamModel: "step-5-preview",
				name: "Step-5-Preview",
				catalogSource: "workbuddy_ui",
				contextWindow: 1_000_000,
				maxOutputTokens: 64_000,
				supportsImages: true,
				supportsTools: true,
			},
		]);
		expect(backfillDiscoveredDrafts(db, catalog, [account("TRAE"), account("WORKBUDDY")])).toEqual([]);
		const model = catalog.findPublishedByPublicId("step-5-preview");
		expect(model?.contextWindow).toBe(1_000_000);
		expect(model?.maxOutputTokens).toBe(64_000);
		const routes = catalog.routesOf(model!.id);
		expect(routes.map((route) => [route.platform, route.priority])).toEqual([
			["WORKBUDDY", 0],
			["TRAE", 1],
		]);
		expect(routes.find((route) => route.platform === "WORKBUDDY")?.enabled).toBe(true);
		expect(routes.find((route) => route.platform === "WORKBUDDY")?.reasoningEfforts).toEqual(["high"]);
	});

	it("keeps a discovered full window when a later snapshot is narrower", () => {
		replacePlatformSnapshot(db, "WORKBUDDY", [
			{
				upstreamModel: "window-hold",
				name: "Window Hold",
				catalogSource: "workbuddy_ui",
				contextWindow: 1_000_000,
				maxOutputTokens: 64_000,
			},
		]);
		replacePlatformSnapshot(db, "WORKBUDDY", [
			{
				upstreamModel: "window-hold",
				name: "Window Hold",
				catalogSource: "workbuddy_ui",
				contextWindow: 200_000,
				maxOutputTokens: 8_000,
			},
		]);
		const row = listDiscovered(db).find((item) => item.upstreamModel === "window-hold");
		expect(row?.contextWindow).toBe(1_000_000);
		expect(row?.maxOutputTokens).toBe(64_000);
	});

	it("adds image support found by a later upstream onto the existing model and route", () => {
		replacePlatformSnapshot(db, "TRAE", [
			{
				upstreamModel: "vision-preview",
				name: "Vision",
				catalogSource: "trae_live",
				contextWindow: 200_000,
				supportsImages: false,
				supportsTools: true,
			},
		]);
		const drafts = backfillDiscoveredDrafts(db, catalog, [account("TRAE")]);
		expect(drafts[0]?.supportsImages).toBe(false);

		replacePlatformSnapshot(db, "WORKBUDDY", [
			{
				upstreamModel: "vision-preview",
				name: "Vision",
				catalogSource: "workbuddy_ui",
				contextWindow: 200_000,
				supportsImages: true,
				supportsTools: true,
			},
		]);
		expect(backfillDiscoveredDrafts(db, catalog, [account("TRAE"), account("WORKBUDDY")])).toEqual([]);
		const model = catalog.findPublishedByPublicId("vision-preview");
		expect(model?.supportsImages).toBe(true);
		expect(catalog.routesOf(model!.id).find((route) => route.platform === "WORKBUDDY")?.supportsImages).toBe(true);
	});

	it("adds reasoning efforts found later onto the model and the existing route", () => {
		replacePlatformSnapshot(db, "TRAE", [
			{
				upstreamModel: "think-preview",
				name: "Think",
				catalogSource: "trae_live",
				contextWindow: 200_000,
				reasoningEfforts: [],
			},
		]);
		backfillDiscoveredDrafts(db, catalog, [account("TRAE")]);
		replacePlatformSnapshot(db, "TRAE", [
			{
				upstreamModel: "think-preview",
				name: "Think",
				catalogSource: "trae_live",
				contextWindow: 200_000,
				reasoningEfforts: ["low", "high"],
			},
		]);
		expect(backfillDiscoveredDrafts(db, catalog, [account("TRAE")])).toEqual([]);
		const model = catalog.findPublishedByPublicId("think-preview");
		expect(model?.reasoningEfforts).toEqual(["low", "high"]);
		expect(catalog.routesOf(model!.id).find((route) => route.platform === "TRAE")?.reasoningEfforts).toEqual([
			"low",
			"high",
		]);
		replacePlatformSnapshot(db, "TRAE", [
			{
				upstreamModel: "think-preview",
				name: "Think",
				catalogSource: "trae_live",
				contextWindow: 200_000,
				reasoningEfforts: ["low"],
			},
		]);
		backfillDiscoveredDrafts(db, catalog, [account("TRAE")]);
		expect(catalog.findPublishedByPublicId("think-preview")?.reasoningEfforts).toEqual(["low", "high"]);
	});

	it("uses the largest Qoder window and does not let a later account shrink it", async () => {
		const localDir = mkdtempSync(join(tmpdir(), "owl-qoder-window-"));
		const localDb = openDb(join(localDir, "pool.db"));
		try {
			await syncDiscovered(localDb, [qoderAccount("small"), qoderAccount("full")], {
				sdkCatalog: async (account) =>
					account.id === "small"
						? [{ id: "qwen", name: "Qwen", contextWindow: 128_000 }]
						: [
								{
									id: "qwen",
									name: "Qwen",
									contextWindow: 200_000,
									availableContextWindows: [200_000, 1_000_000],
								},
							],
			});
			expect(listDiscovered(localDb).find((item) => item.upstreamModel === "qwen")?.contextWindow).toBe(1_000_000);
			await syncDiscovered(localDb, [qoderAccount("vision"), qoderAccount("plain")], {
				sdkCatalog: async (account) =>
					account.id === "vision"
						? [
								{
									id: "qwen",
									name: "Qwen",
									supportsImages: true,
									supportsTools: true,
									reasoningEfforts: ["high"],
								},
							]
						: [{ id: "qwen", name: "Qwen", supportsImages: false, supportsTools: false, reasoningEfforts: [] }],
			});
			const kept = listDiscovered(localDb).find((item) => item.upstreamModel === "qwen");
			expect(kept?.supportsImages).toBe(true);
			expect(kept?.supportsTools).toBe(true);
			expect(kept?.reasoningEfforts).toEqual(["high"]);
		} finally {
			localDb.close();
			rmSync(localDir, { recursive: true, force: true });
		}
	});
});

function qoderAccount(id: string) {
	return {
		id,
		name: id,
		platform: "QODER" as const,
		credentials: { accessToken: id },
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
	};
}

function account(platform: "TRAE" | "WORKBUDDY") {
	return {
		id: platform,
		name: platform,
		platform,
		credentials: {},
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
	};
}
