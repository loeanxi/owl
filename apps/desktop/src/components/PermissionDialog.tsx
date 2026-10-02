import type { PermissionRequest } from "../bridge/protocol.ts";
import { describeToolInput } from "../hooks/summarize.ts";

export function PermissionDialog({
	request,
	onDecide,
}: {
	request: PermissionRequest;
	onDecide: (approved: boolean) => void;
}): React.JSX.Element {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
			<div className="w-[560px] rounded-xl border border-owl-border bg-owl-panel p-4 shadow-2xl shadow-black/40">
				<h2 className="text-sm font-semibold text-amber-400">工具请求确认</h2>
				<p className="mt-1 text-sm">
					Agent 想运行 <span className="font-mono text-owl-accent">{request.toolName}</span>
				</p>
				{/* 人话说明（命令/路径/编辑内容）；未知工具退回 JSON，保证看得到全貌 */}
				<pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-owl-sidebar p-3 text-xs whitespace-pre-wrap text-owl-text">
					{describeToolInput(request.toolName, request.input)}
				</pre>
				<div className="mt-3 flex justify-end gap-2">
					<button
						type="button"
						className="rounded-lg border border-owl-border px-3 py-1.5 text-sm text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
						onClick={() => onDecide(false)}
					>
						拒绝
					</button>
					<button
						type="button"
						className="rounded-lg bg-owl-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-owl-accent-hover"
						onClick={() => onDecide(true)}
					>
						允许
					</button>
				</div>
			</div>
		</div>
	);
}
