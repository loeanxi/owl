import type { PermissionRequest } from "../bridge/protocol.ts";

export function PermissionDialog({
	request,
	onDecide,
}: {
	request: PermissionRequest;
	onDecide: (approved: boolean) => void;
}): React.JSX.Element {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div className="w-[560px] rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl">
				<h2 className="text-sm font-semibold text-amber-400">工具请求确认</h2>
				<p className="mt-1 text-sm">
					Agent 想运行 <span className="font-mono text-sky-400">{request.toolName}</span>
				</p>
				<pre className="mt-2 max-h-72 overflow-auto rounded bg-neutral-950 p-3 text-xs whitespace-pre-wrap text-neutral-300">
					{JSON.stringify(request.input, null, 2)}
				</pre>
				<div className="mt-3 flex justify-end gap-2">
					<button
						type="button"
						className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
						onClick={() => onDecide(false)}
					>
						拒绝
					</button>
					<button
						type="button"
						className="rounded bg-emerald-800 px-3 py-1.5 text-sm hover:bg-emerald-700"
						onClick={() => onDecide(true)}
					>
						允许
					</button>
				</div>
			</div>
		</div>
	);
}
