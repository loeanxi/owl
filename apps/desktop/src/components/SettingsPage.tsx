import { useEffect, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";

export function SettingsPage({
	client,
	workspaceDir,
	onWorkspaceDir,
	onClose,
}: {
	client: BridgeClient;
	workspaceDir: string;
	onWorkspaceDir: (dir: string) => void;
	onClose: () => void;
}): React.JSX.Element {
	const [agentDir, setAgentDir] = useState("");
	const [raw, setRaw] = useState("");
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		void (async () => {
			const response = await client.request<{ agentDir: string; settings: unknown }>({
				type: "settings.get",
			});
			if (response.ok && response.result) {
				setAgentDir(response.result.agentDir);
				setRaw(JSON.stringify(response.result.settings, null, 2));
			}
		})();
	}, [client]);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div className="flex h-[80vh] w-[720px] flex-col rounded-lg border border-neutral-700 bg-neutral-900 p-4">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-semibold">设置</h2>
					<button type="button" className="text-neutral-500 hover:text-neutral-300" onClick={onClose}>
						✕
					</button>
				</div>
				<label className="mt-3 block text-xs text-neutral-400">工作目录（新会话的 cwd）</label>
				<input
					className="mt-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm"
					value={workspaceDir}
					onChange={(event) => onWorkspaceDir(event.target.value)}
				/>
				<label className="mt-3 block text-xs text-neutral-400">agent 目录（隔离的数据目录）</label>
				<input className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-500" value={agentDir} readOnly />
				<label className="mt-3 block text-xs text-neutral-400">settings.json（只读预览；编辑走 JSON 后由保存写回）</label>
				<textarea
					className="flex-1 rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-xs"
					value={raw}
					onChange={(event) => setRaw(event.target.value)}
				/>
				<div className="mt-3 flex justify-end gap-2">
					<button type="button" className="rounded border border-neutral-700 px-3 py-1.5 text-sm" onClick={onClose}>
						关闭
					</button>
					<button
						type="button"
						className="rounded bg-sky-800 px-3 py-1.5 text-sm hover:bg-sky-700"
						onClick={() => {
							void (async () => {
								try {
									const values = JSON.parse(raw) as Record<string, unknown>;
									const response = await client.request({ type: "settings.set", values });
									if (response.ok) {
										setSaved(true);
										setTimeout(() => setSaved(false), 2000);
									}
								} catch (error) {
									console.error("settings.set failed:", error);
								}
							})();
						}}
					>
						{saved ? "已保存 ✓" : "保存"}
					</button>
				</div>
			</div>
		</div>
	);
}
