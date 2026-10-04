import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BridgeClient } from "../bridge/client.ts";
import { hasTauri, pickFolder } from "../bridge/native.ts";
import type { ProjectCreateResult } from "../bridge/protocol.ts";
import { useT } from "../i18n/index.ts";
import { setProjectAlias } from "../project-sidebar-model.ts";
import { IconFolder, IconPlus } from "./icons.tsx";
import "./new-project-dialog.css";

/** A project name is a sidebar alias; its source folder remains the workspace directory. */
export function NewProjectDialog({
	client,
	onClose,
	onCreated,
	initialProject,
}: {
	client: BridgeClient;
	onClose: () => void;
	/** The normalized workspace path and its display name. Editing does not move the folder. */
	onCreated: (path: string, name?: string) => void;
	initialProject?: { path: string; name: string };
}): React.JSX.Element {
	const t = useT();
	const id = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const nameRef = useRef<HTMLInputElement>(null);
	const busyRef = useRef(false);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const [name, setName] = useState(initialProject?.name ?? "");
	const [path, setPath] = useState(initialProject?.path ?? "");
	const [creating, setCreating] = useState(false);
	const [browsing, setBrowsing] = useState(false);
	const [error, setError] = useState("");
	const nativePicker = hasTauri();
	const editing = initialProject !== undefined;
	const busy = creating || browsing;

	useEffect(() => {
		const previousFocus = document.activeElement;
		nameRef.current?.focus();
		const handleKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				if (!busyRef.current) onCloseRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
				'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
			);
			if (!controls?.length) {
				event.preventDefault();
				dialogRef.current?.focus();
				return;
			}
			const first = controls[0];
			const last = controls[controls.length - 1];
			const outsideDialog = !dialogRef.current?.contains(document.activeElement);
			if (outsideDialog || document.activeElement === dialogRef.current) {
				event.preventDefault();
				(event.shiftKey ? last : first).focus();
			} else if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", handleKeyDown, true);
		return () => {
			document.removeEventListener("keydown", handleKeyDown, true);
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
		};
	}, []);

	const submit = async (): Promise<void> => {
		const target = path.trim();
		const displayName = name.trim();
		if (busyRef.current || !target || !displayName) return;
		if (!editing && !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(target)) {
			setError(t("newproject.invalidPath"));
			return;
		}
		busyRef.current = true;
		setCreating(true);
		setError("");
		try {
			if (editing) {
				setProjectAlias(target, displayName);
				onCreated(target, displayName);
				return;
			}
			const response = await client.request<ProjectCreateResult>({ type: "project.create", path: target });
			if (!response.ok || !response.result) {
				setError(response.error ?? t("newproject.createFailed"));
				return;
			}
			setProjectAlias(response.result.path, displayName);
			onCreated(response.result.path, displayName);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			busyRef.current = false;
			setCreating(false);
		}
	};

	const browse = async (): Promise<void> => {
		if (busyRef.current || editing) return;
		busyRef.current = true;
		setBrowsing(true);
		setError("");
		try {
			const selected = await pickFolder(t("newproject.pickFolderTitle"));
			if (selected) {
				setPath(selected);
				if (!name.trim()) setName(selected.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			busyRef.current = false;
			setBrowsing(false);
		}
	};

	return createPortal(
		<div className="owl-project-backdrop">
			<div
				className="owl-project-dialog"
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={`${id}-title`}
				aria-busy={busy}
				tabIndex={-1}
			>
				<header className="owl-project-dialog-heading">
					<h2 id={`${id}-title`}>{t(editing ? "newproject.editTitle" : "newproject.title")}</h2>
					<button
						type="button"
						className="owl-project-icon-button"
						aria-label={t("newproject.close")}
						onClick={onClose}
						disabled={busy}
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
							<path d="m6 6 12 12M18 6 6 18" />
						</svg>
					</button>
				</header>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<label className="owl-project-name-control">
						<span className="owl-project-name-icon">
							<IconFolder />
						</span>
						<input
							ref={nameRef}
							type="text"
							aria-label={t("newproject.name")}
							placeholder={t("newproject.name")}
							value={name}
							maxLength={120}
							disabled={busy}
							onChange={(event) => {
								setName(event.target.value);
								setError("");
							}}
						/>
					</label>
					<h3 className="owl-project-source-label" id={`${id}-source`}>
						{t("newproject.sourceFolder")}
					</h3>
					<div className="owl-project-source" role="group" aria-labelledby={`${id}-source`}>
						{path.trim() && (nativePicker || editing) ? (
							<div className="owl-project-selected-folder">
								<IconFolder className="owl-project-folder-icon" />
								<div className="owl-project-folder-detail">
									<strong>{path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path}</strong>
									<span title={path}>{path}</span>
								</div>
								{!editing && (
									<div className="owl-project-folder-actions">
										<button
											type="button"
											className="owl-project-text-button"
											onClick={() => void browse()}
											disabled={busy}
										>
											{t("newproject.changeFolder")}
										</button>
										<button
											type="button"
											className="owl-project-icon-button"
											aria-label={t("newproject.removeFolder")}
											disabled={busy}
											onClick={() => {
												setPath("");
												setError("");
											}}
										>
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
												<path d="m6 6 12 12M18 6 6 18" />
											</svg>
										</button>
									</div>
								)}
							</div>
						) : nativePicker ? (
							<div className="owl-project-add-folder">
								<p>{t("newproject.addOnComputer")}</p>
								<button
									type="button"
									className="owl-project-add-button"
									onClick={() => void browse()}
									disabled={busy}
								>
									<IconPlus />
									{t(browsing ? "newproject.browsing" : "newproject.addFolder")}
								</button>
							</div>
						) : (
							<label className="owl-project-browser-folder">
								<span>{t("newproject.browserPath")}</span>
								<input
									type="text"
									placeholder="D:\mycode\my-project"
									value={path}
									disabled={busy}
									spellCheck={false}
									onChange={(event) => {
										setPath(event.target.value);
										setError("");
									}}
									onBlur={() => {
										if (!name.trim()) setName(path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "");
									}}
								/>
							</label>
						)}
					</div>
					<p className="owl-project-source-hint">
						{t(editing ? "newproject.editSourceHint" : "newproject.sourceFolderHint")}
					</p>
					{error && (
						<p className="owl-project-error" role="alert">
							{error}
						</p>
					)}
					<footer className="owl-project-dialog-footer">
						<button type="button" className="owl-project-text-button" onClick={onClose} disabled={busy}>
							{t("common.cancel")}
						</button>
						<button
							type="submit"
							className="owl-project-primary-button"
							disabled={busy || !path.trim() || !name.trim()}
						>
							{t(creating ? "newproject.creating" : editing ? "common.save" : "newproject.create")}
						</button>
					</footer>
				</form>
			</div>
		</div>,
		document.body,
	);
}
