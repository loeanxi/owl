/**
 * 临时视觉预览页（vite dev 打开 /preview.html，不进生产构建入口）：
 * 用假桥数据挂载 ReviewChangesCard，检查深浅两套主题下的卡片视觉。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { ReviewChangesCard } from "../components/ReviewChangesCard.tsx";
import type { BridgeClient } from "../bridge/client.ts";
import type { DiffApprovalFileSummary } from "../bridge/protocol.ts";
import type { FileArtifact } from "../hooks/artifacts.ts";

const entries: DiffApprovalFileSummary[] = [
	{ id: "a1", path: "D:/ws/owl-mono/apps/desktop/src/components/ActivityRail.tsx", displayPath: "apps/desktop/src/components/ActivityRail.tsx", status: "pending", originalExisted: true, currentExists: true, added: 247, removed: 15, size: 10240 },
	{ id: "a2", path: "D:/ws/owl-mono/apps/desktop/src/i18n/en.ts", displayPath: "apps/desktop/src/i18n/en.ts", status: "pending", originalExisted: false, currentExists: true, added: 58, removed: 3, size: 4096 },
	{ id: "a3", path: "D:/ws/owl-mono/apps/desktop/src/i18n/zh.ts", displayPath: "apps/desktop/src/i18n/zh.ts", status: "pending", originalExisted: true, currentExists: true, added: 58, removed: 3, size: 4096 },
	{ id: "a4", path: "D:/ws/owl-mono/apps/desktop/src/components/artifacts.css", displayPath: "apps/desktop/src/components/artifacts.css", status: "kept", originalExisted: true, currentExists: true, added: 12, removed: 2, size: 2048 },
	{ id: "a5", path: "D:/ws/owl-mono/apps/desktop/src/components/legacy.css", displayPath: "apps/desktop/src/components/legacy.css", status: "reverted", originalExisted: true, currentExists: true, added: 0, removed: 40, size: 512 },
];

const sampleDiff = `diff --git a/apps/desktop/src/components/ActivityRail.tsx b/apps/desktop/src/components/ActivityRail.tsx
--- a/apps/desktop/src/components/ActivityRail.tsx
+++ b/apps/desktop/src/components/ActivityRail.tsx
@@ -12,7 +12,9 @@ import { icons } from "./icons.tsx";
 export function ActivityRail({ sessions }: Props): React.JSX.Element {
-	const items = sessions.map(toItem);
+	const items = sessions
+		.filter((session) => !session.archived)
+		.map(toItem);
 	return (
 		<nav className="owl-rail" aria-label="Sessions">
@@ -40,4 +42,7 @@ export function ActivityRail({ sessions }: Props): React.JSX.Element {
 		</nav>
 	);
 }
+
+function toItem(session: Session): RailItem {
+	return { id: session.id, label: session.title ?? "未命名会话" };
+}
`;

const files: FileArtifact[] = [
	{ path: "apps/desktop/src/components/ActivityRail.tsx", title: "ActivityRail.tsx", kind: "code", action: "edited", toolId: "t1" },
	{ path: "apps/desktop/src/i18n/en.ts", title: "en.ts", kind: "code", action: "written", toolId: "t2" },
	{ path: "apps/desktop/src/i18n/zh.ts", title: "zh.ts", kind: "code", action: "written", toolId: "t3" },
	{ path: "apps/desktop/src/components/artifacts.css", title: "artifacts.css", kind: "code", action: "edited", toolId: "t4" },
	{ path: "apps/desktop/src/components/legacy.css", title: "legacy.css", kind: "code", action: "edited", toolId: "t5" },
];

const fakeClient = {
	request: async (req: { type: string }) => {
		if (req.type === "diffApproval.list") return { ok: true, result: { files: entries } };
		if (req.type === "diffApproval.diff") return { ok: true, result: { diff: sampleDiff, truncated: false } };
		return { ok: true, result: { resolved: 1, failed: [], removed: 0 } };
	},
	onDiffApprovalChanged: () => () => undefined,
} as unknown as BridgeClient;

function App(): React.JSX.Element {
	return (
		<div style={{ minHeight: "100vh", background: "var(--owl-conversation-bg, #171717)", padding: "28px 16px" }}>
			<div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
				<button type="button" className="owl-dev-theme" onClick={() => { delete document.documentElement.dataset.owlTheme; }}>深色</button>
				<button type="button" className="owl-dev-theme" onClick={() => { document.documentElement.dataset.owlTheme = "light"; }}>浅色</button>
			</div>
			<div style={{ maxWidth: 560 }}>
				<ReviewChangesCard files={files} cwd="D:/ws/owl-mono" client={fakeClient} onOpenFile={() => undefined} onOpenReview={() => undefined} />
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
