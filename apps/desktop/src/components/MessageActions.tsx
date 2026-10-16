import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconCheck, IconCopy, IconMore } from "./icons.tsx";
import { useMessageActionsText } from "./message-actions-copy.ts";
import "./message-actions.css";

type CopyOwner = { identity?: string; text: string };

/** Clipboard completion and feedback belong to exactly one mounted message and payload. */
export function MessageCopyButton({ text, label, className = "owl-msg-action", identity, showLabel = false }: {
	text: string;
	label: string;
	className?: string;
	identity?: string;
	showLabel?: boolean;
}): React.JSX.Element {
	const copy = useMessageActionsText();
	const owner = useMemo<CopyOwner>(() => ({ identity, text }), [identity, text]);
	const currentOwner = useRef(owner);
	currentOwner.current = owner;
	const mounted = useRef(false);
	const generation = useRef(0);
	const inFlight = useRef<CopyOwner | undefined>(undefined);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [pendingOwner, setPendingOwner] = useState<CopyOwner>();
	const [feedback, setFeedback] = useState<{ owner: CopyOwner; tone: "success" | "error" }>();
	useLayoutEffect(() => {
		mounted.current = true;
		inFlight.current = undefined;
		setPendingOwner(undefined);
		setFeedback(undefined);
		return () => {
			mounted.current = false;
			generation.current++;
			inFlight.current = undefined;
			clearTimeout(timer.current);
		};
	}, [owner]);
	const pending = pendingOwner === owner;
	const tone = feedback?.owner === owner ? feedback.tone : undefined;
	return <span className="owl-message-copy" data-message-action-ui="">
		<button
			type="button"
			className={className}
			title={pending ? copy("copying") : label}
			aria-label={label}
			aria-busy={pending || undefined}
			disabled={pending}
			onClick={async (event) => {
				event.stopPropagation();
				if (inFlight.current === owner) return;
				const attempt = ++generation.current;
				inFlight.current = owner;
				clearTimeout(timer.current);
				setFeedback(undefined);
				setPendingOwner(owner);
				let result: "success" | "error" = "success";
				try {
					if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
					await navigator.clipboard.writeText(text);
				} catch { result = "error"; }
				if (!mounted.current || currentOwner.current !== owner || generation.current !== attempt) return;
				inFlight.current = undefined;
				setPendingOwner(undefined);
				setFeedback({ owner, tone: result });
				if (result === "success") timer.current = setTimeout(() => {
					if (mounted.current && currentOwner.current === owner && generation.current === attempt) setFeedback(undefined);
				}, 2500);
			}}
		>
			{tone === "success" ? <IconCheck className="h-3.5 w-3.5" /> : <IconCopy className="h-3.5 w-3.5" />}
			{showLabel && <span className="owl-message-action-label">{copy("copy")}</span>}
		</button>
		<span className="owl-message-copy-status" role="status" aria-live="polite" data-tone={tone}>{pending ? copy("copying") : tone === "success" ? copy("copied") : tone === "error" ? copy("copyFailed") : ""}</span>
	</span>;
}

export type MessageMoreItem = { id: string; label: string; onSelect: () => void; disabled?: boolean };

/** A small menu outside message bubbles; keyboard and pointer dismissal restore its trigger. */
export function MessageMoreMenu({ label, items, identity }: { label: string; items: readonly MessageMoreItem[]; identity?: string }): React.JSX.Element | null {
	const copy = useMessageActionsText();
	const id = useId();
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const firstFocus = useRef<"first" | "last">("first");
	const [open, setOpen] = useState(false);
	const itemSignature = JSON.stringify(items.map((item) => [item.id, Boolean(item.disabled)]));
	const close = (restoreFocus = true): void => {
		setOpen(false);
		if (restoreFocus) trigger.current?.focus({ preventScroll: true });
	};
	useLayoutEffect(() => {
		if (menu.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
		setOpen(false);
	}, [identity, itemSignature]);
	useLayoutEffect(() => {
		if (!open) return;
		const choices = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
		const target = firstFocus.current === "last" ? choices?.[choices.length - 1] : choices?.[0];
		target?.focus({ preventScroll: true });
		const panel = menu.current;
		const button = trigger.current;
		if (panel && button) {
			const viewport = root.current?.closest(".owl-chat-scroll")?.getBoundingClientRect();
			const anchor = (root.current?.closest(".owl-msg-actions") ?? root.current)?.getBoundingClientRect() ?? button.getBoundingClientRect();
			const above = anchor.top - Math.max(8, viewport?.top ?? 8) - 8;
			const below = Math.min(window.innerHeight - 8, viewport?.bottom ?? window.innerHeight - 8) - anchor.bottom - 8;
			const side = above >= panel.offsetHeight || above >= below ? "top" : "bottom";
			panel.dataset.side = side;
			panel.style.maxHeight = `${Math.max(0, Math.floor(side === "top" ? above : below))}px`;
		}
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const outside = (event: PointerEvent): void => {
			if (!root.current?.contains(event.target as Node)) close(false);
		};
		const escape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
		};
		const moved = (event: Event): void => {
			if (event.type === "resize" || event.target === document || (event.target instanceof Element && root.current && event.target.contains(root.current))) close(false);
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", escape);
		document.addEventListener("scroll", moved, true);
		window.addEventListener("resize", moved);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", escape);
			document.removeEventListener("scroll", moved, true);
			window.removeEventListener("resize", moved);
		};
	}, [open]);
	if (items.length === 0) return null;
	return <div className="owl-message-more" ref={root} data-message-action-ui="" onBlur={(event) => {
		if (open && !event.currentTarget.contains(event.relatedTarget)) close(false);
	}}>
		<button
			type="button"
			ref={trigger}
			id={`${id}-trigger`}
			className="owl-msg-action owl-message-more-trigger"
			aria-label={label}
			title={label}
			aria-haspopup="menu"
			aria-expanded={open}
			aria-controls={open ? `${id}-menu` : undefined}
			onFocus={() => { if (open) setOpen(false); }}
			onClick={(event) => { event.stopPropagation(); if (open) close(); else { firstFocus.current = "first"; setOpen(true); } }}
			onKeyDown={(event) => {
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					firstFocus.current = event.key === "ArrowUp" ? "last" : "first";
					setOpen(true);
				}
			}}
		>
			<IconMore className="h-3.5 w-3.5" />
			<span className="owl-message-action-label">{copy("moreShort")}</span>
		</button>
		{open && <div ref={menu} id={`${id}-menu`} className="owl-message-more-menu" role="menu" aria-labelledby={`${id}-trigger`} onKeyDown={(event) => {
			const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
			if (event.key === "Tab") return;
			if (event.key === "Enter" || event.key === " ") {
				const choice = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[role="menuitem"]') : null;
				if (choice && !choice.disabled) { event.preventDefault(); choice.click(); }
				return;
			}
			const current = choices.findIndex((choice) => choice === document.activeElement);
			let next: number;
			if (event.key === "ArrowDown") next = (current + 1) % choices.length;
			else if (event.key === "ArrowUp") next = (current - 1 + choices.length) % choices.length;
			else if (event.key === "Home") next = 0;
			else if (event.key === "End") next = choices.length - 1;
			else return;
			event.preventDefault();
			choices[next]?.focus({ preventScroll: true });
		}}>
			{items.map((item) => <button key={item.id} type="button" role="menuitem" tabIndex={-1} className="owl-message-more-item" disabled={item.disabled} onClick={(event) => {
				event.stopPropagation();
				close();
				item.onSelect();
			}}>{item.label}</button>)}
		</div>}
	</div>;
}
