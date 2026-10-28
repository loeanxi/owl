import type { ResearchDiagnosis } from "../../bridge/protocol.ts";
import { useResearchText } from "./research-copy.ts";

const statusTextKeys = {
	upstream_refusal: "diagnosisUpstreamRefusal",
	textual_refusal_candidate: "diagnosisTextualRefusal",
	local_approval_denied: "diagnosisApprovalDenied",
	safety_guard_block: "diagnosisSafetyGuard",
	unsupported_capability: "diagnosisUnsupported",
	missing_dependency: "diagnosisMissingDependency",
	provider_error: "diagnosisProviderError",
	tool_error: "diagnosisToolError",
	cancelled: "diagnosisCancelled",
} as const;
const sourceTextKeys = { provider: "diagnosisProvider", tool: "diagnosisTool", agent: "diagnosisAgent" } as const;

/** A normal response is unverified until its work is checked; it needs no warning banner. */
export function ResearchDiagnosisNotice({
	diagnosis,
	running,
}: {
	diagnosis?: ResearchDiagnosis;
	running: boolean;
}): React.JSX.Element | null {
	const text = useResearchText();
	if (!diagnosis || running || diagnosis.status === "unverified") return null;
	return (
		<section className="research-diagnosis" role="status" aria-label={text("diagnosisTitle")}>
			<div className="research-diagnosis-heading">
				<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
					<circle cx="10" cy="10" r="7" />
					<path d="M10 5.5v5M10 13v1" />
				</svg>
				<strong>{text(statusTextKeys[diagnosis.status])}</strong>
			</div>
			<details>
				<summary>{text("diagnosisEvidence")}</summary>
				<div className="research-diagnosis-evidence">
					<p>{diagnosis.summary}</p>
					{diagnosis.evidence.map((evidence, index) => (
						<article key={index}>
							<span>
								{text(sourceTextKeys[evidence.source])}
								{evidence.toolName ? ` · ${evidence.toolName}` : ""}
							</span>
							<p>{evidence.text}</p>
						</article>
					))}
				</div>
			</details>
		</section>
	);
}
