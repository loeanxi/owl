import { useState } from "react";
import type { SessionQueueInput, SessionQueueSnapshot } from "../bridge/protocol.ts";
import type { usePromptQueue } from "../hooks/use-prompt-queue.ts";
import { usePromptQueueText } from "./prompt-queue-copy.ts";
import "./prompt-queue.css";

type QueueController = ReturnType<typeof usePromptQueue>;

function InputPreview({ input }: { input: SessionQueueInput }): React.JSX.Element {
	const text = usePromptQueueText();
	const paths = [...new Set(input.attachedPaths)];
	return <div className="owl-prompt-queue-preview">
		{input.text && <pre>{input.text}</pre>}
		{input.images.length > 0 && <div className="owl-prompt-queue-images">{input.images.map((image, index) => <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={text("attachment", { n: index + 1 })} />)}</div>}
		{paths.length > 0 && <ul className="owl-prompt-queue-files">{paths.map((path) => <li key={path}>{path}</li>)}</ul>}
	</div>;
}

export function PromptQueue({ queue, controller }: { queue?: SessionQueueSnapshot; controller: QueueController }): React.JSX.Element | null {
	const text = usePromptQueueText();
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [forget, setForget] = useState<{ owner: string; id: string }>();
	const items = [...(queue?.steering ?? []).map((item) => ({ ...item, lane: "steering" as const })), ...(queue?.followUp ?? []).map((item) => ({ ...item, lane: "followUp" as const }))];
	const ids = new Set([...items.map((item) => item.messageId), ...controller.receipts.map((receipt) => receipt.receiptId)]);
	const notices = Object.entries(controller.feedback).filter(([id, feedback]) => !ids.has(id) && (feedback.error || feedback.message));
	if (!items.length && !controller.receipts.length && !controller.listError && !notices.length) return null;
	const toggle = (id: string, load: () => void): void => {
		if (!expanded.has(id)) load();
		setExpanded((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
	};
	return <section className="owl-prompt-queue-panel" aria-label={text("title")}>
		{items.length > 0 && <h3>{text("title")}</h3>}
		{items.map((item) => {
			const feedback = controller.feedback[item.messageId];
			const unavailable = !controller.available || item.state === "delivering";
			return <article className="owl-prompt-queue-entry" data-queue-message-id={item.messageId} key={item.messageId}>
				<div className="owl-prompt-queue-meta"><span>{text(item.lane === "steering" ? "current" : "next")}</span>{item.imageCount > 0 && <span>{text("images", { n: item.imageCount })}</span>}{item.attachedPaths.length > 0 && <span>{text("files", { n: item.attachedPaths.length })}</span>}</div>
				<p>{item.text || text("emptyText")}{item.textTruncated ? "…" : ""}</p>
				{item.state === "delivering" && <p className="owl-prompt-queue-note">{text("delivering")}</p>}
				<div className="owl-prompt-queue-entry-actions">
					<button type="button" disabled={!controller.available || feedback?.pending} aria-expanded={expanded.has(item.messageId)} onClick={() => toggle(item.messageId, () => controller.sessionRequest(item.messageId, "preview", item.lane))}>{text(expanded.has(item.messageId) ? "collapse" : "preview")}</button>
					<button type="button" disabled={unavailable || feedback?.pending || !controller.canTake} onClick={() => controller.sessionRequest(item.messageId, "take", item.lane)}>{text("take")}</button>
					{item.lane === "followUp" && <button type="button" disabled={unavailable || feedback?.pending} onClick={() => controller.sessionRequest(item.messageId, "promote")}>{text("promote")}</button>}
					<button type="button" disabled={unavailable || feedback?.pending} onClick={() => controller.sessionRequest(item.messageId, "remove", item.lane)}>{text("remove")}</button>
				</div>
				{feedback?.pending && <p className="owl-prompt-queue-note" role="status">{text("pending")}</p>}
				{feedback?.error && <div className="owl-prompt-queue-error" role="alert">{feedback.error} <button type="button" onClick={() => controller.retry(item.messageId)}>{text("retry")}</button></div>}
				{expanded.has(item.messageId) && controller.previews[item.messageId] && <InputPreview input={controller.previews[item.messageId]} />}
			</article>;
		})}
		{controller.receipts.length > 0 && <><h3>{text("returned")}</h3><p className="owl-prompt-queue-note">{text("retained")}</p></>}
		{controller.receipts.map((receipt) => {
			const feedback = controller.feedback[receipt.receiptId];
			const previewKey = `receipt:${receipt.receiptId}`;
			return <article className="owl-prompt-queue-entry" data-queue-receipt-id={receipt.receiptId} key={receipt.receiptId}>
				<div className="owl-prompt-queue-meta"><span>{text("source", { id: receipt.sourceSessionId.slice(0, 8) })}</span>{receipt.imageCount > 0 && <span>{text("images", { n: receipt.imageCount })}</span>}{receipt.attachedPaths.length > 0 && <span>{text("files", { n: receipt.attachedPaths.length })}</span>}</div>
				<p>{receipt.text || text("emptyText")}{receipt.textTruncated ? "…" : ""}</p>
				<p className="owl-prompt-queue-note">{text("sourceProject")}: {receipt.sourceCwd}</p>
				<div className="owl-prompt-queue-entry-actions">
					<button type="button" disabled={!controller.returnedAvailable || feedback?.pending} aria-expanded={expanded.has(previewKey)} onClick={() => toggle(previewKey, () => controller.receiptRequest(receipt.receiptId, "receipt-preview"))}>{text(expanded.has(previewKey) ? "collapse" : "preview")}</button>
					<button type="button" disabled={!controller.returnedAvailable || feedback?.pending} onClick={() => controller.receiptRequest(receipt.receiptId, "append")}>{text(controller.appended.has(receipt.receiptId) ? "again" : "append")}</button>
					<button type="button" disabled={!controller.returnedAvailable || feedback?.pending} onClick={() => setForget({ owner: controller.ownerKey, id: receipt.receiptId })}>{text("forget")}</button>
				</div>
				{forget?.owner === controller.ownerKey && forget.id === receipt.receiptId && <div className="owl-prompt-queue-entry-actions"><button type="button" disabled={feedback?.pending} onClick={() => { setForget(undefined); controller.receiptRequest(receipt.receiptId, "forget"); }}>{text("confirmForget")}</button><button type="button" onClick={() => setForget(undefined)}>{text("keep")}</button></div>}
				{feedback?.pending && <p role="status" className="owl-prompt-queue-note">{text("loading")}</p>}
				{feedback?.error && <div role="alert" className="owl-prompt-queue-error">{feedback.error} <button type="button" onClick={() => controller.retry(receipt.receiptId)}>{text("retry")}</button></div>}
				{controller.appended.has(receipt.receiptId) && <p className="owl-prompt-queue-note" role="status">{text("appended")}</p>}
				{expanded.has(previewKey) && controller.receiptPreviews[receipt.receiptId] && <InputPreview input={controller.receiptPreviews[receipt.receiptId].input} />}
			</article>;
		})}
		{controller.listError && <div role="alert" className="owl-prompt-queue-error">{text("returnedFailed")}: {controller.listError} <button type="button" onClick={controller.refreshReturned}>{text("retry")}</button></div>}
		{notices.map(([id, feedback]) => <div key={id} role={feedback.error ? "alert" : "status"} className={feedback.error ? "owl-prompt-queue-error" : "owl-prompt-queue-note"}>{feedback.error ?? feedback.message}{feedback.error && <button type="button" onClick={() => controller.retry(id)}>{text("retry")}</button>}</div>)}
	</section>;
}
