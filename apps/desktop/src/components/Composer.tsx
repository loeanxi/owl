import { useState } from "react";

export function Composer({
	disabled,
	running,
	onSend,
	onAbort,
}: {
	disabled: boolean;
	running: boolean;
	onSend: (text: string) => void;
	onAbort: () => void;
}): React.JSX.Element {
	const [value, setValue] = useState("");
	const submit = (): void => {
		const text = value.trim();
		if (!text) return;
		onSend(text);
		setValue("");
	};
	return (
		<div className="border-t border-neutral-800 p-3">
			<div className="mx-auto flex max-w-3xl items-end gap-2">
				<textarea
					className="min-h-[44px] flex-1 resize-y rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-700"
					placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
					value={value}
					rows={2}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit();
						}
					}}
				/>
				{running ? (
					<button
						type="button"
						className="rounded bg-red-900 px-4 py-2 text-sm hover:bg-red-800"
						onClick={onAbort}
					>
						中止
					</button>
				) : (
					<button
						type="button"
						className="rounded bg-sky-800 px-4 py-2 text-sm hover:bg-sky-700 disabled:opacity-40"
						disabled={disabled}
						onClick={submit}
					>
						发送
					</button>
				)}
			</div>
		</div>
	);
}
