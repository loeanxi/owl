import { usePendingResponses } from "../bridge/pending-responses.ts";
import { usePendingRequestCopy } from "./pending-request-copy.ts";
import "./pending-request.css";

export function PendingResponseNotice({ requestId }: { requestId: string }): React.JSX.Element | null {
	const { controller, feedback } = usePendingResponses();
	const state = feedback.get(requestId);
	const copy = usePendingRequestCopy();
	if (!state) return null;
	return <div className="owl-pending-feedback" role={state.phase === "error" ? "alert" : "status"}>
		<p>{state.phase === "pending" ? copy.waiting : copy.failed}</p>
		{state.error && <p>{state.error}</p>}
		{state.phase === "error" && <button type="button" onClick={() => controller?.retry(requestId)}>{copy.retry}</button>}
	</div>;
}
