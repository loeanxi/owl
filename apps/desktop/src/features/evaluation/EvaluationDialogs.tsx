import { useEffect, useRef, useState } from "react";
import type { EvaluationTask } from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";
import type { EvaluationText } from "./evaluation-copy.ts";

export function EvaluationDialog({ title, children, footer, onClose, preview = false }: {
	title: string;
	children: React.ReactNode;
	footer?: React.ReactNode;
	onClose: () => void;
	preview?: boolean;
}): React.JSX.Element {
	const panel = useRef<HTMLDivElement>(null);
	const closeHandler = useRef(onClose);
	closeHandler.current = onClose;
	useEffect(() => {
		const previous = document.activeElement;
		panel.current?.focus();
		const keydown = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); closeHandler.current(); }
			if (event.key !== "Tab") return;
			const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]') ?? [])];
			if (focusable.length === 0) { event.preventDefault(); return; }
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
			else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
		};
		document.addEventListener("keydown", keydown);
		return () => { document.removeEventListener("keydown", keydown); if (previous instanceof HTMLElement) previous.focus(); };
	}, []);
	return <div className="eval-modal"><div ref={panel} tabIndex={-1} className={`eval-modal-panel${preview ? " is-preview" : ""}`} role="dialog" aria-modal="true" aria-label={title}><div className="eval-modal-head"><h2>{title}</h2><span className="eval-spacer" /><button className="eval-button" onClick={onClose} aria-label="Close">×</button></div><div className="eval-modal-body">{children}</div>{footer && <div className="eval-modal-foot">{footer}</div>}</div></div>;
}

export function EvaluationTaskDetails({ task, t, onClose, onCopy, onEdit, onAdd, onSource }: {
	task: EvaluationTask;
	t: EvaluationText;
	onClose: () => void;
	onCopy: () => void;
	onEdit: () => void;
	onAdd: () => void;
	onSource: (url: string) => void;
}): React.JSX.Element {
	return <EvaluationDialog title={task.title} onClose={onClose} footer={<><button className="eval-button" onClick={onCopy}>{t("copy")}</button>{!task.builtin && <button className="eval-button" onClick={onEdit}>{t("edit")}</button>}<button className="eval-button primary" onClick={onAdd}>{t("addTask")}</button></>}>
		<div className="eval-task-meta"><span className="eval-pill">{task.id}</span><span className="eval-pill">{t(task.category)}</span><span className="eval-pill">v{task.version}</span><span className="eval-muted">{t("output")}: {task.outputType}</span></div>
		{task.source && <p className="eval-muted">{t("origin")}: {task.source.url ? <button className="eval-link" onClick={() => onSource(task.source?.url ?? "")}>{task.source.label}</button> : task.source.label}</p>}
		<h3>{t("prompt")}</h3><div className="eval-prompt">{task.prompt}</div>{task.input && <><h3>{t("input")}</h3><div className="eval-prompt">{task.input}</div></>}
		<h3>{t("rubric")}</h3>{task.rubric.map((item) => <p key={item.id} className="eval-muted" style={{ marginBottom: 8 }}><strong>{item.label}</strong> · {item.description}</p>)}
		<h3>{t("automatic")}</h3>{task.checks.map((check) => <p className="eval-muted" key={check.id}>{check.label}</p>)}
	</EvaluationDialog>;
}

export function EvaluationTaskEditor({ task, copy, t, busy, externalError, onClose, onSave }: {
	task?: EvaluationTask;
	copy?: boolean;
	t: EvaluationText;
	busy: boolean;
	externalError?: string;
	onClose: () => void;
	onSave: (task: EvaluationTask) => void;
}): React.JSX.Element {
	const [title, setTitle] = useState(task ? `${task.title}${copy ? ` · ${t("custom")}` : ""}` : "");
	const [category, setCategory] = useState(task?.category ?? "svg");
	const [outputType, setOutputType] = useState(task?.outputType ?? "svg");
	const [prompt, setPrompt] = useState(task?.prompt ?? "");
	const [input, setInput] = useState(task?.input ?? "");
	const [rubric, setRubric] = useState(task?.rubric ?? [1, 2, 3].map((number) => ({ id: `r${number}`, label: "", description: "" })));
	const [error, setError] = useState("");
	const save = () => {
		if (!title.trim() || !prompt.trim() || rubric.length !== 3 || rubric.some((item) => !item.label.trim())) { setError(t("taskValidation")); return; }
		onSave({ id: task && !copy ? task.id : `U-${crypto.randomUUID()}`, version: task && !copy ? task.version : 1, title: title.trim(), category, prompt: prompt.trim(), input: input.trim() || undefined, outputType, builtin: false, source: task?.source, rubric: rubric.map((item) => ({ ...item, label: item.label.trim(), description: item.description.trim() })), checks: [{ id: "format", label: t("automatic"), kind: "format" }] });
	};
	return <EvaluationDialog title={task && !copy ? t("editTitle") : t("customTitle")} onClose={onClose} footer={<><button className="eval-button" disabled={busy} onClick={onClose}>{t("cancelEdit")}</button><button className="eval-button primary" disabled={busy} onClick={save}>{busy ? t("busy") : t("save")}</button></>}>
		<p className="eval-muted" style={{ marginBottom: 15 }}>{t("customHint")}</p>{(error || externalError) && <p role="alert" style={{ color: "#d88181", marginBottom: 10 }}>{error || externalError}</p>}
		<label>{t("taskTitle")}<input autoFocus className="eval-field" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} /></label>
		<div className="eval-toolbar"><label style={{ flex: 1 }}>{t("category")}<select className="eval-field" value={category} onChange={(event) => { const value = event.target.value as typeof category; setCategory(value); setOutputType(value); }}>{(["svg", "html", "code"] as const).map((value) => <option key={value} value={value}>{t(value)}</option>)}</select></label><label style={{ flex: 1 }}>{t("output")}<select className="eval-field" value={outputType} onChange={(event) => setOutputType(event.target.value as typeof outputType)}>{(["svg", "html", "code", "json"] as const).map((value) => <option key={value} value={value}>{value === "json" ? "JSON" : t(value)}</option>)}</select></label></div>
		<label>{t("prompt")}<textarea className="eval-field" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label><label>{t("input")}<textarea className="eval-field" value={input} onChange={(event) => setInput(event.target.value)} /></label>
		<h3>{t("rubric")}</h3>{rubric.map((item, index) => <div key={item.id} style={{ marginBottom: 12 }}><label>{t("rubricLabel", { n: index + 1 })}<input className="eval-field" value={item.label} onChange={(event) => setRubric((previous) => previous.map((current, number) => number === index ? { ...current, label: event.target.value } : current))} /></label><label>{t("rubricDescription")}<textarea className="eval-field eval-rubric-description" value={item.description} onChange={(event) => setRubric((previous) => previous.map((current, number) => number === index ? { ...current, description: event.target.value } : current))} /></label></div>)}
	</EvaluationDialog>;
}
